import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@jupiter/core'
import { MATCH_ALL_EVENTS, type StreamRef } from '@jupiter/contracts'
import { JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

let dir: string
let cleanup: () => void
let database: JupiterDatabase

beforeEach(async () => {
  ;({ dir, cleanup } = tempDirectory())
  database = (
    await JupiterDatabase.open({
      path: join(dir, 'jupiter.db'),
      backupDirectory: join(dir, 'backups')
    })
  ).database
})

afterEach(() => {
  database.close()
  cleanup()
})

function append(stream: StreamRef, missionId: string | null = null) {
  return database.transactions.run(() =>
    database.events.append({
      eventId: uuidv7(),
      type: 'core.stopped',
      stream,
      occurredAt: new Date().toISOString(),
      correlationId: uuidv7(),
      causationId: null,
      actor: { type: 'core', id: 'test' },
      missionId,
      executionId: null,
      payload: { reason: 'shutdown' }
    })
  )
}

describe('SqliteEventStore', () => {
  it('numbers each stream 1, 2, 3 … independently, with a global order across streams', () => {
    const a = { kind: 'mission', id: 'mission-a' } as const
    const b = { kind: 'mission', id: 'mission-b' } as const
    const results = [
      append(a, 'mission-a'),
      append(b, 'mission-b'),
      append(a, 'mission-a'),
      append(a, 'mission-a'),
      append(b, 'mission-b')
    ]
    expect(results.map((result) => result.streamSequence)).toEqual([1, 1, 2, 3, 2])
    expect(results.map((result) => result.globalSequence)).toEqual([1, 2, 3, 4, 5])

    const onlyA = database.events.readAfter(0, { ...MATCH_ALL_EVENTS, missionId: 'mission-a' }, 10)
    expect(onlyA.map((event) => event.streamSequence)).toEqual([1, 2, 3])
    expect(
      database.events.readAfter(3, MATCH_ALL_EVENTS, 10).map((event) => event.globalSequence)
    ).toEqual([4, 5])
    expect(
      database.events.readLatest(MATCH_ALL_EVENTS, 2).map((event) => event.globalSequence)
    ).toEqual([4, 5])
    expect(database.events.countAfter(2, { ...MATCH_ALL_EVENTS, streams: [b] })).toBe(1)
  })

  it('never reuses a global sequence, even after a rolled-back append', () => {
    append({ kind: 'system', id: 'core' })
    expect(() =>
      database.transactions.run(() => {
        append({ kind: 'system', id: 'core' })
        throw new Error('roll back')
      })
    ).toThrow()
    const next = append({ kind: 'system', id: 'core' })
    expect(next.streamSequence).toBe(2)
    expect(
      database.events.readAfter(0, MATCH_ALL_EVENTS, 10).map((event) => event.streamSequence)
    ).toEqual([1, 2])
  })

  it('skips stored rows that no longer match the event contract', () => {
    append({ kind: 'system', id: 'core' })
    const db = raw(join(dir, 'jupiter.db'))
    db.exec(`INSERT INTO event_streams VALUES ('system', 'tampered', 1, 'now')`)
    db.exec(
      `INSERT INTO events (event_id, schema_version, type, stream_kind, stream_id, stream_sequence, occurred_at, recorded_at, correlation_id, actor_json, payload_json)
       VALUES ('x', 1, 'core.exploded', 'system', 'tampered', 1, 'now', 'now', 'c', '{}', '{}')`
    )
    db.close()
    const events = database.events.readAfter(0, MATCH_ALL_EVENTS, 10)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('core.stopped')
  })
})
