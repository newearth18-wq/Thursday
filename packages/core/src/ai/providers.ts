import {
  isProtectedTransport,
  localityOf,
  parseModelRef,
  type Actor,
  type AdapterInfo,
  type Conversation,
  type FallbackPolicy,
  type ModelCapability,
  type ModelInfo,
  type ProviderInfo,
  type ProviderState,
  type RoutePreview,
  type RoutingMode,
  type SettingKey,
  type SettingValue
} from '@jupiter/contracts'
import { JupiterError, describeError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort, StoredProvider } from '../ports'
import type { AdapterContext, ProviderAdapter, Transport } from './adapter'
import { decisionOf, selectRoute, type RouteResult, type RouterProvider } from './router'
import { createTransport, type FetchLike } from './transport'

/**
 * Configured providers: what the person set up, the keys (through the host's
 * secure storage), real health checks and model discovery, and the input the
 * router decides from.
 */

/** How Core reaches the host's secure storage. Keys pass through here and nowhere else. */
export interface CredentialVault {
  /** Resolves to the key's non-secret fingerprint. */
  store(credentialId: string, secret: string, correlationId: string): Promise<string>
  read(credentialId: string, correlationId: string, signal: AbortSignal): Promise<string>
  remove(credentialId: string, correlationId: string): Promise<boolean>
}

export interface ProviderServiceOptions {
  readonly database: () => DatabasePort
  readonly adapters: readonly ProviderAdapter[]
  readonly fetch: FetchLike
  readonly vault: CredentialVault
  readonly setting: <K extends SettingKey>(key: K) => SettingValue<K>
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
}

export interface OperationContext {
  readonly correlationId: string
  readonly actor: Actor
  readonly signal: AbortSignal
}

const MAX_PROVIDERS = 50
const CHECK_TIMEOUT_MS = 20_000

export class ProviderService {
  private readonly adapters: ReadonlyMap<string, ProviderAdapter>

  constructor(private readonly options: ProviderServiceOptions) {
    const byId = new Map<string, ProviderAdapter>()
    for (const adapter of options.adapters) {
      if (byId.has(adapter.info.adapterId))
        throw new Error(`Adapter ${adapter.info.adapterId} is installed twice`)
      byId.set(adapter.info.adapterId, adapter)
    }
    this.adapters = byId
  }

  adapterList(): AdapterInfo[] {
    return [...this.adapters.values()].map((adapter) => adapter.info)
  }

  adapterFor(adapterId: string): ProviderAdapter | null {
    return this.adapters.get(adapterId) ?? null
  }

  /** The global routing mode. */
  mode(): RoutingMode {
    return this.options.setting('ai.routingMode')
  }

  fallbackPolicy(): FallbackPolicy {
    return this.options.setting('ai.fallbackPolicy')
  }

  /**
   * The mode for a conversation. A conversation may choose its own mode, but
   * cannot relax Local only when it is on for all of Jupiter.
   */
  modeFor(conversation: Conversation | null): RoutingMode {
    const global = this.mode()
    if (global === 'LOCAL_ONLY') return 'LOCAL_ONLY'
    return conversation?.routing.mode ?? global
  }

  list(): ProviderInfo[] {
    const database = this.options.database()
    return database.providers.list().map((stored) => this.toInfo(stored, database))
  }

  get(providerId: string): ProviderInfo {
    const database = this.options.database()
    return this.toInfo(this.provider(providerId, database), database)
  }

  add(
    input: { adapterId: string; displayName: string; baseUrl: string },
    context: OperationContext
  ): ProviderInfo {
    const database = this.options.database()
    if (!this.adapters.has(input.adapterId)) throw adapterMissing(input.adapterId)
    if (database.providers.list().length >= MAX_PROVIDERS)
      throw new JupiterError(
        'TOO_MANY_PROVIDERS',
        `Jupiter keeps at most ${String(MAX_PROVIDERS)} providers.`,
        {
          category: 'validation',
          userAction: 'Remove a provider you no longer use first.'
        }
      )
    const now = this.options.now().toISOString()
    const provider: StoredProvider = {
      providerId: uuidv7(),
      adapterId: input.adapterId,
      displayName: input.displayName,
      baseUrl: input.baseUrl,
      enabled: true,
      checkState: 'not-checked',
      error: null,
      checkedAt: null,
      credentialId: null,
      credentialFingerprint: null,
      credentialSavedAt: null,
      credentialValidation: 'not-validated',
      credentialValidatedAt: null,
      createdAt: now,
      updatedAt: now
    }
    database.transactions.run(() => {
      database.providers.insert(provider)
      this.publishChange(provider.providerId, 'added', context)
    })
    return this.get(provider.providerId)
  }

