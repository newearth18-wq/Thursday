import type {
  Actor,
  AuditEvent,
  BackupInfo,
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
  info(): DatabaseInfo
  backup(reason: BackupInfo['reason'], options?: BackupOptions): Promise<BackupInfo>
  close(): void
}
