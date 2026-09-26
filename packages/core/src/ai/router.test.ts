import { describe, expect, it } from 'vitest'
import type { ModelCapability } from '@jupiter/contracts'
import { selectRoute, type RouteInput, type RouterModel, type RouterProvider } from './router'

const LOCAL = '01a0d82f-22b6-762b-b369-29675d970a01'
const LOCAL_2 = '01a0d82f-22b6-762b-b369-29675d970a02'
const CLOUD = '01a0d82f-22b6-762b-b369-29675d970a03'

function model(
  modelId: string,
  capabilities: ModelCapability[],
  extra: Partial<RouterModel> = {}
): RouterModel {
  return {
    modelId,
    displayName: null,
    enabled: true,
    capabilities,
    inputCostPerMillion: null,
    outputCostPerMillion: null,
    observedLatencyMs: null,
    ...extra
  }
}

function provider(
  providerId: string,
  locality: 'this-device' | 'cloud',
  models: RouterModel[],
  unusable: string | null = null
): RouterProvider {
  return { providerId, displayName: providerId.slice(-3), locality, unusable, models }
}

const providers: RouterProvider[] = [
  provider(LOCAL, 'this-device', [
    model('local-chat', ['chat']),
    model('local-embed', ['embeddings'])
  ]),
  provider(CLOUD, 'cloud', [
    model('cloud-chat', ['chat', 'tools', 'structured-output']),
    model('cloud-vision', ['chat', 'vision']),
    model('cloud-reasoner', ['chat', 'reasoning'])
  ])
]

function route(overrides: Partial<RouteInput> = {}) {
  return selectRoute({
    capability: 'chat',
    mode: 'AUTO',
    fallbackPolicy: 'never',
    costLatency: 'balanced',
    preferredProvider: null,
    preferredModel: null,
    pinnedModel: null,
    providers,
    ...overrides
  })
}

function picked(result: ReturnType<typeof route>): string {
  if (!result.ok) throw new Error(`no route: ${result.error.message}`)
  return result.primary.model.modelId
}

