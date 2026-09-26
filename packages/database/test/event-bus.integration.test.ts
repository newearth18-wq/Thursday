import { join } from 'node:path'
import { MATCH_ALL_EVENTS, type DomainEvent } from '@jupiter/contracts'
import { EventBus, Logger, MemorySink, uuidv7 } from '@jupiter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { tempDirectory } from './support/helpers'

/**
 * SET 1 acceptance test 5 — event ordering is stable within one Mission —
 * against the real SQLite store, with many concurrent publishers, and across a
 * restart of the database.
 */

let dir: string
let cleanup: () => void
let database: JupiterDatabase
let bus: EventBus

async function open() {
  database = (
    await JupiterDatabase.open({
      path: join(dir, 'jupiter.db'),
      backupDirectory: join(dir, 'backups')
    })
  ).database
  bus = new EventBus(
    Logger.create({ sessionId: uuidv7(), level: 'info', sinks: [new MemorySink()] })
  )
  bus.attachStore(database.events, database.transactions)
}

beforeEach(async () => {
  ;({ dir, cleanup } = tempDirectory())
  await open()
})

afterEach(() => {
  database.close()
  cleanup()
})

const missions = ['mission-a', 'mission-b', 'mission-c']

function publishFor(missionId: string, step: number) {
  return bus.publish({
    type: 'settings.changed',
    stream: { kind: 'mission', id: missionId },
    payload: { key: 'step', previousValue: step - 1, value: step },
    persistent: true,
    correlationId: uuidv7(),
    actor: { type: 'core', id: 'test' },
    missionId
  })
}

function assertOrdered(events: readonly DomainEvent[], perMission: number) {
  for (const missionId of missions) {
    const stream = events.filter((event) => event.missionId === missionId)
    expect(stream.map((event) => event.streamSequence)).toEqual(
      Array.from({ length: perMission }, (_, i) => i + 1)
    )
    expect(
      stream.map((event) => (event.type === 'settings.changed' ? event.payload.value : null))
    ).toEqual(Array.from({ length: perMission }, (_, i) => i + 1))
  }
  const globals = events.map((event) => event.globalSequence ?? 0)
  expect(globals).toEqual([...globals].sort((a, b) => a - b))
  expect(new Set(globals).size).toBe(globals.length)
}

describe('event ordering within a Mission (real SQLite)', () => {
  it('keeps each Mission gap-free and in order under concurrent publishers, and after reopening', async () => {
    const delivered: DomainEvent[] = []
    bus.subscribe(
      'observer',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      (event) => delivered.push(event)
    )

    const perMission = 60
    // Three concurrent workers per Mission-set, interleaving on every await.
    await Promise.all(
      missions.map(async (missionId) => {
        for (let step = 1; step <= perMission; step++) {
          publishFor(missionId, step)
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 2))
        }
      })
    )

    expect(delivered).toHaveLength(missions.length * perMission)
    assertOrdered(delivered, perMission)

    database.close()
    await open()
    const stored = database.events.readAfter(0, MATCH_ALL_EVENTS, 1000)
    assertOrdered(stored, perMission)
    expect(stored.map((event) => event.eventId)).toEqual(delivered.map((event) => event.eventId))
  })

  it('lets a disconnected subscriber resume from its cursor without gaps or duplicates', () => {
    const first: number[] = []
    bus.subscribe(
      'ui-1',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      (event) => first.push(event.globalSequence ?? 0)
    )
    for (let step = 1; step <= 5; step++) publishFor('mission-a', step)
    bus.unsubscribe('ui-1')
    const cursor = first.at(-1) ?? 0

    for (let step = 6; step <= 9; step++) publishFor('mission-a', step)

    const resumed: number[] = []
    const receipt = bus.subscribe(
      'ui-2',
      { afterSequence: cursor, replayLimit: 100, filter: MATCH_ALL_EVENTS },
      (event) => resumed.push(event.globalSequence ?? 0)
    )
    publishFor('mission-a', 10)

    expect(receipt).toMatchObject({ replayed: 4, truncated: false })
    expect([...first, ...resumed]).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
  })
})
