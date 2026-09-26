import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { CONTRACT_VERSION, DomainEvent, type EventFilter } from '@jupiter/contracts'
import {
  JupiterError,
  type EventStore,
  type NewPersistentEvent,
  type TransactionRunner
} from '@jupiter/core'
import { integer, json, nullableText, text } from '../rows'

/**
 * The durable event log.
 *
 * Appending takes the next sequence of the event's stream from
 * `event_streams` and inserts the event in the same transaction, so stream
 * sequences are gap-free and unique (enforced again by a UNIQUE constraint).
 * The global sequence (an AUTOINCREMENT key) is never reused.
 *
 * Every row read back is validated against the versioned event contract; a
 * row that fails validation is reported and skipped rather than passed on.
 */
export class SqliteEventStore implements EventStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transactions: TransactionRunner,
    private readonly onInvalidRow: (globalSequence: number, problem: string) => void = () =>
      undefined,
    private readonly now: () => Date = () => new Date()
  ) {}

  append(event: NewPersistentEvent): { streamSequence: number; globalSequence: number } {
    if (!this.transactions.active) {
      throw new JupiterError(
        'EVENT_APPEND_OUTSIDE_TRANSACTION',
        'Events must be appended inside a transaction.',
        {
          category: 'internal',
          userAction: null
        }
      )
    }
    const recordedAt = this.now().toISOString()
    const stream = this.db
      .prepare(
        `INSERT INTO event_streams (stream_kind, stream_id, last_sequence, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (stream_kind, stream_id) DO UPDATE SET last_sequence = last_sequence + 1
         RETURNING last_sequence`
      )
      .get(event.stream.kind, event.stream.id, recordedAt)
    if (!stream) throw new Error('Could not advance the event stream sequence')
    const streamSequence = integer(stream, 'last_sequence')
    const inserted = this.db
      .prepare(
        `INSERT INTO events (
           event_id, schema_version, type, stream_kind, stream_id, stream_sequence, occurred_at, recorded_at,
           correlation_id, causation_id, actor_json, mission_id, execution_id, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING global_sequence`
      )
      .get(
        event.eventId,
        CONTRACT_VERSION,
        event.type,
        event.stream.kind,
        event.stream.id,
        streamSequence,
        event.occurredAt,
        recordedAt,
        event.correlationId,
        event.causationId,
        JSON.stringify(event.actor),
        event.missionId,
        event.executionId,
        JSON.stringify(event.payload)
      )
    if (!inserted) throw new Error('Could not insert the event')
    return { streamSequence, globalSequence: integer(inserted, 'global_sequence') }
  }

  readAfter(after: number, filter: EventFilter, limit: number): DomainEvent[] {
    const { where, params } = whereClause(filter)
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE global_sequence > ? ${where} ORDER BY global_sequence ASC LIMIT ?`
      )
      .all(after, ...params, limit)
    return this.parseRows(rows)
  }

  readLatest(filter: EventFilter, limit: number): DomainEvent[] {
    const { where, params } = whereClause(filter)
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE 1 = 1 ${where} ORDER BY global_sequence DESC LIMIT ?`)
      .all(...params, limit)
    return this.parseRows(rows.reverse())
  }

  countAfter(after: number, filter: EventFilter): number {
    const { where, params } = whereClause(filter)
    const row = this.db
      .prepare(`SELECT count(*) AS n FROM events WHERE global_sequence > ? ${where}`)
      .get(after, ...params)
    return row ? integer(row, 'n') : 0
  }

  latestSequence(): number {
    const row = this.db
      .prepare('SELECT coalesce(max(global_sequence), 0) AS latest FROM events')
      .get()
    return row ? integer(row, 'latest') : 0
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM events').get()
    return row ? integer(row, 'n') : 0
  }

  private parseRows(rows: Record<string, unknown>[]): DomainEvent[] {
    const events: DomainEvent[] = []
    for (const row of rows) {
      const globalSequence = integer(row, 'global_sequence')
      try {
        const parsed = DomainEvent.safeParse({
          v: integer(row, 'schema_version'),
          eventId: text(row, 'event_id'),
          type: text(row, 'type'),
          stream: { kind: text(row, 'stream_kind'), id: text(row, 'stream_id') },
          streamSequence: integer(row, 'stream_sequence'),
          globalSequence,
          persistent: true,
          occurredAt: text(row, 'occurred_at'),
          correlationId: text(row, 'correlation_id'),
          causationId: nullableText(row, 'causation_id'),
          actor: json(row, 'actor_json'),
          missionId: nullableText(row, 'mission_id'),
          executionId: nullableText(row, 'execution_id'),
          payload: json(row, 'payload_json')
        })
        if (parsed.success) events.push(parsed.data)
        else
          this.onInvalidRow(
            globalSequence,
            parsed.error.issues.map((issue) => issue.message).join('; ')
          )
      } catch (error) {
        this.onInvalidRow(globalSequence, error instanceof Error ? error.message : String(error))
      }
    }
    return events
  }
}

function whereClause(filter: EventFilter): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  if (filter.types) {
    clauses.push(`type IN (${filter.types.map(() => '?').join(', ')})`)
    params.push(...filter.types)
  }
  if (filter.streams) {
    clauses.push(
      `(${filter.streams.map(() => '(stream_kind = ? AND stream_id = ?)').join(' OR ')})`
    )
    for (const stream of filter.streams) params.push(stream.kind, stream.id)
  }
  if (filter.missionId) {
    clauses.push('mission_id = ?')
    params.push(filter.missionId)
  }
  return { where: clauses.map((clause) => `AND ${clause}`).join(' '), params }
}
