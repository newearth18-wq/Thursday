import type { IpcMainInvokeEvent } from 'electron'
import {
  CONTRACT_VERSION,
  InvokeChannel,
  MAX_REQUEST_BYTES,
  PushChannel,
  RendererMessage,
  RequestEnvelope,
  gatewayContract,
  type Actor,
  type AuditEvent,
  type DomainEvent,
  type ErrorEnvelope,
  type GatewayReply,
  type GatewayStatus,
  type ProgressUpdate,
  type ResultEnvelope
} from '@jupiter/contracts'
import {
  JupiterError,
  createErrorEnvelope,
  toErrorEnvelope,
  uuidv7,
  type Logger
} from '@jupiter/core'
import type { CoreProcessManager } from './core-process'

/**
 * The host gateway: the renderer's only door into Jupiter.
 *
 * Exactly six invoke channels exist (see channels.ts); nothing else is
 * registered, so any other channel is unreachable. For every call the
 * gateway:
 *   - verifies the sender is the Jupiter window's top frame on the app origin;
 *   - validates the message against the versioned contract and its size;
 *   - assigns the actor itself (never taken from the message);
 *   - forwards commands and queries to the Core capability dispatcher, which
 *     authorizes and audits them;
 *   - keeps track of which window owns each request and subscription, so
 *     progress and events only ever reach their owner, and a window that
 *     reloads or closes leaves nothing behind.
 *
 * It answers only two things itself — its own status, and service retry —
 * because they must work when Jupiter Core is down.
 */

export interface IpcRegistrar {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  ): void
}

export interface RendererTarget {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, message: unknown): void
}

export interface GatewayOptions {
  readonly logger: Logger
  readonly core: CoreProcessManager
  readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  readonly status: () => GatewayStatus
  readonly retryService: (serviceId: string, correlationId: string) => Promise<GatewayStatus>
  readonly audit: (entry: AuditEvent) => void
  readonly target: (webContentsId: number) => RendererTarget | null
  readonly maxInFlightPerWindow?: number
}

export class HostGateway {
  private readonly requestOwners = new Map<string, number>()
  private readonly subscriptionOwners = new Map<string, number>()
  private readonly windows = new Set<number>()
  private readonly log: Logger

  constructor(private readonly options: GatewayOptions) {
    this.log = options.logger.child({ component: 'gateway' })
  }

  register(ipc: IpcRegistrar): void {
    ipc.handle(InvokeChannel.gatewayStatus, (event, raw) =>
      this.guarded(event, InvokeChannel.gatewayStatus, raw, () => this.options.status())
    )
    ipc.handle(InvokeChannel.retryService, (event, raw) =>
      this.guarded(
        event,
        InvokeChannel.retryService,
        raw,
        async (input: { serviceId: string }, correlationId) => {
          try {
            const status = await this.options.retryService(input.serviceId, correlationId)
            this.auditRetry(event, correlationId, input.serviceId, 'SUCCEEDED')
            return status
          } catch (error) {
            this.auditRetry(event, correlationId, input.serviceId, 'FAILED')
            throw error
          }
        }
      )
    )
    ipc.handle(InvokeChannel.request, (event, raw) => this.request(event, raw))
    ipc.handle(InvokeChannel.cancel, (event, raw) =>
      this.guarded(event, InvokeChannel.cancel, raw, (input: { requestId: string }) => {
        const owned = this.requestOwners.get(input.requestId) === event.sender.id
        if (owned) this.options.core.cancel(input.requestId, this.actorFor(event))
        return { requestId: input.requestId, cancelled: owned }
      })
    )
    ipc.handle(InvokeChannel.subscribe, (event, raw) =>
      this.guarded(
        event,
        InvokeChannel.subscribe,
        raw,
        async (input: Parameters<CoreProcessManager['subscribe']>[0]) => {
          if (this.subscriptionOwners.has(input.subscriptionId)) {
            throw new JupiterError(
              'SUBSCRIPTION_EXISTS',
              'That subscription id is already in use.',
              { category: 'validation', userAction: null }
            )
          }
          this.subscriptionOwners.set(input.subscriptionId, event.sender.id)
          try {
            return await this.options.core.subscribe(input)
          } catch (error) {
            this.subscriptionOwners.delete(input.subscriptionId)
            throw error
          }
        }
      )
    )
    ipc.handle(InvokeChannel.unsubscribe, (event, raw) =>
      this.guarded(event, InvokeChannel.unsubscribe, raw, (input: { subscriptionId: string }) => {
        const owned = this.subscriptionOwners.get(input.subscriptionId) === event.sender.id
        if (owned) {
          this.subscriptionOwners.delete(input.subscriptionId)
          this.options.core.unsubscribe(input.subscriptionId)
        }
        return { subscriptionId: input.subscriptionId, closed: owned }
      })
    )
  }

