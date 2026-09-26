import {
  CONTRACT_VERSION,
  Capabilities,
  GatewayReply,
  GatewayStatus,
  RendererMessage,
  ResultEnvelope,
  SubscribeReceipt,
  type CapabilityInput,
  type CapabilityName,
  type CapabilityOutput,
  type DomainEvent,
  type ErrorEnvelope,
  type EventFilter,
  type ProgressUpdate,
  type RendererErrorReport
} from '@jupiter/contracts'
import { createErrorEnvelope, uuidv7 } from '@jupiter/core'
import type { JupiterBridge } from '../../shared/bridge'

/**
 * Typed client for the preload bridge (contract version 1).
 *
 * Every reply and every pushed message is validated against the shared
 * contract before the UI uses it; anything that does not match is treated as
 * an error, never displayed.
 */

export class BridgeError extends Error {
  constructor(readonly envelope: ErrorEnvelope) {
    super(envelope.message)
    this.name = 'BridgeError'
  }
}

function bridge(): JupiterBridge {
  const candidate = window.jupiter
  if (!candidate) {
    throw new BridgeError(
      createErrorEnvelope({
        code: 'BRIDGE_UNAVAILABLE',
        category: 'dependency',
        message: 'The interface is not connected to Jupiter (the preload bridge did not load).',
        userAction: 'Restart Jupiter. If this keeps happening, reinstall it.',
        retryable: false
      })
    )
  }
  return candidate
}

function invalidReply(): BridgeError {
  return new BridgeError(
    createErrorEnvelope({
      code: 'IPC_INVALID_RESPONSE',
      category: 'internal',
      message: 'Jupiter sent a reply that does not match its contract, so it was not used.',
      userAction:
        'Restart Jupiter. If this keeps happening, include the log files in a bug report.',
      retryable: false
    })
  )
}

async function call(invoke: () => Promise<unknown>): Promise<unknown> {
  try {
    return await invoke()
  } catch (error) {
    throw new BridgeError(
      createErrorEnvelope({
        code: 'BRIDGE_CALL_FAILED',
        category: 'internal',
        message: `The request to Jupiter failed: ${error instanceof Error ? error.message : String(error)}`,
        userAction: 'Try again. If it keeps failing, restart Jupiter.',
        retryable: true
      })
    )
  }
}

async function gatewayCall<T>(
  invoke: () => Promise<unknown>,
  parse: (data: unknown) => T | null
): Promise<T> {
  const reply = GatewayReply.safeParse(await call(invoke))
  if (!reply.success) throw invalidReply()
  if (!reply.data.ok) throw new BridgeError(reply.data.error)
  const data = parse(reply.data.data)
  if (data === null) throw invalidReply()
  return data
}

// ---- pushed messages ------------------------------------------------------------------

type Listener<T> = (value: T) => void
const statusListeners = new Set<Listener<GatewayStatus>>()
const progressListeners = new Map<string, Listener<ProgressUpdate>>()
const subscriptionHandlers = new Map<
  string,
  { onEvent: Listener<DomainEvent>; onEnded: () => void }
>()
let listening = false

function ensureListening(): void {
  if (listening || !window.jupiter) return
  listening = true
  window.jupiter.onMessage((raw) => {
    const parsed = RendererMessage.safeParse(raw)
    if (!parsed.success) return
    const message = parsed.data
    switch (message.kind) {
      case 'gateway-status':
        for (const listener of statusListeners) listener(message.status)
        return
      case 'progress':
        progressListeners.get(message.progress.requestId)?.(message.progress)
        return
      case 'event':
        subscriptionHandlers.get(message.subscriptionId)?.onEvent(message.event)
        return
      case 'subscription-ended':
        subscriptionHandlers.get(message.subscriptionId)?.onEnded()
        return
    }
  })
}

// ---- gateway operations ------------------------------------------------------------------

export function fetchGatewayStatus(): Promise<GatewayStatus> {
  ensureListening()
  return gatewayCall(
    () => bridge().gatewayStatus(),
    (data) => GatewayStatus.safeParse(data).data ?? null
  )
}

