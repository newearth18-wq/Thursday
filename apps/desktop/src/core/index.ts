import {
  CORE_PROTOCOL_VERSION,
  HostToCore,
  type CoreConfig,
  type CoreToHost,
  type ErrorEnvelope,
  type LogEntry
} from '@jupiter/contracts'
import {
  CoreKernel,
  JupiterError,
  Logger,
  createErrorEnvelope,
  describeError,
  uuidv7,
  type HostPort,
  type LogSink
} from '@jupiter/core'
import { JupiterDatabase } from '@jupiter/database'
import { installedAdapters } from './adapters'

/**
 * Jupiter Core process entry (Electron utility process).
 *
 * Talks to the host only through `process.parentPort`, and only with the
 * versioned, schema-validated protocol. It never touches windows, the
 * renderer or Electron APIs: it hosts the Core kernel and nothing else.
 * An uncaught error ends the process on purpose — the host reports the
 * crash and starts a fresh Core rather than letting a damaged one continue.
 */

const port = process.parentPort
const base = { protocol: CORE_PROTOCOL_VERSION } as const

function send(message: CoreToHost): void {
  port.postMessage(message)
}

/** Log entries are forwarded to the host, which owns the log files. */
const portSink: LogSink = {
  write(entry: LogEntry) {
    send({ ...base, kind: 'log', entry })
  }
}

let logger: Logger | null = null
let kernel: CoreKernel | null = null
let stopping = false
const hostCalls = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>()

const host: HostPort = {
  call(capability, input, context, signal) {
    const callId = uuidv7()
    return new Promise<unknown>((resolve, reject) => {
      hostCalls.set(callId, { resolve, reject })
      signal.addEventListener(
        'abort',
        () => {
          hostCalls.delete(callId)
          reject(
            new JupiterError('CANCELLED', `${capability} was cancelled.`, {
              category: 'cancellation',
              userAction: null
            })
          )
        },
        { once: true }
      )
      send({
        ...base,
        kind: 'host-call',
        callId,
        capability,
        input,
        requestId: context.requestId,
        correlationId: context.correlationId,
        actor: context.actor
      })
    })
  }
}

function toJupiterError(error: ErrorEnvelope): JupiterError {
  return new JupiterError(error.code, error.message, {
    category: error.category,
    userAction: error.userAction,
    retryable: error.retryable
  })
}

async function initialise(config: CoreConfig): Promise<void> {
  logger = Logger.create({
    sessionId: config.sessionId,
    level: config.defaultLogLevel,
    sinks: [portSink],
    component: 'core'
  })
  const log = logger
  const created = new CoreKernel({
    config,
    logger: log,
    host,
    process: {
      pid: process.pid,
      versions: {
        node: process.versions.node,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        v8: process.versions.v8
      }
    },
    openDatabase: () =>
      JupiterDatabase.open({
        path: config.databasePath,
        backupDirectory: config.backupDirectory,
        logger: log.child({ component: 'database' })
      }),
    onStatus: (services) => {
      send({ ...base, kind: 'status', services })
    },
    onLogLevel: (level) => {
      send({ ...base, kind: 'log-level', level })
    },
    adapters: installedAdapters()
  })
  kernel = created
  await created.start()
  send({
    ...base,
    kind: 'ready',
    pid: process.pid,
    services: created.services().filter((service) => service.plannedSet === null),
    latestSequence: created.bus.latestSequence(),
    logLevel: created.effectiveLogLevel
  })
}

async function handle(raw: unknown): Promise<void> {
  const parsed = HostToCore.safeParse(raw)
  if (!parsed.success) {
    logger?.warn(
      'protocol.message.invalid',
      'Dropped a message from the host that does not match the protocol'
    )
    return
  }
  const message = parsed.data
  if (message.kind === 'init') {
    if (kernel) return
    await initialise(message.config)
    return
  }
  const core = kernel
  if (!core) {
    logger?.warn(
      'protocol.message.early',
      `Dropped "${message.kind}" received before initialisation`
    )
    return
  }
  switch (message.kind) {
    case 'dispatch': {
      const result = await core.dispatch(message.request, message.actor, (progress) => {
        send({ ...base, kind: 'progress', progress })
      })
      send({ ...base, kind: 'result', result })
      return
    }
    case 'cancel':
      core.cancel(message.requestId, message.actor)
      return
    case 'subscribe': {
      const subscriptionId = message.request.subscriptionId
      try {
        const receipt = core.subscribe(
          message.request,
          (event) => {
            send({ ...base, kind: 'event', subscriptionId, event })
          },
          () => {
            send({ ...base, kind: 'subscription-ended', subscriptionId, reason: 'closed-by-core' })
          }
        )
        send({ ...base, kind: 'subscribed', receipt })
      } catch (error) {
        send({
          ...base,
          kind: 'subscribe-failed',
          subscriptionId,
          error: createErrorEnvelope({
            code: error instanceof JupiterError ? error.code : 'SUBSCRIBE_FAILED',
            category: error instanceof JupiterError ? error.category : 'internal',
            message: describeError(error),
            userAction: 'Reload the interface.',
            retryable: true
          })
        })
      }
      return
    }
    case 'unsubscribe':
      core.unsubscribe(message.subscriptionId)
      return
    case 'retry-service': {
      const error = await core.retryService(message.serviceId)
      send({ ...base, kind: 'retry-reply', callId: message.callId, error })
      return
    }
    case 'host-reply':
    case 'host-reply-error': {
      const pending = hostCalls.get(message.callId)
      if (!pending) return
      hostCalls.delete(message.callId)
      if (message.kind === 'host-reply') pending.resolve(message.data)
      else pending.reject(toJupiterError(message.error))
      return
    }
    case 'audit':
      core.recordAudit(message.entry)
      return
    case 'ping':
      send({ ...base, kind: 'pong', nonce: message.nonce })
      return
    case 'shutdown':
      if (stopping) return
      stopping = true
      await core.stop()
      send({ ...base, kind: 'stopped' })
      process.exit(0)
  }
}

port.on('message', (event) => {
  handle(event.data).catch((error: unknown) => {
    logger?.error(
      'core.handler.failed',
      `Handling a host message failed: ${describeError(error)}`,
      { error }
    )
  })
})

process.on('uncaughtException', (error) => {
  logger?.fatal(
    'core.uncaught-exception',
    `Uncaught exception in Jupiter Core: ${describeError(error)}`,
    { error }
  )
  process.exit(70)
})

process.on('unhandledRejection', (reason) => {
  logger?.error(
    'core.unhandled-rejection',
    `Unhandled rejection in Jupiter Core: ${describeError(reason)}`,
    { reason }
  )
})
