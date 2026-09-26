import type {
  CostLatencyPreference,
  ErrorEnvelope,
  FallbackPolicy,
  Locality,
  ModelCapability,
  RouteDecision,
  RouteReason,
  RoutingMode
} from '@jupiter/contracts'
import { createErrorEnvelope } from '../errors'

/**
 * The model router: which configured model serves a request.
 *
 * A pure function of the configuration it is given, so every rule is
 * testable without a network or a database:
 *  1. only models that can do what is asked (their capabilities include it);
 *  2. only providers the routing mode allows — `LOCAL_ONLY`: this computer
 *     only; `CLOUD`: cloud only; `HYBRID`: this computer first; `AUTO`: any;
 *  3. only providers that can be used now (enabled, adapter installed, key
 *     saved when one is needed and not known to be rejected);
 *  4. in order: the conversation's own model, the preferred model for the
 *     capability, (in HYBRID) this computer before the cloud, the preferred
 *     provider, then cost or measured latency where known;
 *  5. fallbacks are listed only as far as the fallback policy allows —
 *     `same-locality` never goes from this computer to the cloud;
 *  6. when nothing fits, a configuration error says why. Nothing is invented.
 */

export interface RouterModel {
  readonly modelId: string
  readonly displayName: string | null
  readonly enabled: boolean
  readonly capabilities: readonly ModelCapability[]
  readonly inputCostPerMillion: number | null
  readonly outputCostPerMillion: number | null
  readonly observedLatencyMs: number | null
}

export interface RouterProvider {
  readonly providerId: string
  readonly displayName: string
  readonly locality: Locality
  /** Null when usable; otherwise why not (shown when nothing else fits). */
  readonly unusable: string | null
  readonly models: readonly RouterModel[]
}

export interface ModelChoice {
  readonly providerId: string
  readonly modelId: string
}

export interface RouteInput {
  readonly capability: ModelCapability
  /** Further capabilities the request needs (e.g. `tools`). */
  readonly requires?: readonly ModelCapability[]
  readonly mode: RoutingMode
  readonly fallbackPolicy: FallbackPolicy
  readonly costLatency: CostLatencyPreference
  readonly preferredProvider: string | null
  readonly preferredModel: ModelChoice | null
  /** The conversation's own model, if it has one. */
  readonly pinnedModel: ModelChoice | null
  readonly providers: readonly RouterProvider[]
}

export interface RouteCandidate {
  readonly provider: RouterProvider
  readonly model: RouterModel
  readonly reason: RouteReason
}

export type RouteResult =
  | { readonly ok: true; readonly primary: RouteCandidate; readonly fallbacks: RouteCandidate[] }
  | { readonly ok: false; readonly error: ErrorEnvelope }

const CAPABILITY_NAMES: Record<ModelCapability, string> = {
  chat: 'chat',
  reasoning: 'reasoning',
  vision: 'images (vision)',
  embeddings: 'embeddings',
  tools: 'tool calling',
  'structured-output': 'structured output'
}

export function allowedByMode(mode: RoutingMode, locality: Locality): boolean {
  if (mode === 'LOCAL_ONLY') return locality === 'this-device'
  if (mode === 'CLOUD') return locality === 'cloud'
  return true
}

function modeName(mode: RoutingMode): string {
  switch (mode) {
    case 'LOCAL_ONLY':
      return 'Local only'
    case 'CLOUD':
      return 'Cloud'
    case 'HYBRID':
      return 'Hybrid'
    case 'AUTO':
      return 'Auto'
  }
}

function noRoute(message: string, userAction: string, code = 'NO_MODEL_AVAILABLE'): RouteResult {
  return {
    ok: false,
    error: createErrorEnvelope({
      code,
      category: code === 'PRIVACY_MODE_BLOCKED' ? 'permission' : 'configuration',
      message,
      userAction,
      retryable: false
    })
  }
}