  /** The window navigated, reloaded, crashed or closed: drop everything it owned. */
  releaseWindow(webContentsId: number, reason: string): void {
    let requests = 0
    let subscriptions = 0
    for (const [requestId, owner] of this.requestOwners) {
      if (owner !== webContentsId) continue
      this.options.core.cancel(requestId, {
        type: 'user-interface',
        id: `window:${String(webContentsId)}`
      })
      this.requestOwners.delete(requestId)
      requests++
    }
    for (const [subscriptionId, owner] of this.subscriptionOwners) {
      if (owner !== webContentsId) continue
      this.options.core.unsubscribe(subscriptionId)
      this.subscriptionOwners.delete(subscriptionId)
      subscriptions++
    }
    this.windows.delete(webContentsId)
    if (requests + subscriptions > 0) {
      this.log.info(
        'gateway.window.released',
        `Released ${String(requests)} request(s) and ${String(subscriptions)} subscription(s)`,
        {
          webContentsId,
          reason
        }
      )
    }
  }

  get activeSubscriptions(): number {
    return this.subscriptionOwners.size
  }

  broadcastStatus(status: GatewayStatus): void {
    for (const id of this.windows)
      this.push(id, { v: CONTRACT_VERSION, kind: 'gateway-status', status })
  }

  routeProgress(progress: ProgressUpdate): void {
    const owner = this.requestOwners.get(progress.requestId)
    if (owner !== undefined) this.push(owner, { v: CONTRACT_VERSION, kind: 'progress', progress })
  }

  routeEvent(subscriptionId: string, event: DomainEvent): void {
    const owner = this.subscriptionOwners.get(subscriptionId)
    if (owner !== undefined)
      this.push(owner, { v: CONTRACT_VERSION, kind: 'event', subscriptionId, event })
  }

  /** Core stopped: its subscriptions are gone; tell each owner so it can resubscribe from its cursor. */
  endAllSubscriptions(reason: 'core-stopped' | 'closed-by-core', only?: string): void {
    for (const [subscriptionId, owner] of this.subscriptionOwners) {
      if (only !== undefined && subscriptionId !== only) continue
      this.subscriptionOwners.delete(subscriptionId)
      this.push(owner, { v: CONTRACT_VERSION, kind: 'subscription-ended', subscriptionId, reason })
    }
  }

  private async request(event: IpcMainInvokeEvent, raw: unknown): Promise<ResultEnvelope> {
    const receivedAt = new Date().toISOString()
    const requestId = extractRequestId(raw) ?? uuidv7()
    const fail = (
      code: string,
      category: ErrorEnvelope['category'],
      message: string,
      decision: 'DENIED' | 'REJECTED'
    ): ResultEnvelope => {
      this.auditRejection(event, requestId, code, decision, raw)
      return {
        v: CONTRACT_VERSION,
        requestId,
        correlationId: requestId,
        ok: false,
        error: createErrorEnvelope({ code, category, message, userAction: null, retryable: false }),
        completedAt: receivedAt
      }
    }

    if (!this.options.isTrustedSender(event)) {
      return fail(
        'IPC_UNTRUSTED_SENDER',
        'permission',
        'The request did not come from the Jupiter interface.',
        'DENIED'
      )
    }
    this.windows.add(event.sender.id)
    const size = serializedSize(raw)
    if (size === null || size > MAX_REQUEST_BYTES) {
      return fail(
        'IPC_REQUEST_TOO_LARGE',
        'validation',
        `Requests are limited to ${String(MAX_REQUEST_BYTES)} bytes of plain data.`,
        'REJECTED'
      )
    }
    const parsed = RequestEnvelope.safeParse(raw)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      return fail(
        'IPC_INVALID_REQUEST',
        'validation',
        `The request does not match contract version ${String(CONTRACT_VERSION)} — ${detail}`,
        'REJECTED'
      )
    }
    const request = parsed.data
    if (this.requestOwners.has(request.requestId)) {
      return fail(
        'DUPLICATE_REQUEST',
        'validation',
        `Request ${request.requestId} is already running.`,
        'REJECTED'
      )
    }
    const inFlight = [...this.requestOwners.values()].filter(
      (owner) => owner === event.sender.id
    ).length
    if (inFlight >= (this.options.maxInFlightPerWindow ?? 64)) {
      return fail(
        'TOO_MANY_REQUESTS',
        'dependency',
        'The window already has too many requests running.',
        'REJECTED'
      )
    }

