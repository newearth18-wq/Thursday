import type {
  Actor,
  AuditEvent,
  BackupInfo,
  ChatMessage,
  Conversation,
  ConversationRouting,
  CredentialInfo,
  ErrorEnvelope,
  ModelCapability,
  ModelInfo,
  DatabaseInfo,
  DomainEvent,
  DomainEventType,
  EventFilter,
  ServiceHealth,
  StreamRef
} from '@jupiter/contracts'

/**
 * Repository interfaces (ports). Jupiter Core depends only on these; the
 * SQLite implementation lives in @jupiter/database. Everything here is
 * synchronous on purpose: a transaction can never span an `await`, so it can
 * never interleave with other work and leave half-written state behind.
 */

export interface TransactionRunner {
  /** Run `fn` atomically. Nested calls become savepoints. `fn` must be synchronous. */
  run<T>(fn: () => T): T
  /** Run `fn` once the outermost transaction commits; dropped if it rolls back. Runs now outside a transaction. */
  afterCommit(fn: () => void): void
  readonly active: boolean
}

/** A persistent event before the store assigns its sequence numbers. */
export interface NewPersistentEvent {
  readonly eventId: string
  readonly type: DomainEventType
  readonly stream: StreamRef
  readonly occurredAt: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly actor: Actor
  readonly missionId: string | null
  readonly executionId: string | null
  readonly payload: unknown
}

export interface EventStore {
  /** Append inside the current transaction; assigns the next stream and global sequence. */
  append(event: NewPersistentEvent): { streamSequence: number; globalSequence: number }
  /** Events with a global sequence greater than `after`, oldest first. */
  readAfter(after: number, filter: EventFilter, limit: number): DomainEvent[]
  /** The most recent `limit` matching events, oldest first. */
  readLatest(filter: EventFilter, limit: number): DomainEvent[]
  /** Number of matching events with a global sequence greater than `after`. */
  countAfter(after: number, filter: EventFilter): number
  latestSequence(): number
  count(): number
}

export interface StoredSetting {
  readonly key: string
  readonly value: unknown
  readonly updatedAt: string
  readonly updatedBy: Actor
}

export interface SettingsStore {
  list(): StoredSetting[]
  get(key: string): StoredSetting | null
  put(key: string, value: unknown, actor: Actor, at: string): void
}

export interface AuditStore {
  append(entry: AuditEvent): void
  recent(limit: number): AuditEvent[]
  count(): number
}

export interface ServiceHealthStore {
  upsert(health: ServiceHealth, process: 'host' | 'core', at: string): void
  list(): (ServiceHealth & { process: 'host' | 'core' })[]
}

/** The last real check of a provider, as stored. Other states are derived when read. */
export type StoredCheckState = 'not-checked' | 'ready' | 'failed'

export interface StoredProvider {
  readonly providerId: string
  readonly adapterId: string
  readonly displayName: string
  readonly baseUrl: string
  readonly enabled: boolean
  readonly checkState: StoredCheckState
  readonly error: ErrorEnvelope | null
  readonly checkedAt: string | null
  /** Where the key lives in the host's secure storage. The key itself is never in the database. */
  readonly credentialId: string | null
  readonly credentialFingerprint: string | null
  readonly credentialSavedAt: string | null
  readonly credentialValidation: CredentialInfo['validation']
  readonly credentialValidatedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** A model as the provider's model list reports it. */
export interface DiscoveredModel {
  readonly modelId: string
  readonly displayName: string | null
  /** Capabilities the provider itself reports; null when it does not say. */
  readonly capabilities: readonly ModelCapability[] | null
  readonly contextWindow: number | null
  readonly inputCostPerMillion: number | null
  readonly outputCostPerMillion: number | null
}

export interface ProviderStore {
  list(): StoredProvider[]
  get(providerId: string): StoredProvider | null
  insert(provider: StoredProvider): void
  update(
    providerId: string,
    changes: Partial<Omit<StoredProvider, 'providerId' | 'createdAt'>>
  ): void
  /** Removes the provider and its models. */
  remove(providerId: string): boolean
  models(providerId: string): ModelInfo[]
  model(providerId: string, modelId: string): ModelInfo | null
  putModel(model: ModelInfo): void
  /**
   * Record the provider's current model list. New models are added disabled;
   * what the person chose for known models (enabled, capabilities) is kept.
   * Models that disappeared from the list stay, so nothing the person set up
   * is lost silently. Returns how many models were new.
   */
  mergeDiscovered(providerId: string, models: readonly DiscoveredModel[], at: string): number
  recordLatency(providerId: string, modelId: string, latencyMs: number, at: string): void
}

export interface NewConversation {
  readonly conversationId: string
  readonly title: string
  readonly routing: ConversationRouting
  readonly createdAt: string
}

export type MessageChanges = Partial<
  Pick<
    ChatMessage,
    'parts' | 'status' | 'route' | 'usage' | 'finishReason' | 'error' | 'completedAt'
  >
>

export interface ChatStore {
  listConversations(limit: number): Conversation[]
  conversation(conversationId: string): Conversation | null
  insertConversation(conversation: NewConversation): void
  updateConversation(
    conversationId: string,
    changes: { title?: string; routing?: ConversationRouting; updatedAt: string }
  ): void
  /** Removes the conversation and its messages. Only ever called for an explicit request. */
  deleteConversation(conversationId: string): boolean
  /** The most recent `limit` messages, oldest first. */
  messages(conversationId: string, limit: number): ChatMessage[]
  message(messageId: string): ChatMessage | null
  nextSeq(conversationId: string): number
  insertMessage(message: ChatMessage): void
  updateMessage(messageId: string, changes: MessageChanges): void
  supersede(messageIds: readonly string[], by: string): void
  /** Messages still marked `streaming` (after a crash). */
  streaming(): ChatMessage[]
}

export interface BackupOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (copiedPages: number, totalPages: number) => void
}

export interface DatabasePort {
  readonly transactions: TransactionRunner
  readonly events: EventStore
  readonly settings: SettingsStore
  readonly audit: AuditStore
  readonly serviceHealth: ServiceHealthStore
  readonly providers: ProviderStore
  readonly chat: ChatStore
  info(): DatabaseInfo
  backup(reason: BackupInfo['reason'], options?: BackupOptions): Promise<BackupInfo>
  close(): void
}