export function retryService(serviceId: string): Promise<GatewayStatus> {
  return gatewayCall(
    () => bridge().retryService(serviceId),
    (data) => GatewayStatus.safeParse(data).data ?? null
  )
}

export function onGatewayStatus(listener: Listener<GatewayStatus>): () => void {
  ensureListening()
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

// ---- commands and queries -------------------------------------------------------------

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ProgressUpdate) => void
}

/** Send a command or query to Jupiter Core and return its validated output. */
export async function request<C extends CapabilityName>(
  type: C,
  payload: CapabilityInput<C>,
  options: RequestOptions = {}
): Promise<CapabilityOutput<C>> {
  ensureListening()
  const contract = Capabilities[type]
  const requestId = uuidv7()
  const envelope = {
    v: CONTRACT_VERSION,
    requestId,
    kind: contract.kind,
    type,
    payload,
    missionId: null,
    executionId: null,
    sentAt: new Date().toISOString()
  }
  if (options.onProgress) progressListeners.set(requestId, options.onProgress)
  const onAbort = () => {
    void bridge().cancel(requestId)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = ResultEnvelope.safeParse(await call(() => bridge().request(envelope)))
    if (!result.success || result.data.requestId !== requestId) throw invalidReply()
    if (!result.data.ok) throw new BridgeError(result.data.error)
    const output = contract.output.safeParse(result.data.data)
    if (!output.success) throw invalidReply()
    return output.data as CapabilityOutput<C>
  } finally {
    progressListeners.delete(requestId)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Report an interface error to Jupiter's log. Resolves to the log reference, or null. */
export async function reportRendererError(report: RendererErrorReport): Promise<string | null> {
  try {
    const requestId = uuidv7()
    const raw = await bridge().request({
      v: CONTRACT_VERSION,
      requestId,
      kind: 'command',
      type: 'diagnostics.report-renderer-error',
      payload: report,
      missionId: null,
      executionId: null,
      sentAt: new Date().toISOString()
    })
    const result = ResultEnvelope.safeParse(raw)
    return result.success && result.data.ok ? result.data.correlationId : null
  } catch {
    return null
  }
}

// ---- event subscriptions ------------------------------------------------------------------

export interface EventStreamOptions {
  readonly filter: EventFilter
  readonly replayLimit: number
  /** Global sequence of the last event already seen; null for "the most recent events". */
  readonly afterSequence: number | null
  readonly onEvent: (event: DomainEvent) => void
  /** The replay could not bridge the gap from the cursor: discard local state. */
  readonly onReset: () => void
  /** Jupiter Core stopped: the subscription is gone until it is resumed. */
  readonly onEnded: () => void
}

export interface EventStream {
  readonly subscriptionId: string
  close(): void
}

/** Open a subscription. Events are delivered in global order; the caller resumes from its own cursor. */
export async function subscribeEvents(options: EventStreamOptions): Promise<EventStream> {
  ensureListening()
  const subscriptionId = uuidv7()
  // Replayed events may arrive before the receipt: hold them until the receipt
  // says whether local state must be reset first.
  let buffered: DomainEvent[] | null = []
  subscriptionHandlers.set(subscriptionId, {
    onEvent: (event) => {
      if (buffered) buffered.push(event)
      else options.onEvent(event)
    },
    onEnded: () => {
      subscriptionHandlers.delete(subscriptionId)
      options.onEnded()
    }
  })
  try {
    const receipt = await gatewayCall(
      () =>
        bridge().subscribe({
          subscriptionId,
          afterSequence: options.afterSequence,
          replayLimit: options.replayLimit,
          filter: options.filter
        }),
      (data) => SubscribeReceipt.safeParse(data).data ?? null
    )
    if (receipt.truncated) options.onReset()
    const pending = buffered
    buffered = null
    for (const event of pending) options.onEvent(event)
  } catch (error) {
    subscriptionHandlers.delete(subscriptionId)
    throw error
  }
  return {
    subscriptionId,
    close() {
      subscriptionHandlers.delete(subscriptionId)
      void bridge().unsubscribe(subscriptionId)
    }
  }
}