    const log = this.log.child({ correlationId: request.requestId })
    log.debug('gateway.request', `${request.kind} ${request.type}`, {
      type: request.type,
      kind: request.kind
    })
    this.requestOwners.set(request.requestId, event.sender.id)
    try {
      const result = await this.options.core.dispatch(request, this.actorFor(event))
      log.debug(
        'gateway.response',
        `${request.type} ${result.ok ? 'succeeded' : `failed: ${result.error.code}`}`,
        { type: request.type }
      )
      return result
    } finally {
      this.requestOwners.delete(request.requestId)
    }
  }

  private async guarded<T>(
    event: IpcMainInvokeEvent,
    channel: keyof typeof gatewayContract,
    raw: unknown,
    handler: (input: never, correlationId: string) => Promise<T> | T
  ): Promise<GatewayReply> {
    const correlationId = uuidv7()
    const log = this.log.child({ correlationId })
    if (!this.options.isTrustedSender(event)) {
      this.auditRejection(event, correlationId, 'IPC_UNTRUSTED_SENDER', 'DENIED', raw, channel)
      return this.error(
        correlationId,
        'IPC_UNTRUSTED_SENDER',
        'permission',
        'The request did not come from the Jupiter interface.'
      )
    }
    this.windows.add(event.sender.id)
    const contract = gatewayContract[channel]
    const input = contract.input.safeParse(raw === null ? undefined : raw)
    if (!input.success) {
      this.auditRejection(event, correlationId, 'IPC_INVALID_REQUEST', 'REJECTED', raw, channel)
      return this.error(
        correlationId,
        'IPC_INVALID_REQUEST',
        'validation',
        `Invalid ${channel} request.`
      )
    }
    try {
      const result = await handler(input.data as never, correlationId)
      const output = contract.output.safeParse(result)
      if (!output.success) {
        log.error('gateway.output.invalid', `${channel} produced output that breaks its contract`)
        return this.error(
          correlationId,
          'IPC_INVALID_OUTPUT',
          'internal',
          `Jupiter produced an invalid reply for ${channel}, so it was not sent.`
        )
      }
      log.debug('gateway.reply', `${channel} succeeded`)
      return { ok: true, correlationId, data: output.data }
    } catch (error) {
      const envelope = toErrorEnvelope(error, {
        code: 'GATEWAY_FAILED',
        category: 'internal',
        userAction: 'Try again.',
        retryable: true
      })
      log.warn('gateway.failed', `${channel} failed: ${envelope.message}`, { code: envelope.code })
      return { ok: false, correlationId, error: envelope }
    }
  }

  private error(
    correlationId: string,
    code: string,
    category: ErrorEnvelope['category'],
    message: string
  ): GatewayReply {
    return {
      ok: false,
      correlationId,
      error: createErrorEnvelope({ code, category, message, userAction: null, retryable: false })
    }
  }

  private actorFor(event: IpcMainInvokeEvent): Actor {
    return { type: 'user-interface', id: `window:${String(event.sender.id)}` }
  }

  private auditRejection(
    event: IpcMainInvokeEvent,
    correlationId: string,
    code: string,
    decision: 'DENIED' | 'REJECTED',
    raw: unknown,
    channel?: string
  ): void {
    const trusted = decision !== 'DENIED'
    this.log
      .child({ correlationId })
      .warn('gateway.rejected', `Refused a ${channel ?? InvokeChannel.request} call: ${code}`, {
        code,
        webContentsId: event.sender.id
      })
    const requested =
      typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined
    this.options.audit({
      auditId: uuidv7(),
      eventType: 'gateway.rejected',
      actor: {
        type: trusted ? 'user-interface' : 'unverified',
        id: `webcontents:${String(event.sender.id)}`
      },
      capability: null,
      target: null,
      decision,
      riskLevel: 'LOW',
      missionId: null,
      executionId: null,
      timestamp: new Date().toISOString(),
      metadataRedacted: {
        code,
        channel: channel ?? InvokeChannel.request,
        requestedCapability: typeof requested === 'string' ? requested.slice(0, 96) : null
      },
      correlationId,
      outcome: null
    })
  }

  /** Retry bypasses the Core dispatcher (it must work while Core is down), so it is audited here. */
  private auditRetry(
    event: IpcMainInvokeEvent,
    correlationId: string,
    serviceId: string,
    outcome: 'SUCCEEDED' | 'FAILED'
  ): void {
    this.options.audit({
      auditId: uuidv7(),
      eventType: 'gateway.service-retry',
      actor: this.actorFor(event),
      capability: null,
      target: serviceId.slice(0, 260),
      decision: 'ALLOWED',
      riskLevel: 'LOW',
      missionId: null,
      executionId: null,
      timestamp: new Date().toISOString(),
      metadataRedacted: { channel: InvokeChannel.retryService },
      correlationId,
      outcome
    })
  }

  private push(webContentsId: number, message: RendererMessage): void {
    const parsed = RendererMessage.safeParse(message)
    if (!parsed.success) {
      this.log.error(
        'gateway.push.invalid',
        `Dropped a ${message.kind} message that breaks the renderer contract`
      )
      return
    }
    const target = this.options.target(webContentsId)
    if (!target || target.isDestroyed()) {
      this.releaseWindow(webContentsId, 'window gone')
      return
    }
    target.send(PushChannel.message, parsed.data)
  }
}

function extractRequestId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = (raw as { requestId?: unknown }).requestId
  return typeof candidate === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
    ? candidate
    : null
}

function serializedSize(raw: unknown): number | null {
  try {
    // `JSON.stringify` returns undefined for undefined, functions and symbols despite its declared type.
    const text = JSON.stringify(raw) as string | undefined
    return text === undefined ? 0 : Buffer.byteLength(text)
  } catch {
    return null
  }
}
