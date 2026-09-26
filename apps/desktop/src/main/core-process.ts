import {
  CORE_PROTOCOL_VERSION,
  CoreToHost,
  type Actor,
  type AuditEvent,
  type CoreConfig,
  type CoreProcessInfo,
  type CoreProcessState,
  type ErrorEnvelope,
  type HostToCore,
  type LogEntry,
  type LogLevel,
  type ProgressUpdate,
  type RequestEnvelope,
  type ResultEnvelope,
  type ServiceHealth,
  type SubscribeReceipt,
  type SubscribeRequest,
  type DomainEvent
} from '@jupiter/contracts'
import { JupiterError, createErrorEnvelope, uuidv7, type Logger } from '@jupiter/core'

/**
 * Supervises the Jupiter Core utility process from the host.
 *
 * - start: spawn, send `init`, wait for `ready` (with a deadline);
 * - every message from Core is schema-validated; anything else is dropped;
 * - requests are correlated by requestId, service retries by callId,
 *   subscriptions by subscriptionId, each with a safety timeout;
 * - a heartbeat detects a Core that stopped responding;
 * - an unexpected exit fails every pending request truthfully, and is
 *   reported to the host (which restarts Core under its own policy);
 * - stop: graceful `shutdown`, then a hard kill if Core does not exit.
 *
 * This file does not import Electron: the process itself comes from a
 * launcher, so the supervision logic is unit-tested with a fake process.
 */

export interface CoreChild {
  readonly pid: number | undefined
  postMessage(message: HostToCore): void
  kill(): void
  onMessage(listener: (raw: unknown) => void): void
  onExit(listener: (exitCode: number | null) => void): void
  onOutput(listener: (stream: 'stdout' | 'stderr', text: string) => void): void
}

export interface CoreLauncher {
  launch(): CoreChild
}

export interface CoreProcessHandlers {
  onLog(entry: LogEntry): void
  onLogLevel(level: LogLevel): void
  onServices(services: ServiceHealth[]): void
  onProgress(progress: ProgressUpdate): void
  onEvent(subscriptionId: string, event: DomainEvent): void
  onSubscriptionEnded(subscriptionId: string): void
  onHostCall(call: Extract<CoreToHost, { kind: 'host-call' }>): void
  onStateChange(info: CoreProcessInfo): void
  onUnexpectedExit(exit: { exitCode: number | null; reason: string; at: string }): void
}

export interface CoreProcessOptions {
  readonly launcher: CoreLauncher
  readonly logger: Logger
  readonly handlers: CoreProcessHandlers
  readonly config: (restarts: number, previousExit: CoreConfig['previousExit']) => CoreConfig
  readonly readyTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly now?: () => Date
}

interface Waiter<T> {
  resolve(value: T): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}

const base = { protocol: CORE_PROTOCOL_VERSION } as const

export class CoreProcessManager {
  private child: CoreChild | null = null
  private state: CoreProcessState = 'stopped'
  private restarts = 0
  private lastExit: CoreProcessInfo['lastExit'] = null
  private previousUnexpectedExit: CoreConfig['previousExit'] = null
  private readonly requests = new Map<
    string,
    Waiter<ResultEnvelope> & { request: RequestEnvelope }
  >()
  private readonly calls = new Map<string, Waiter<ErrorEnvelope | null>>()
  private readonly subscriptions = new Map<string, Waiter<SubscribeReceipt>>()
  private ready: Waiter<ServiceHealth[]> | null = null
  private stopped: Waiter<void> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private pendingPong: { nonce: string; timer: ReturnType<typeof setTimeout> } | null = null
  private exitReasonOverride: string | null = null
  private readonly log: Logger
  private readonly now: () => Date

  constructor(private readonly options: CoreProcessOptions) {
    this.log = options.logger.child({ component: 'core-process' })
    this.now = options.now ?? (() => new Date())
  }

