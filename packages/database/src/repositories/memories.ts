import type { DatabaseSync } from 'node:sqlite'
import {
  MemoryDecisionRecord,
  MemoryEntry,
  MemoryRetention,
  MemorySource,
  MemoryType
} from '@jupiter/contracts'
import type { MemoryStore, StoredMemory } from '@jupiter/core'
import { integer, json, nullableText, text } from '../rows'

type Row = Record<string, unknown>

const Kinds = MemoryEntry.shape.sensitiveKinds
const Tags = MemoryEntry.shape.tags
const Relationships = MemoryEntry.shape.relationships

function vectorOf(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  )
    throw new Error('A stored embedding is not a list of numbers')
  return value as number[]
}

/** Long-term memory (SET 11). Rows are validated when read. */
export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(memory: StoredMemory): void {
    this.db
      .prepare(
        `INSERT INTO memories (memory_id, type, content, sealed, content_key, sensitivity,
           sensitive_kinds_json, source_json, tags_json, relationships_json, retention_json,
           expires_at, confidence, importance, state, corrections, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...this.values(memory))
  }

  update(memory: StoredMemory): void {
    const [memoryId, ...rest] = this.values(memory)
    this.db
      .prepare(
        `UPDATE memories SET type = ?, content = ?, sealed = ?, content_key = ?, sensitivity = ?,
           sensitive_kinds_json = ?, source_json = ?, tags_json = ?, relationships_json = ?,
           retention_json = ?, expires_at = ?, confidence = ?, importance = ?, state = ?,
           corrections = ?, created_at = ?, updated_at = ?
         WHERE memory_id = ?`
      )
      .run(...rest, memoryId)
    // A corrected memory's old embeddings describe the old content.
    this.db
      .prepare('DELETE FROM memory_embeddings WHERE memory_id = ? AND content_key IS NOT ?')
      .run(memory.memoryId, memory.contentKey ?? '')
  }

  get(memoryId: string): StoredMemory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(memoryId)
    return row ? toMemory(row) : null
  }

  all(includeForgotten: boolean): StoredMemory[] {
    return this.db
      .prepare(
        `SELECT * FROM memories ${includeForgotten ? '' : "WHERE state = 'active'"}
         ORDER BY created_at, memory_id`
      )
      .all()
      .map(toMemory)
  }

  byContentKey(contentKey: string): StoredMemory | null {
    const row = this.db
      .prepare('SELECT * FROM memories WHERE content_key = ? ORDER BY created_at LIMIT 1')
      .get(contentKey)
    return row ? toMemory(row) : null
  }

  delete(memoryId: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE memory_id = ?').run(memoryId)
    return Number(result.changes) > 0
  }

  expire(now: string): string[] {
    const rows = this.db
      .prepare('SELECT memory_id FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now)
    const ids = rows.map((row) => text(row, 'memory_id'))
    for (const id of ids) this.delete(id)
    return ids
  }

  embedding(memoryId: string, modelKey: string): { contentKey: string; vector: number[] } | null {
    const row = this.db
      .prepare('SELECT * FROM memory_embeddings WHERE memory_id = ? AND model_key = ?')
      .get(memoryId, modelKey)
    if (!row) return null
    return { contentKey: text(row, 'content_key'), vector: vectorOf(json(row, 'vector_json')) }
  }

  putEmbedding(
    memoryId: string,
    modelKey: string,
    contentKey: string,
    vector: readonly number[]
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_embeddings (memory_id, model_key, content_key, vector_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (memory_id, model_key) DO UPDATE SET content_key = excluded.content_key,
           vector_json = excluded.vector_json`
      )
      .run(memoryId, modelKey, contentKey, JSON.stringify(vector))
  }

  eraseRemnants(): void {
    // Old copies of changed pages live in the write-ahead log until it is checkpointed.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  recordDecision(record: MemoryDecisionRecord): void {
    const valid = MemoryDecisionRecord.parse(record)
    this.db
      .prepare(
        `INSERT INTO memory_decisions (decision_id, decided_at, decision, decided_by, record_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        valid.decisionId,
        valid.decidedAt,
        valid.decision,
        valid.decidedBy,
        JSON.stringify(valid)
      )
  }

  decisions(limit: number): MemoryDecisionRecord[] {
    return this.db
      .prepare(
        'SELECT record_json FROM memory_decisions ORDER BY decided_at DESC, decision_id DESC LIMIT ?'
      )
      .all(limit)
      .map((row) => MemoryDecisionRecord.parse(json(row, 'record_json')))
  }

  private values(memory: StoredMemory) {
    const retention = MemoryRetention.parse(memory.retention)
    return [
      memory.memoryId,
      MemoryType.parse(memory.type),
      memory.content,
      memory.sealed,
      memory.contentKey,
      memory.sensitivity,
      JSON.stringify(Kinds.parse(memory.sensitiveKinds)),
      JSON.stringify(MemorySource.parse(memory.source)),
      JSON.stringify(Tags.parse(memory.tags)),
      JSON.stringify(Relationships.parse(memory.relationships)),
      JSON.stringify(retention),
      retention.kind === 'until' ? retention.expiresAt : null,
      memory.confidence,
      memory.importance,
      memory.state,
      memory.corrections,
      memory.createdAt,
      memory.updatedAt
    ] as const
  }
}

function toMemory(row: Row): StoredMemory {
  const sensitivity = text(row, 'sensitivity')
  const state = text(row, 'state')
  return {
    memoryId: text(row, 'memory_id'),
    type: MemoryType.parse(text(row, 'type')),
    content: nullableText(row, 'content'),
    sealed: nullableText(row, 'sealed'),
    contentKey: nullableText(row, 'content_key'),
    sensitivity: sensitivity === 'sensitive' ? 'sensitive' : 'normal',
    sensitiveKinds: Kinds.parse(json(row, 'sensitive_kinds_json')),
    source: MemorySource.parse(json(row, 'source_json')),
    tags: Tags.parse(json(row, 'tags_json')),
    relationships: Relationships.parse(json(row, 'relationships_json')),
    retention: MemoryRetention.parse(json(row, 'retention_json')),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    state: state === 'forgotten' ? 'forgotten' : 'active',
    corrections: integer(row, 'corrections'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at')
  }
}