  update(
    input: {
      providerId: string
      displayName?: string | undefined
      baseUrl?: string | undefined
      enabled?: boolean | undefined
    },
    context: OperationContext
  ): ProviderInfo {
    const database = this.options.database()
    const current = this.provider(input.providerId, database)
    const addressChanged = input.baseUrl !== undefined && input.baseUrl !== current.baseUrl
    if (addressChanged && current.credentialId && !isProtectedTransport(input.baseUrl ?? ''))
      throw insecureKeyAddress(current.displayName)
    database.transactions.run(() => {
      database.providers.update(input.providerId, {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        // A new address has not been checked yet.
        ...(addressChanged
          ? { checkState: 'not-checked' as const, error: null, checkedAt: null }
          : {}),
        updatedAt: this.options.now().toISOString()
      })
      this.publishChange(input.providerId, 'updated', context)
    })
    return this.get(input.providerId)
  }

  async remove(providerId: string, context: OperationContext): Promise<void> {
    const database = this.options.database()
    const current = this.provider(providerId, database)
    // The key goes first: a provider is never removed while its key would stay behind.
    if (current.credentialId)
      await this.options.vault.remove(current.credentialId, context.correlationId)
    database.transactions.run(() => {
      database.providers.remove(providerId)
      this.publishChange(providerId, 'removed', context, null)
    })
  }

  async setKey(
    providerId: string,
    apiKey: string,
    context: OperationContext
  ): Promise<ProviderInfo> {
    const database = this.options.database()
    const current = this.provider(providerId, database)
    const adapter = this.adapters.get(current.adapterId)
    if (!adapter) throw adapterMissing(current.adapterId)
    if (adapter.info.keyRequirement === 'none')
      throw new JupiterError('KEY_NOT_USED', `${current.displayName} does not use an API key.`, {
        category: 'validation',
        userAction: null
      })
    if (!isProtectedTransport(current.baseUrl)) throw insecureKeyAddress(current.displayName)
    const credentialId = current.credentialId ?? uuidv7()
    const fingerprint = await this.options.vault.store(credentialId, apiKey, context.correlationId)
    const now = this.options.now().toISOString()
    database.transactions.run(() => {
      database.providers.update(providerId, {
        credentialId,
        credentialFingerprint: fingerprint,
        credentialSavedAt: now,
        credentialValidation: 'not-validated',
        credentialValidatedAt: null,
        updatedAt: now
      })
      this.publishChange(providerId, 'key-saved', context)
    })
    // Validate right away when the routing mode allows contacting the provider.
    if (allowedNow(this.mode(), current.baseUrl)) return this.check(providerId, context)
    return this.get(providerId)
  }

  async removeKey(providerId: string, context: OperationContext): Promise<ProviderInfo> {
    const database = this.options.database()
    const current = this.provider(providerId, database)
    if (current.credentialId)
      await this.options.vault.remove(current.credentialId, context.correlationId)
    database.transactions.run(() => {
      database.providers.update(providerId, {
        credentialId: null,
        credentialFingerprint: null,
        credentialSavedAt: null,
        credentialValidation: 'not-validated',
        credentialValidatedAt: null,
        updatedAt: this.options.now().toISOString()
      })
      this.publishChange(providerId, 'key-removed', context)
    })
    return this.get(providerId)
  }