  info(): CoreProcessInfo {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      lastExit: this.lastExit
    }
  }

  get running(): boolean {
    return this.state === 'running'
  }

  /** Spawn Core and wait for it to report ready. Resolves with Core's service statuses. */
  start(options: { automaticRestart?: boolean } = {}): Promise<ServiceHealth[]> {
    if (this.state === 'running' || this.state === 'starting') {
      return Promise.reject(
        new JupiterError('CORE_ALREADY_RUNNING', 'Jupiter Core is already running.', {
          category: 'internal',
          userAction: null
        })
      )
    }
    if (options.automaticRestart) this.restarts++
    this.exitReasonOverride = null
    this.setState('starting')
    let child: CoreChild
    try {
      child = this.options.launcher.launch()
    } catch (error) {
      this.setState('crashed')
      return Promise.reject(
        new JupiterError(
          'CORE_START_FAILED',
          `Jupiter Core could not be started: ${error instanceof Error ? error.message : String(error)}`,
          {
            category: 'internal',
            userAction: 'Press Retry. If it fails again, reinstall Jupiter.',
            retryable: true,
            cause: error
          }
        )
      )
    }
    this.child = child
    child.onMessage((raw) => {
      this.receive(child, raw)
    })
    child.onExit((exitCode) => {
      this.handleExit(child, exitCode)
    })
    child.onOutput((stream, text) => {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        if (/ExperimentalWarning: SQLite|--trace-warnings/.test(line))
          this.log.debug('core.output', line.slice(0, 1000), { stream })
        else this.log.warn('core.output', line.slice(0, 1000), { stream })
      }
    })

    const config = this.options.config(this.restarts, this.previousUnexpectedExit)
    return new Promise<ServiceHealth[]>((resolve, reject) => {
      this.ready = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.exitReasonOverride = 'it did not report ready in time'
          reject(
            new JupiterError(
              'CORE_START_TIMEOUT',
              `Jupiter Core did not become ready within ${String(this.options.readyTimeoutMs ?? 30_000)} ms.`,
              {
                category: 'timeout',
                userAction: 'Press Retry. If it keeps timing out, restart Jupiter.',
                retryable: true
              }
            )
          )
          this.ready = null
          child.kill()
        }, this.options.readyTimeoutMs ?? 30_000)
      }
      this.send({ ...base, kind: 'init', config })
    })
  }

  /** Graceful stop: ask Core to shut down, then kill it if it does not exit in time. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child || this.state === 'stopped' || this.state === 'crashed') {
      this.setState(this.state === 'crashed' ? 'crashed' : 'stopped')
      return
    }
    this.setState('stopping')
    this.stopHeartbeat()
    const exited = new Promise<void>((resolve) => {
      this.stopped = {
        resolve,
        reject: resolve,
        timer: setTimeout(() => {
          this.log.warn('core.stop.forced', 'Jupiter Core did not stop in time; ending it')
          child.kill()
        }, this.options.stopTimeoutMs ?? 8_000)
      }
    })
    try {
      this.send({ ...base, kind: 'shutdown' })
    } catch {
      child.kill()
    }
    await exited
  }

  dispatch(request: RequestEnvelope, actor: Actor): Promise<ResultEnvelope> {
    if (!this.running) return Promise.resolve(this.unavailable(request))
    return new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.requests.delete(request.requestId)
          resolve(
            this.failure(
              request,
              'CORE_NO_REPLY',
              'timeout',
              'Jupiter Core did not answer the request in time.',
              'Try again. If it keeps happening, restart Jupiter.'
            )
          )
        },
        this.options.requestTimeoutMs ?? 6 * 60_000
      )
      this.requests.set(request.requestId, { resolve, reject, timer, request })
      this.send({ ...base, kind: 'dispatch', request, actor })
    })
  }

  cancel(requestId: string, actor: Actor): void {
    if (this.running) this.send({ ...base, kind: 'cancel', requestId, actor })
  }

  subscribe(request: SubscribeRequest): Promise<SubscribeReceipt> {
    if (!this.running) return Promise.reject(this.unavailableError())
    return new Promise<SubscribeReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.subscriptions.delete(request.subscriptionId)
        reject(
          new JupiterError(
            'CORE_NO_REPLY',
            'Jupiter Core did not confirm the subscription in time.',
            { category: 'timeout', userAction: 'Reload the interface.', retryable: true }
          )
        )
      }, 30_000)
      this.subscriptions.set(request.subscriptionId, { resolve, reject, timer })
      this.send({ ...base, kind: 'subscribe', request })
    })
  }

  unsubscribe(subscriptionId: string): void {
    if (this.running) this.send({ ...base, kind: 'unsubscribe', subscriptionId })
  }

  retryService(serviceId: string): Promise<ErrorEnvelope | null> {
    if (!this.running) return Promise.reject(this.unavailableError())
    const callId = uuidv7()
    return new Promise<ErrorEnvelope | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(callId)
        reject(
          new JupiterError('CORE_NO_REPLY', 'Jupiter Core did not finish the retry in time.', {
            category: 'timeout',
            userAction: 'Try again.',
            retryable: true
          })
        )
      }, 150_000)
      this.calls.set(callId, { resolve, reject, timer })
      this.send({ ...base, kind: 'retry-service', callId, serviceId })
    })
  }

  sendAudit(entry: AuditEvent): boolean {
    if (!this.running) return false
    this.send({ ...base, kind: 'audit', entry })
    return true
  }

  replyToHostCall(
    callId: string,
    outcome: { ok: true; data: unknown } | { ok: false; error: ErrorEnvelope }
  ): void {
    if (!this.running) return
    if (outcome.ok) this.send({ ...base, kind: 'host-reply', callId, ok: true, data: outcome.data })
    else this.send({ ...base, kind: 'host-reply-error', callId, error: outcome.error })
  }

  private send(message: HostToCore): void {
    const child = this.child
    if (!child) throw new Error('Jupiter Core is not running')
    child.postMessage(message)
  }

  private receive(child: CoreChild, raw: unknown): void {
    if (child !== this.child) return
    const parsed = CoreToHost.safeParse(raw)
    if (!parsed.success) {
      this.log.warn(
        'core.message.invalid',
        'Dropped a message from Jupiter Core that does not match the protocol',
        {
          issues: parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        }
      )
      return
    }
    const message = parsed.data
    switch (message.kind) {
      case 'ready': {
        const waiter = this.ready
        this.ready = null
        if (!waiter) return
        clearTimeout(waiter.timer)
        this.previousUnexpectedExit = null
        this.setState('running')
        this.startHeartbeat()
        this.options.handlers.onLogLevel(message.logLevel)
        this.options.handlers.onServices(message.services)
        this.log.info('core.ready', `Jupiter Core is ready (pid ${String(message.pid)})`, {
          pid: message.pid,
          latestSequence: message.latestSequence
        })
        waiter.resolve(message.services)
        return
      }
      case 'result': {
        const waiter = this.requests.get(message.result.requestId)
        if (!waiter) return
        this.requests.delete(message.result.requestId)
        clearTimeout(waiter.timer)
        waiter.resolve(message.result)
        return
      }
      case 'subscribed':
      case 'subscribe-failed': {
        const id =
          message.kind === 'subscribed' ? message.receipt.subscriptionId : message.subscriptionId
        const waiter = this.subscriptions.get(id)
        if (!waiter) return
        this.subscriptions.delete(id)
        clearTimeout(waiter.timer)
        if (message.kind === 'subscribed') waiter.resolve(message.receipt)
        else
          waiter.reject(
            new JupiterError(message.error.code, message.error.message, {
              category: message.error.category,
              userAction: message.error.userAction,
              retryable: message.error.retryable
            })
          )
        return
      }
      case 'retry-reply': {
        const waiter = this.calls.get(message.callId)
        if (!waiter) return
        this.calls.delete(message.callId)
        clearTimeout(waiter.timer)
        waiter.resolve(message.error)
        return
      }
      case 'progress':
        this.options.handlers.onProgress(message.progress)
        return
      case 'event':
        this.options.handlers.onEvent(message.subscriptionId, message.event)
        return
      case 'subscription-ended':
        this.options.handlers.onSubscriptionEnded(message.subscriptionId)
        return
      case 'status':
        this.options.handlers.onServices(message.services)
        return
      case 'log':
        this.options.handlers.onLog(message.entry)
        return
      case 'log-level':
        this.options.handlers.onLogLevel(message.level)
        return
      case 'host-call':
        this.options.handlers.onHostCall(message)
        return
      case 'pong':
        if (this.pendingPong?.nonce === message.nonce) {
          clearTimeout(this.pendingPong.timer)
          this.pendingPong = null
        }
        return
      case 'stopped':
        this.log.info('core.stopped', 'Jupiter Core stopped cleanly')
        return
    }
  }

  private handleExit(child: CoreChild, exitCode: number | null): void {
    if (child !== this.child) return
    this.child = null
    this.stopHeartbeat()
    const at = this.now().toISOString()
    const expected = this.state === 'stopping'
    const wasRunning = this.state === 'running'
    const reason =
      this.exitReasonOverride ??
      (expected
        ? 'it was shut down'
        : `the process exited unexpectedly (exit code ${exitCode === null ? 'unknown' : String(exitCode)})`)
    this.lastExit = { exitCode, reason, at, expected }

    const stopWaiter = this.stopped
    this.stopped = null
    if (stopWaiter) {
      clearTimeout(stopWaiter.timer)
      stopWaiter.resolve()
    }

    const readyWaiter = this.ready
    this.ready = null
    if (readyWaiter) {
      clearTimeout(readyWaiter.timer)
      readyWaiter.reject(
        new JupiterError('CORE_START_FAILED', `Jupiter Core stopped while starting: ${reason}.`, {
          category: 'internal',
          userAction:
            'Press Retry. If it fails again, restart Jupiter and include the log files in a bug report.',
          retryable: true
        })
      )
    }

    for (const [id, waiter] of this.requests) {
      clearTimeout(waiter.timer)
      waiter.resolve(
        this.failure(
          waiter.request,
          'CORE_UNAVAILABLE',
          'dependency',
          `Jupiter Core stopped before answering: ${reason}.`,
          'Try again once Jupiter Core is running again.'
        )
      )
      this.requests.delete(id)
    }
    for (const [id, waiter] of this.calls) {
      clearTimeout(waiter.timer)
      waiter.reject(this.unavailableError())
      this.calls.delete(id)
    }
    for (const [id, waiter] of this.subscriptions) {
      clearTimeout(waiter.timer)
      waiter.reject(this.unavailableError())
      this.subscriptions.delete(id)
    }

    if (expected) {
      this.setState('stopped')
      return
    }
    this.previousUnexpectedExit = { exitCode, reason, at }
    this.setState('crashed')
    this.log.error('core.exited', `Jupiter Core stopped unexpectedly: ${reason}`, { exitCode })
    // A failed start is reported by start() itself; only a crash of a running Core is reported here.
    if (wasRunning) this.options.handlers.onUnexpectedExit({ exitCode, reason, at })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (!this.running || this.pendingPong) return
      const nonce = uuidv7()
      this.pendingPong = {
        nonce,
        timer: setTimeout(() => {
          this.pendingPong = null
          this.exitReasonOverride = 'it stopped responding'
          this.log.error('core.unresponsive', 'Jupiter Core stopped responding; ending it')
          this.child?.kill()
        }, this.options.heartbeatTimeoutMs ?? 10_000)
      }
      this.send({ ...base, kind: 'ping', nonce })
    }, this.options.heartbeatIntervalMs ?? 15_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.pendingPong) clearTimeout(this.pendingPong.timer)
    this.pendingPong = null
  }

  private setState(state: CoreProcessState): void {
    this.state = state
    this.options.handlers.onStateChange(this.info())
  }

  private unavailableError(): JupiterError {
    return new JupiterError('CORE_UNAVAILABLE', 'Jupiter Core is not running.', {
      category: 'dependency',
      userAction: 'Open Diagnostics and press Retry on Jupiter Core.',
      retryable: true
    })
  }

  private unavailable(request: RequestEnvelope): ResultEnvelope {
    return this.failure(
      request,
      'CORE_UNAVAILABLE',
      'dependency',
      'Jupiter Core is not running, so the request was not sent.',
      'Open Diagnostics and press Retry on Jupiter Core.'
    )
  }

  private failure(
    request: RequestEnvelope,
    code: string,
    category: 'dependency' | 'timeout',
    message: string,
    userAction: string
  ): ResultEnvelope {
    return {
      v: 1,
      requestId: request.requestId,
      correlationId: request.requestId,
      ok: false,
      error: createErrorEnvelope({
        code,
        category,
        message,
        userAction,
        retryable: true,
        missionId: request.missionId,
        executionId: request.executionId
      }),
      completedAt: this.now().toISOString()
    }
  }
}
