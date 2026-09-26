import type {
  Actor,
  ErrorEnvelope,
  FinishReason,
  RouteDecision,
  TokenUsage
} from '@jupiter/contracts'
import { JupiterError, toErrorEnvelope } from '../errors'
import { ProviderError, TRANSIENT_PROVIDER_ERRORS, type AdapterMessage } from './adapter'
import type { ProviderService } from './providers'
import { decisionOf, type RouteCandidate } from './router'

/**
 * Ask a chat model for a complete text answer, through the same routing,
 * network guard, key handling and fallback rules as Chat. Used by Mission
 * steps (SET 4). Fallback happens only before anything arrived, only for
 * failures that say nothing about the request, and only to models the
 * fallback policy allows; the route that answered says so.
 */

export interface CompletionRequest {
  readonly messages: readonly AdapterMessage[]
  readonly signal: AbortSignal
  readonly correlationId: string
  readonly actor: Actor
  /** No data for this long ends the request. Default 120 s. */
  readonly idleTimeoutMs?: number
  /** Called once, when the route is known and the request is about to be sent. */
  readonly onRoute?: (route: RouteDecision) => void
}

export interface Completion {
  readonly text: string
  readonly route: RouteDecision
  readonly usage: TokenUsage | null
  readonly finishReason: FinishReason
}

const MAX_TEXT = 200_000

export async function completeText(
  providers: ProviderService,
  request: CompletionRequest
): Promise<Completion> {
  const { result, mode } = providers.route('chat', null)
  if (!result.ok)
    throw new JupiterError(result.error.code, result.error.message, {
      category: result.error.category,
      userAction: result.error.userAction,
      retryable: result.error.retryable
    })
  const candidates = [result.primary, ...result.fallbacks]
  let failure: { candidate: RouteCandidate; error: ErrorEnvelope } | null = null
  for (const [index, candidate] of candidates.entries()) {
    const route = decisionOf(
      candidate,
      'chat',
      mode,
      failure
        ? {
            providerId: failure.candidate.provider.providerId,
            providerName: failure.candidate.provider.displayName,
            modelId: failure.candidate.model.modelId,
            errorCode: failure.error.code
          }
        : null
    )
    request.onRoute?.(route)
    const progress = { received: false }
    try {
      return await attempt(providers, candidate, route, mode, request, () => {
        progress.received = true
      })
    } catch (error) {
      if (request.signal.aborted) throw error
      const envelope = toErrorEnvelope(error, {
        code: 'PROVIDER_REQUEST_FAILED',
        category: 'provider',
        userAction: 'Try again.',
        retryable: true
      })
      const canFallBack =
        !progress.received &&
        TRANSIENT_PROVIDER_ERRORS.has(envelope.code) &&
        index < candidates.length - 1
      if (!canFallBack) throw error
      failure = { candidate, error: envelope }
    }
  }
  throw new JupiterError('NO_MODEL_AVAILABLE', 'No model could answer.', {
    category: 'configuration',
    userAction: 'Check AI models.'
  })
}

async function attempt(
  providers: ProviderService,
  candidate: RouteCandidate,
  route: RouteDecision,
  mode: Parameters<ProviderService['adapterContext']>[2],
  request: CompletionRequest,
  onReceived: () => void
): Promise<Completion> {
  const provider = providers.get(candidate.provider.providerId)
  const adapter = providers.adapterFor(provider.adapterId)
  if (!adapter)
    throw new JupiterError(
      'ADAPTER_NOT_INSTALLED',
      `The adapter for ${provider.displayName} is not installed.`,
      { category: 'configuration', userAction: 'Remove this provider in AI models.' }
    )

  const controller = new AbortController()
  const forward = () => {
    controller.abort()
  }
  request.signal.addEventListener('abort', forward, { once: true })
  if (request.signal.aborted) controller.abort()
  const idleMs = request.idleTimeoutMs ?? 120_000
  const watchdog = { timedOut: false }
  let idle: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    if (idle !== undefined) clearTimeout(idle)
    idle = setTimeout(() => {
      watchdog.timedOut = true
      controller.abort()
    }, idleMs)
  }
  const started = performance.now()
  let text = ''
  let usage: TokenUsage | null = null
  let finishReason: FinishReason = 'unknown'
  try {
    arm()
    const apiKey = await providers.keyFor(
      provider.providerId,
      request.correlationId,
      controller.signal
    )
    if (adapter.info.keyRequirement === 'required' && !apiKey)
      throw new JupiterError('PROVIDER_KEY_MISSING', `${provider.displayName} needs an API key.`, {
        category: 'configuration',
        userAction: 'Save an API key for it in AI models.'
      })
    const context = providers.adapterContext(provider, apiKey, mode, 'chat', controller.signal, {
      correlationId: request.correlationId,
      actor: request.actor
    })
    for await (const chunk of adapter.streamChat(context, {
      model: candidate.model.modelId,
      messages: request.messages
    })) {
      arm()
      if (chunk.type === 'text') {
        if (!text)
          providers.recordLatency(
            provider.providerId,
            candidate.model.modelId,
            performance.now() - started
          )
        onReceived()
        text = (text + chunk.text).slice(0, MAX_TEXT)
      } else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finishReason = chunk.reason
      else onReceived()
    }
  } catch (error) {
    if (watchdog.timedOut && !request.signal.aborted)
      throw new ProviderError(
        'PROVIDER_TIMEOUT',
        `${provider.displayName} stopped sending the answer (nothing for ${String(Math.round(idleMs / 1000))} seconds).`,
        { cause: error }
      )
    throw error
  } finally {
    if (idle !== undefined) clearTimeout(idle)
    request.signal.removeEventListener('abort', forward)
  }
  return { text, route, usage, finishReason }
}