  /** Contact the provider: its model list proves it is reachable and that it accepts the key. */
  async check(providerId: string, context: OperationContext): Promise<ProviderInfo> {
    const database = this.options.database()
    const current = this.provider(providerId, database)
    const adapter = this.adapters.get(current.adapterId)
    if (!adapter) throw adapterMissing(current.adapterId)
    const mode = this.mode()
    if (!allowedNow(mode, current.baseUrl)) {
      this.recordBlocked(current.providerId, mode, 'check', context)
      return this.get(providerId)
    }
    if (adapter.info.keyRequirement === 'required' && !current.credentialId)
      return this.get(providerId)

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, CHECK_TIMEOUT_MS)
    const onAbort = () => {
      controller.abort()
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    const now = () => this.options.now().toISOString()
    try {
      const apiKey = current.credentialId
        ? await this.options.vault.read(
            current.credentialId,
            context.correlationId,
            controller.signal
          )
        : null
      const models = await adapter.listModels(
        this.adapterContext(current, apiKey, mode, 'check', controller.signal, context)
      )
      database.transactions.run(() => {
        const added = database.providers.mergeDiscovered(providerId, models, now())
        database.providers.update(providerId, {
          checkState: 'ready',
          error: null,
          checkedAt: now(),
          ...(current.credentialId
            ? { credentialValidation: 'valid' as const, credentialValidatedAt: now() }
            : {}),
          updatedAt: now()
        })
        this.publishChange(providerId, added > 0 ? 'models-changed' : 'checked', context)
      })
    } catch (error) {
      const timedOut = controller.signal.aborted && !context.signal.aborted
      const envelope = timedOut
        ? toErrorEnvelope(
            new JupiterError(
              'PROVIDER_TIMEOUT',
              `${current.displayName} did not answer within ${String(CHECK_TIMEOUT_MS / 1000)} seconds.`,
              {
                category: 'timeout',
                userAction: 'Check that the provider is running, then try again.',
                retryable: true
              }
            ),
            fallbackEnvelope
          )
        : toErrorEnvelope(error, fallbackEnvelope)
      if (envelope.code === 'PRIVACY_MODE_BLOCKED') return this.get(providerId)
      this.options.logger
        .child({ correlationId: context.correlationId })
        .warn(
          'ai.provider.check.failed',
          `Checking ${current.displayName} failed: ${envelope.message}`,
          {
            providerId,
            code: envelope.code
          }
        )
      database.transactions.run(() => {
        database.providers.update(providerId, {
          checkState: 'failed',
          error: envelope,
          checkedAt: now(),
          ...(envelope.code === 'PROVIDER_KEY_REJECTED' && current.credentialId
            ? { credentialValidation: 'rejected' as const, credentialValidatedAt: now() }
            : envelope.code !== 'PROVIDER_KEY_REJECTED' && current.credentialId
              ? { credentialValidation: 'unknown' as const }
              : {}),
          updatedAt: now()
        })
        this.publishChange(providerId, 'checked', context)
      })
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', onAbort)
    }
    return this.get(providerId)
  }

  addModel(
    input: { providerId: string; modelId: string; capabilities: readonly ModelCapability[] },
    context: OperationContext
  ): ProviderInfo {
    const database = this.options.database()
    this.provider(input.providerId, database)
    if (database.providers.model(input.providerId, input.modelId))
      throw new JupiterError('MODEL_EXISTS', `${input.modelId} is already set up.`, {
        category: 'validation',
        userAction: 'Change it in the model list instead.'
      })
    database.transactions.run(() => {
      database.providers.putModel({
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: null,
        capabilities: unique(input.capabilities),
        capabilitySource: 'user',
        enabled: true,
        discovered: false,
        contextWindow: null,
        inputCostPerMillion: null,
        outputCostPerMillion: null,
        observedLatencyMs: null,
        updatedAt: this.options.now().toISOString()
      })
      this.publishChange(input.providerId, 'models-changed', context)
    })
    return this.get(input.providerId)
  }

  updateModel(
    input: {
      providerId: string
      modelId: string
      enabled?: boolean | undefined
      capabilities?: readonly ModelCapability[] | undefined
    },
    context: OperationContext
  ): ProviderInfo {
    const database = this.options.database()
    this.provider(input.providerId, database)
    const model = database.providers.model(input.providerId, input.modelId)
    if (!model)
      throw new JupiterError(
        'MODEL_NOT_FOUND',
        `${input.modelId} is not set up for this provider.`,
        {
          category: 'validation',
          userAction: null
        }
      )
    const capabilities = input.capabilities ? unique(input.capabilities) : model.capabilities
    const enabling = input.enabled ?? model.enabled
    if (enabling && capabilities.length === 0)
      throw new JupiterError(
        'MODEL_CAPABILITIES_REQUIRED',
        `Choose what ${input.modelId} can do before using it.`,
        { category: 'validation', userAction: 'Select at least one capability, such as chat.' }
      )
    database.transactions.run(() => {
      database.providers.putModel({
        ...model,
        enabled: enabling,
        capabilities,
        capabilitySource: input.capabilities ? 'user' : model.capabilitySource,
        updatedAt: this.options.now().toISOString()
      })
      this.publishChange(input.providerId, 'models-changed', context)
    })
    return this.get(input.providerId)
  }