describe('model router — capability', () => {
  it('selects a model that has the requested capability', () => {
    expect(picked(route({ capability: 'vision' }))).toBe('cloud-vision')
    expect(picked(route({ capability: 'reasoning' }))).toBe('cloud-reasoner')
    expect(picked(route({ capability: 'embeddings' }))).toBe('local-embed')
    expect(picked(route({ capability: 'chat', requires: ['tools'] }))).toBe('cloud-chat')
  })

  it('never selects a disabled model, or one that lacks a capability', () => {
    const result = route({
      capability: 'vision',
      providers: [
        provider(CLOUD, 'cloud', [
          model('cloud-vision', ['chat', 'vision'], { enabled: false }),
          model('cloud-chat', ['chat'])
        ])
      ]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODEL_AVAILABLE')
      expect(result.error.category).toBe('configuration')
      expect(result.error.message).toContain('images (vision)')
    }
  })

  it('uses the preferred model for the capability, then the preferred provider', () => {
    expect(
      picked(route({ preferredModel: { providerId: CLOUD, modelId: 'cloud-reasoner' } }))
    ).toBe('cloud-reasoner')
    expect(picked(route({ preferredProvider: CLOUD }))).toBe('cloud-chat')
    const result = route({ preferredProvider: CLOUD })
    expect(result.ok && result.primary.reason).toBe('preferred-provider')
  })

  it('breaks ties by cost or measured latency only where they are known', () => {
    const priced = [
      provider(CLOUD, 'cloud', [
        model('expensive', ['chat'], { inputCostPerMillion: 10, outputCostPerMillion: 30 }),
        model('unknown-price', ['chat']),
        model('cheap', ['chat'], {
          inputCostPerMillion: 0.1,
          outputCostPerMillion: 0.4,
          observedLatencyMs: 900
        }),
        model('fast', ['chat'], { observedLatencyMs: 120 })
      ])
    ]
    expect(picked(route({ providers: priced, costLatency: 'lower-cost' }))).toBe('cheap')
    expect(picked(route({ providers: priced, costLatency: 'lower-latency' }))).toBe('fast')
    expect(picked(route({ providers: priced, costLatency: 'balanced' }))).toBe('expensive')
  })
})

describe('model router — routing modes and privacy', () => {
  it('LOCAL_ONLY considers only models on this computer', () => {
    expect(picked(route({ mode: 'LOCAL_ONLY' }))).toBe('local-chat')
    const vision = route({ mode: 'LOCAL_ONLY', capability: 'vision' })
    expect(vision.ok).toBe(false)
    if (!vision.ok) expect(vision.error.message).toContain('on this computer')
  })

  it('LOCAL_ONLY refuses a conversation pinned to a cloud model instead of switching models', () => {
    const result = route({
      mode: 'LOCAL_ONLY',
      pinnedModel: { providerId: CLOUD, modelId: 'cloud-chat' }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PRIVACY_MODE_BLOCKED')
      expect(result.error.message).toContain('Nothing was sent')
    }
  })

  it('LOCAL_ONLY with only cloud providers is a privacy error, not a silent cloud call', () => {
    const result = route({
      mode: 'LOCAL_ONLY',
      providers: providers.filter((item) => item.locality === 'cloud')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PRIVACY_MODE_BLOCKED')
  })

  it('LOCAL_ONLY says which cloud model it kept out when no local model can do the task', () => {
    const vision = route({ mode: 'LOCAL_ONLY', capability: 'vision' })
    expect(vision.ok).toBe(false)
    if (!vision.ok) {
      expect(vision.error.code).toBe('PRIVACY_MODE_BLOCKED')
      expect(vision.error.message).toContain('cloud-vision')
      expect(vision.error.message).toContain('Nothing was sent')
    }
    // Nothing capable anywhere is a configuration problem, not a privacy one.
    const none = route({
      mode: 'LOCAL_ONLY',
      capability: 'embeddings',
      providers: providers
        .filter((item) => item.locality === 'cloud')
        .concat(provider(LOCAL_2, 'this-device', [model('local-other', ['chat'])]))
    })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error.code).toBe('NO_MODEL_AVAILABLE')
  })

  it('CLOUD uses only cloud providers; HYBRID prefers this computer; AUTO follows preferences', () => {
    expect(picked(route({ mode: 'CLOUD' }))).toBe('cloud-chat')
    expect(picked(route({ mode: 'HYBRID', preferredProvider: CLOUD }))).toBe('local-chat')
    expect(picked(route({ mode: 'HYBRID', capability: 'vision' }))).toBe('cloud-vision')
    expect(picked(route({ mode: 'AUTO', preferredProvider: CLOUD }))).toBe('cloud-chat')
  })

  it('skips providers that cannot be used, and says why when none can', () => {
    expect(
      picked(
        route({
          providers: [
            provider(LOCAL, 'this-device', [model('local-chat', ['chat'])], 'it needs an API key'),
            provider(CLOUD, 'cloud', [model('cloud-chat', ['chat'])])
          ]
        })
      )
    ).toBe('cloud-chat')
    const none = route({
      providers: [
        provider(CLOUD, 'cloud', [model('cloud-chat', ['chat'])], 'it rejected the saved API key')
      ]
    })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error.message).toContain('rejected the saved API key')
  })

  it('returns a configuration error when nothing is set up — never an invented answer', () => {
    const result = route({ providers: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODEL_AVAILABLE')
      expect(result.error.userAction).toContain('AI models')
    }
  })
})

describe('model router — fallback policy', () => {
  const twoLocalsAndCloud: RouterProvider[] = [
    provider(LOCAL, 'this-device', [model('local-a', ['chat'])]),
    provider(LOCAL_2, 'this-device', [model('local-b', ['chat'])]),
    provider(CLOUD, 'cloud', [model('cloud-chat', ['chat'])])
  ]

  it('lists no fallback with `never`', () => {
    const result = route({ providers: twoLocalsAndCloud, fallbackPolicy: 'never' })
    expect(result.ok && result.fallbacks).toEqual([])
  })

  it('never falls back from this computer to the cloud with `same-locality`', () => {
    const result = route({ providers: twoLocalsAndCloud, fallbackPolicy: 'same-locality' })
    if (!result.ok) throw new Error('expected a route')
    expect(result.primary.model.modelId).toBe('local-a')
    expect(result.fallbacks.map((candidate) => candidate.model.modelId)).toEqual(['local-b'])
  })

  it('allows any model the mode allows with `allowed-by-mode`, and never beyond it', () => {
    const auto = route({ providers: twoLocalsAndCloud, fallbackPolicy: 'allowed-by-mode' })
    expect(auto.ok && auto.fallbacks.map((candidate) => candidate.model.modelId)).toEqual([
      'local-b',
      'cloud-chat'
    ])
    const localOnly = route({
      providers: twoLocalsAndCloud,
      fallbackPolicy: 'allowed-by-mode',
      mode: 'LOCAL_ONLY'
    })
    expect(localOnly.ok && localOnly.fallbacks.map((candidate) => candidate.model.modelId)).toEqual(
      ['local-b']
    )
  })

  it('keeps a conversation on its own model first, with policy-bound fallbacks after it', () => {
    const result = route({
      providers: twoLocalsAndCloud,
      fallbackPolicy: 'same-locality',
      pinnedModel: { providerId: LOCAL_2, modelId: 'local-b' }
    })
    if (!result.ok) throw new Error('expected a route')
    expect(result.primary.reason).toBe('conversation-model')
    expect(result.primary.model.modelId).toBe('local-b')
    expect(result.fallbacks.map((candidate) => candidate.model.modelId)).toEqual(['local-a'])
  })
})