export function selectRoute(input: RouteInput): RouteResult {
  const needed = [input.capability, ...(input.requires ?? [])]
  const what = needed.map((capability) => CAPABILITY_NAMES[capability]).join(' and ')
  const capable = (model: RouterModel) =>
    model.enabled && needed.every((capability) => model.capabilities.includes(capability))
  const all = input.providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model }))
  )

  if (input.pinnedModel) {
    const pinned = input.pinnedModel
    const found = all.find(
      (entry) =>
        entry.provider.providerId === pinned.providerId && entry.model.modelId === pinned.modelId
    )
    if (!found)
      return noRoute(
        'The model chosen for this conversation is no longer set up.',
        'Choose another model for this conversation, or set it up again in AI models.'
      )
    if (!allowedByMode(input.mode, found.provider.locality))
      return input.mode === 'LOCAL_ONLY'
        ? noRoute(
            `Local only mode is on, and the model chosen for this conversation (${found.model.modelId} from ${found.provider.displayName}) is not on this computer. Nothing was sent.`,
            'Choose a model on this computer for this conversation, or change the routing mode.',
            'PRIVACY_MODE_BLOCKED'
          )
        : noRoute(
            `${modeName(input.mode)} mode does not allow ${found.provider.displayName}, the provider chosen for this conversation.`,
            'Choose another model for this conversation, or change the routing mode.'
          )
    if (found.provider.unusable)
      return noRoute(
        `${found.provider.displayName} cannot be used: ${found.provider.unusable}`,
        'Fix it in AI models, or choose another model for this conversation.'
      )
    if (!capable(found.model))
      return noRoute(
        `${found.model.modelId}, chosen for this conversation, is not set up for ${what}.`,
        'Enable it for this in AI models, or choose another model.'
      )
    const primary: RouteCandidate = { ...found, reason: 'conversation-model' }
    const others = rank(
      all.filter(
        (entry) =>
          entry !== found &&
          !entry.provider.unusable &&
          allowedByMode(input.mode, entry.provider.locality) &&
          capable(entry.model)
      ),
      input
    )
    return { ok: true, primary, fallbacks: fallbacksFor(primary, others, input.fallbackPolicy) }
  }

  if (input.providers.length === 0)
    return noRoute(
      'No AI provider is set up yet, so Jupiter has no model to answer with.',
      'Add a provider in AI models.'
    )
  const usable = all.filter((entry) => !entry.provider.unusable)
  if (usable.length === 0) {
    const reasons = input.providers
      .map((provider) => `${provider.displayName}: ${provider.unusable ?? 'no models'}`)
      .join('; ')
    return noRoute(`No provider can be used right now (${reasons}).`, 'Fix it in AI models.')
  }
  const allowed = usable.filter((entry) => allowedByMode(input.mode, entry.provider.locality))
  if (allowed.length === 0)
    return input.mode === 'LOCAL_ONLY'
      ? noRoute(
          'Local only mode is on, and no model on this computer is set up. Nothing was sent.',
          'Add a provider that runs on this computer (for example at http://127.0.0.1), or change the routing mode.',
          'PRIVACY_MODE_BLOCKED'
        )
      : noRoute(
          `${modeName(input.mode)} mode is on, and no provider it allows is set up.`,
          'Add a provider, or change the routing mode in AI models.'
        )
  const eligible = allowed.filter((entry) => capable(entry.model))
  if (eligible.length === 0) {
    // Say so when a model could do it, but the routing mode keeps it out.
    const blocked = usable.find(
      (entry) => capable(entry.model) && !allowedByMode(input.mode, entry.provider.locality)
    )
    if (blocked && input.mode === 'LOCAL_ONLY')
      return noRoute(
        `Local only mode is on: ${blocked.model.modelId} (${blocked.provider.displayName}) can do ${what}, but it is not on this computer, and no model on this computer is set up for ${what}. Nothing was sent.`,
        `Enable a model on this computer for ${what}, or change the routing mode.`,
        'PRIVACY_MODE_BLOCKED'
      )
    if (blocked)
      return noRoute(
        `${modeName(input.mode)} mode is on: ${blocked.model.modelId} (${blocked.provider.displayName}) can do ${what}, but the mode does not allow it, and no model it allows is set up for ${what}.`,
        `Enable a model for ${what} that the mode allows, or change the routing mode.`
      )
    return noRoute(
      `None of the enabled models${input.mode === 'LOCAL_ONLY' ? ' on this computer' : ''} is set up for ${what}.`,
      `Enable a model for ${what} in AI models.`
    )
  }

  const ranked = rank(eligible, input)
  const [first, ...rest] = ranked
  if (!first) return noRoute('No model is available.', 'Check AI models.')
  return { ok: true, primary: first, fallbacks: fallbacksFor(first, rest, input.fallbackPolicy) }
}

function rank(
  entries: readonly { provider: RouterProvider; model: RouterModel }[],
  input: RouteInput
): RouteCandidate[] {
  const order = new Map(input.providers.map((provider, index) => [provider.providerId, index]))
  const isPreferredModel = (entry: { provider: RouterProvider; model: RouterModel }) =>
    input.preferredModel !== null &&
    entry.provider.providerId === input.preferredModel.providerId &&
    entry.model.modelId === input.preferredModel.modelId
  const metric = (model: RouterModel): number => {
    if (input.costLatency === 'lower-cost') {
      return model.inputCostPerMillion === null || model.outputCostPerMillion === null
        ? Number.POSITIVE_INFINITY
        : model.inputCostPerMillion + model.outputCostPerMillion
    }
    if (input.costLatency === 'lower-latency')
      return model.observedLatencyMs ?? Number.POSITIVE_INFINITY
    return 0
  }
  const keyed = entries.map((entry, index) => ({
    entry,
    keys: [
      isPreferredModel(entry) ? 0 : 1,
      input.mode === 'HYBRID' && entry.provider.locality === 'cloud' ? 1 : 0,
      entry.provider.providerId === input.preferredProvider ? 0 : 1,
      metric(entry.model),
      order.get(entry.provider.providerId) ?? 0,
      index
    ]
  }))
  keyed.sort((a, b) => {
    for (let i = 0; i < a.keys.length; i++) {
      const left = a.keys[i] ?? 0
      const right = b.keys[i] ?? 0
      if (left !== right) return left < right ? -1 : 1
    }
    return 0
  })
  return keyed.map(({ entry }) => ({
    ...entry,
    reason: isPreferredModel(entry)
      ? 'preferred-model'
      : entry.provider.providerId === input.preferredProvider
        ? 'preferred-provider'
        : 'best-available'
  }))
}

function fallbacksFor(
  primary: RouteCandidate,
  others: readonly RouteCandidate[],
  policy: FallbackPolicy
): RouteCandidate[] {
  if (policy === 'never') return []
  if (policy === 'same-locality')
    return others.filter((candidate) => candidate.provider.locality === primary.provider.locality)
  return [...others]
}

export function decisionOf(
  candidate: RouteCandidate,
  capability: ModelCapability,
  mode: RoutingMode,
  fallbackFrom: RouteDecision['fallbackFrom'] = null
): RouteDecision {
  return {
    providerId: candidate.provider.providerId,
    providerName: candidate.provider.displayName,
    modelId: candidate.model.modelId,
    modelName: candidate.model.displayName,
    locality: candidate.provider.locality,
    capability,
    mode,
    reason: candidate.reason,
    fallbackFrom
  }
}