  // ---- routing ----------------------------------------------------------------------------

  route(
    capability: ModelCapability,
    conversation: Conversation | null,
    requires: readonly ModelCapability[] = []
  ): { result: RouteResult; mode: RoutingMode } {
    const database = this.options.database()
    const mode = this.modeFor(conversation)
    const preferredKey = PREFERRED_MODEL_SETTING[capability]
    const preferredRef = preferredKey ? this.options.setting(preferredKey) : null
    const pinnedRef = conversation?.routing.model ?? null
    const providers: RouterProvider[] = database.providers.list().map((stored) => ({
      providerId: stored.providerId,
      displayName: stored.displayName,
      locality: localityOf(stored.baseUrl),
      unusable: this.unusableReason(stored),
      models: database.providers.models(stored.providerId)
    }))
    const result = selectRoute({
      capability,
      requires,
      mode,
      fallbackPolicy: this.options.setting('ai.fallbackPolicy'),
      costLatency: this.options.setting('ai.costLatency'),
      preferredProvider: this.options.setting('ai.preferredProvider'),
      preferredModel: preferredRef ? parseModelRef(preferredRef) : null,
      pinnedModel: pinnedRef ? parseModelRef(pinnedRef) : null,
      providers
    })
    return { result, mode }
  }

  preview(capability: ModelCapability, conversation: Conversation | null): RoutePreview {
    const { result, mode } = this.route(capability, conversation)
    return result.ok
      ? { route: decisionOf(result.primary, capability, mode), problem: null }
      : { route: null, problem: result.error }
  }

  /** Read a provider's key for one request. Null when the provider has none. */
  async keyFor(
    providerId: string,
    correlationId: string,
    signal: AbortSignal
  ): Promise<string | null> {
    const stored = this.options.database().providers.get(providerId)
    if (!stored?.credentialId) return null
    return this.options.vault.read(stored.credentialId, correlationId, signal)
  }

  adapterContext(
    provider: Pick<StoredProvider, 'providerId' | 'displayName' | 'baseUrl'>,
    apiKey: string | null,
    mode: RoutingMode,
    operation: 'chat' | 'check' | 'validate-key' | 'embeddings',
    signal: AbortSignal,
    context: Pick<OperationContext, 'correlationId' | 'actor'>
  ): AdapterContext {
    return {
      providerName: provider.displayName,
      baseUrl: new URL(provider.baseUrl),
      apiKey,
      signal,
      transport: this.transport(provider, mode, operation, context)
    }
  }

