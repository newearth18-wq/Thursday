import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryDecisionRecord } from '@jupiter/contracts'
import type { StoredMemory } from '@jupiter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

/**
 * SET 11 tables on real SQLite files: long-term memories (a sensitive one
 * keeps only its sealed form), their embeddings (normal memories only) and
 * the append-only log of policy decisions. Deleting a memory leaves no copy
 * of its content in the database files.
 */

let dir: string
let cleanup: () => void
const opened: JupiterDatabase[] = []

beforeEach(() => {
  ;({ dir, cleanup } = tempDirectory())
})

afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  cleanup()
})

async function open(): Promise<JupiterDatabase> {
  const { database } = await JupiterDatabase.open({
    path: join(dir, 'jupiter.db'),
    backupDirectory: join(dir, 'backups')
  })
  opened.push(database)
  return database
}

/** Every byte of the database and its journal. */
function onDisk(): string {
  return readdirSync(dir)
    .filter((name) => name.startsWith('jupiter.db'))
    .map((name) => readFileSync(join(dir, name)).toString('latin1'))
    .join('\n')
}

const NORMAL = '01a0d82f-22b6-762b-b369-29675d971001'
const SENSITIVE = '01a0d82f-22b6-762b-b369-29675d971002'
const KEY = 'b'.repeat(64)

const memory = (overrides: Partial<StoredMemory> = {}): StoredMemory => ({
  memoryId: NORMAL,
  type: 'preferences',
  content: 'Prefers the Zephyrine colour scheme in every editor.',
  sealed: null,
  contentKey: KEY,
  sensitivity: 'normal',
  sensitiveKinds: [],
  source: { kind: 'user', label: 'You', ref: null },
  tags: ['editor'],
  relationships: [],
  retention: { kind: 'long-term' },
  confidence: 1,
  importance: 0.5,
  state: 'active',
  corrections: 0,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
  ...overrides
})

const decision = (overrides: Partial<MemoryDecisionRecord> = {}): MemoryDecisionRecord => ({
  decisionId: '01a0d82f-22b6-762b-b369-29675d971101',
  decidedAt: '2026-09-27T10:00:00.000Z',
  decision: 'SAVE',
  decidedBy: 'policy',
  reasons: ['explicit-request'],
  type: 'preferences',
  sourceKind: 'user',
  sensitivity: 'normal',
  sensitiveKinds: [],
  memoryId: NORMAL,
  candidateId: null,
  ...overrides
})

describe('memories (SET 11)', () => {
  it('stores a memory and reads it back after reopening, validated', async () => {
    const database = await open()
    database.memories.insert(memory())
    database.close()
    opened.length = 0
    const reopened = await open()
    expect(reopened.memories.get(NORMAL)).toEqual(memory())
    expect(reopened.memories.byContentKey(KEY)?.memoryId).toBe(NORMAL)
  })

  it('keeps no readable content for a sensitive memory, and never embeds it', async () => {
    const database = await open()
    const sealed = memory({
      memoryId: SENSITIVE,
      content: null,
      sealed: 'c2VhbGVkLWJ5LXRoZS1vcGVyYXRpbmctc3lzdGVt',
      contentKey: null,
      sensitivity: 'sensitive',
      sensitiveKinds: ['financial']
    })
    database.memories.insert(sealed)
    expect(database.memories.get(SENSITIVE)).toEqual(sealed)
    // The schema itself refuses a sensitive memory with readable content or a content key.
    const db = raw(join(dir, 'jupiter.db'))
    try {
      expect(() =>
        db.prepare("UPDATE memories SET content = 'readable' WHERE memory_id = ?").run(SENSITIVE)
      ).toThrow(/CHECK constraint failed/)
      expect(() =>
        db.prepare('UPDATE memories SET content_key = ? WHERE memory_id = ?').run(KEY, SENSITIVE)
      ).toThrow(/CHECK constraint failed/)
    } finally {
      db.close()
    }
    expect(() => {
      database.memories.putEmbedding(SENSITIVE, 'model', 'x', [0.1, 0.2])
    }).toThrow(/never embedded/)
  })

  it('drops a stale embedding when the content changes, and deletes leave no copy on disk', async () => {
    const database = await open()
    database.memories.insert(memory())
    database.memories.putEmbedding(NORMAL, 'local/embed', KEY, [0.5, 0.25])
    expect(database.memories.embedding(NORMAL, 'local/embed')).toEqual({
      contentKey: KEY,
      vector: [0.5, 0.25]
    })
    database.memories.update(
      memory({
        content: 'Prefers the Quillmoor colour scheme in every editor.',
        contentKey: 'c'.repeat(64),
        corrections: 1,
        updatedAt: '2026-09-27T11:00:00.000Z'
      })
    )
    expect(database.memories.embedding(NORMAL, 'local/embed')).toBeNull()
    database.memories.eraseRemnants()
    expect(onDisk().includes('Zephyrine')).toBe(false)

    expect(database.memories.delete(NORMAL)).toBe(true)
    database.memories.eraseRemnants()
    expect(database.memories.get(NORMAL)).toBeNull()
    expect(onDisk().includes('Quillmoor')).toBe(false)
  })

  it('removes memories whose retention ended, and only those', async () => {
    const database = await open()
    database.memories.insert(
      memory({ retention: { kind: 'until', expiresAt: '2026-09-28T00:00:00.000Z' } })
    )
    database.memories.insert(
      memory({ memoryId: SENSITIVE, content: 'Kept for good.', contentKey: 'd'.repeat(64) })
    )
    expect(database.memories.expire('2026-09-27T23:59:59.000Z')).toEqual([])
    expect(database.memories.expire('2026-09-28T00:00:00.000Z')).toEqual([NORMAL])
    expect(database.memories.all(true).map((item) => item.memoryId)).toEqual([SENSITIVE])
  })

  it('records policy decisions without content, and never changes or deletes them', async () => {
    const database = await open()
    database.memories.recordDecision(decision())
    database.memories.recordDecision(
      decision({
        decisionId: '01a0d82f-22b6-762b-b369-29675d971102',
        decidedAt: '2026-09-27T10:05:00.000Z',
        decision: 'DO_NOT_SAVE',
        reasons: ['credential'],
        memoryId: null
      })
    )
    expect(database.memories.decisions(10).map((item) => item.decision)).toEqual([
      'DO_NOT_SAVE',
      'SAVE'
    ])
    const db = raw(join(dir, 'jupiter.db'))
    try {
      expect(() => db.prepare("UPDATE memory_decisions SET decision = 'SAVE'").run()).toThrow(
        /never changed/
      )
      expect(() => db.prepare('DELETE FROM memory_decisions').run()).toThrow(/never deleted/)
    } finally {
      db.close()
    }
  })
})