  recordLatency(providerId: string, modelId: string, latencyMs: number): void {
    try {
      this.options
        .database()
        .providers.recordLatency(providerId, modelId, latencyMs, this.options.now().toISOString())
    } catch (error) {
      this.options.logger.debug('ai.latency.not-recorded', describeError(error))
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  private transport(
    provider: Pick<StoredProvider, 'providerId' | 'displayName'>,
    mode: RoutingMode,
    operation: 'chat' | 'check' | 'validate-key' | 'embeddings',
    context: Pick<OperationContext, 'correlationId' | 'actor'>
  ): Transport {
    // Local only on the whole of Jupiter always wins, whatever the conversation says.
    const effective = this.mode() === 'LOCAL_ONLY' ? 'LOCAL_ONLY' : mode
    return createTransport({
      fetch: this.options.fetch,
      mode: effective,
      providerName: provider.displayName,
      onBlocked: () => {
        this.recordBlocked(provider.providerId, effective, operation, context)
      }
    })
  }

  private recordBlocked(
    providerId: string,
    mode: RoutingMode,
    operation: 'chat' | 'check' | 'validate-key' | 'embeddings',
    context: Pick<OperationContext, 'correlationId' | 'actor'>
  ): void {
    try {
      this.options.bus.publish({
        type: 'ai.route.blocked',
        stream: { kind: 'ai', id: 'routing' },
        payload: { providerId, locality: 'cloud', mode, operation },
        persistent: true,
        correlationId: context.correlationId,
        actor: context.actor
      })
    } catch (error) {
      this.options.logger.warn('ai.blocked.not-recorded', describeError(error))
    }
  }

  private publishChange(
    providerId: string,
    change:
      'added' | 'updated' | 'removed' | 'key-saved' | 'key-removed' | 'checked' | 'models-changed',
    context: OperationContext,
    state: ProviderState | null = this.stateOf(providerId)
  ): void {
    this.options.bus.publish({
      type: 'ai.provider.changed',
      stream: { kind: 'ai', id: 'providers' },
      payload: { providerId, change, state },
      persistent: true,
      correlationId: context.correlationId,
      actor: context.actor
    })
  }

  private stateOf(providerId: string): ProviderState | null {
    const database = this.options.database()
    const stored = database.providers.get(providerId)
    return stored ? this.toInfo(stored, database).state : null
  }

  private provider(providerId: string, database: DatabasePort): StoredProvider {
    const stored = database.providers.get(providerId)
    if (!stored)
      throw new JupiterError('PROVIDER_NOT_FOUND', 'That provider is not set up.', {
        category: 'validation',
        userAction: 'Reload AI models.'
      })
    return stored
  }

  private unusableReason(stored: StoredProvider): string | null {
    const adapter = this.adapters.get(stored.adapterId)
    if (!stored.enabled) return 'it is turned off'
    if (!adapter) return `its adapter (${stored.adapterId}) is not installed in this build`
    if (adapter.info.keyRequirement === 'required' && !stored.credentialId)
      return 'it needs an API key'
    if (stored.credentialValidation === 'rejected') return 'it rejected the saved API key'
    return null
  }

  private toInfo(stored: StoredProvider, database: DatabasePort): ProviderInfo {
    const adapter = this.adapters.get(stored.adapterId)
    const locality = localityOf(stored.baseUrl)
    let state: ProviderState
    if (!adapter) state = 'adapter-missing'
    else if (this.mode() === 'LOCAL_ONLY' && locality !== 'this-device') state = 'blocked'
    else if (adapter.info.keyRequirement === 'required' && !stored.credentialId) state = 'needs-key'
    else state = stored.checkState
    const models: ModelInfo[] = database.providers.models(stored.providerId)
    return {
      providerId: stored.providerId,
      adapterId: stored.adapterId,
      displayName: stored.displayName,
      baseUrl: stored.baseUrl,
      locality,
      encrypted: isProtectedTransport(stored.baseUrl),
      enabled: stored.enabled,
      state,
      error: state === 'failed' ? stored.error : null,
      checkedAt: stored.checkedAt,
      credential: {
        saved: stored.credentialId !== null,
        fingerprint: stored.credentialFingerprint,
        savedAt: stored.credentialSavedAt,
        validation: stored.credentialValidation,
        lastValidatedAt: stored.credentialValidatedAt
      },
      models,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    }
  }
}

const PREFERRED_MODEL_SETTING: Partial<
  Record<
    ModelCapability,
    | 'ai.preferredChatModel'
    | 'ai.preferredReasoningModel'
    | 'ai.preferredVisionModel'
    | 'ai.preferredEmbeddingModel'
  >
> = {
  chat: 'ai.preferredChatModel',
  reasoning: 'ai.preferredReasoningModel',
  vision: 'ai.preferredVisionModel',
  embeddings: 'ai.preferredEmbeddingModel'
}

const fallbackEnvelope = {
  code: 'PROVIDER_CHECK_FAILED',
  category: 'provider' as const,
  userAction: 'Check the provider address and try again.',
  retryable: true
}

function allowedNow(mode: RoutingMode, baseUrl: string): boolean {
  return mode !== 'LOCAL_ONLY' || localityOf(baseUrl) === 'this-device'
}

function unique(capabilities: readonly ModelCapability[]): ModelCapability[] {
  return [...new Set(capabilities)]
}

function adapterMissing(adapterId: string): JupiterError {
  return new JupiterError(
    'ADAPTER_NOT_INSTALLED',
    `The provider adapter "${adapterId}" is not installed in this build of Jupiter.`,
    {
      category: 'configuration',
      userAction: 'Remove this provider, or install a Jupiter build that includes the adapter.'
    }
  )
}

function insecureKeyAddress(providerName: string): JupiterError {
  return new JupiterError(
    'INSECURE_TRANSPORT',
    `${providerName} uses http:// to another computer, so an API key sent to it could be read on the way. Jupiter does not send keys that way.`,
    {
      category: 'configuration',
      userAction: 'Change the address to https://, or use a provider on this computer.'
    }
  )
}
