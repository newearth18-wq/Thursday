import { MATCH_ALL_EVENTS, type DomainEvent, type EventFilter } from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { uuidv7 } from '../ids'
import { Logger, MemorySink } from '../logging/logger'
import type { EventStore, NewPersistentEvent, TransactionRunner } from '../ports'
import { EventBus, matchesFilter } from './event-bus'

/** In-memory store and transactions with the same semantics as the SQLite ones. */
class MemoryStore implements EventStore, TransactionRunner {
  events: DomainEvent[] = []
  private streams = new Map<string, number>()
  private depth = 0
  private hooks: (() => void)[] = []
  private staged: DomainEvent[] = []

  get active() {
    return this.depth > 0
  }

  run<T>(fn: () => T): T {
    this.depth++
    const mark = this.staged.length
    const hookMark = this.hooks.length
    const streams = new Map(this.streams)
    try {
      const result = fn()
      this.depth--
      if (this.depth === 0) {
        this.events.push(...this.staged.splice(0))
        for (const hook of this.hooks.splice(0)) hook()
      }
      return result
    } catch (error) {
      this.depth--
      this.staged.length = mark
      this.hooks.length = hookMark
      this.streams = streams
      throw error
    }
  }

  afterCommit(fn: () => void): void {
    if (this.depth === 0) fn()
    else this.hooks.push(fn)
  }

  append(event: NewPersistentEvent) {
    const key = `${event.stream.kind}/${event.stream.id}`
    const streamSequence = (this.streams.get(key) ?? 0) + 1
    this.streams.set(key, streamSequence)
    const globalSequence = this.events.length + this.staged.length + 1
    this.staged.push({
      ...(event as unknown as DomainEvent),
      v: 1,
      persistent: true,
      streamSequence,
      globalSequence
    })
    return { streamSequence, globalSequence }
  }

  readAfter(after: number, filter: EventFilter, limit: number) {
    return this.events
      .filter((event) => (event.globalSequence ?? 0) > after && matchesFilter(filter, event))
      .slice(0, limit)
  }

  readLatest(filter: EventFilter, limit: number) {
    return this.events.filter((event) => matchesFilter(filter, event)).slice(-limit)
  }

  countAfter(after: number, filter: EventFilter) {
    return this.readAfter(after, filter, Number.MAX_SAFE_INTEGER).length
  }

  latestSequence() {
    return this.events.length
  }

  count() {
    return this.events.length
  }
}

function setup() {
  const store = new MemoryStore()
  const bus = new EventBus(
    Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [new MemorySink()] })
  )
  bus.attachStore(store, store)
  return { store, bus }
}

const actor = { type: 'core' as const, id: 'core' }

function publishStopped(bus: EventBus, missionId: string | null = null, persistent = true) {
  return bus.publish({
    type: 'core.stopped',
    stream: missionId ? { kind: 'mission', id: missionId } : { kind: 'system', id: 'core' },
    payload: { reason: 'shutdown' },
    persistent,
    correlationId: uuidv7(),
    actor,
    missionId
  })
}

describe('EventBus', () => {
  it('assigns ordered stream sequences and delivers persistent events after commit', () => {
    const { bus } = setup()
    const seen: DomainEvent[] = []
    bus.subscribe(
      's1',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      (event) => seen.push(event)
    )
    publishStopped(bus, 'm1')
    publishStopped(bus, 'm2')
    publishStopped(bus, 'm1')
    expect(
      seen.map((event) => [event.missionId, event.streamSequence, event.globalSequence])
    ).toEqual([
      ['m1', 1, 1],
      ['m2', 1, 2],
      ['m1', 2, 3]
    ])
  })

  it('never delivers an event whose transaction rolled back', () => {
    const { bus, store } = setup()
    const seen: DomainEvent[] = []
    bus.subscribe(
      's1',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      (event) => seen.push(event)
    )
    expect(() =>
      store.run(() => {
        publishStopped(bus)
        throw new Error('rolled back')
      })
    ).toThrow()
    expect(seen).toEqual([])
    expect(store.count()).toBe(0)
  })

  it('replays after a cursor without duplicates, then continues live', () => {
    const { bus } = setup()
    for (let i = 0; i < 5; i++) publishStopped(bus)
    const seen: number[] = []
    const receipt = bus.subscribe(
      's1',
      { afterSequence: 3, replayLimit: 100, filter: MATCH_ALL_EVENTS },
      (event) => seen.push(event.globalSequence ?? -1)
    )
    publishStopped(bus)
    expect(receipt).toEqual({ replayed: 2, latestSequence: 5, truncated: false })
    expect(seen).toEqual([4, 5, 6])
  })

  it('marks a replay as truncated when the cursor is too far behind', () => {
    const { bus } = setup()
    for (let i = 0; i < 10; i++) publishStopped(bus)
    const seen: number[] = []
    const receipt = bus.subscribe(
      's1',
      { afterSequence: 0, replayLimit: 3, filter: MATCH_ALL_EVENTS },
      (event) => seen.push(event.globalSequence ?? -1)
    )
    expect(receipt.truncated).toBe(true)
    expect(seen).toEqual([8, 9, 10])
  })

  it('delivers transient events live only, without sequences', () => {
    const { bus, store } = setup()
    const seen: DomainEvent[] = []
    bus.subscribe(
      's1',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      (event) => seen.push(event)
    )
    const event = publishStopped(bus, null, false)
    expect(event).toMatchObject({ persistent: false, streamSequence: null, globalSequence: null })
    expect(seen).toHaveLength(1)
    expect(store.count()).toBe(0)
  })

  it('filters by type, stream and mission', () => {
    const { bus } = setup()
    const seen: DomainEvent[] = []
    bus.subscribe(
      's1',
      { afterSequence: null, replayLimit: 0, filter: { ...MATCH_ALL_EVENTS, missionId: 'm2' } },
      (event) => seen.push(event)
    )
    publishStopped(bus, 'm1')
    publishStopped(bus, 'm2')
    expect(seen.map((event) => event.missionId)).toEqual(['m2'])
  })

  it('rejects an event whose payload does not match its type', () => {
    const { bus } = setup()
    expect(() =>
      bus.publish({
        type: 'core.stopped',
        stream: { kind: 'system', id: 'core' },
        payload: { reason: 'boom' } as never,
        persistent: true,
        correlationId: uuidv7(),
        actor
      })
    ).toThrow(/invalid payload/)
  })

  it('refuses to store events without a database, but still delivers transient ones', () => {
    const bus = new EventBus(Logger.create({ sessionId: uuidv7(), level: 'debug', sinks: [] }))
    expect(() => publishStopped(bus)).toThrow(
      expect.objectContaining({ code: 'EVENT_PERSISTENCE_UNAVAILABLE' })
    )
    expect(() => publishStopped(bus, null, false)).not.toThrow()
  })

  it('drops a subscriber that keeps failing, without affecting others', () => {
    const { bus } = setup()
    const good: number[] = []
    const dropped: string[] = []
    let attempts = 0
    bus.subscribe(
      'bad',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      () => {
        attempts++
        throw new Error('renderer gone')
      },
      () => dropped.push('bad')
    )
    bus.subscribe(
      'good',
      { afterSequence: null, replayLimit: 0, filter: MATCH_ALL_EVENTS },
      (event) => good.push(event.globalSequence ?? -1)
    )
    for (let i = 0; i < 4; i++) publishStopped(bus)
    expect(good).toEqual([1, 2, 3, 4])
    expect(bus.subscriberCount).toBe(1)
    // It is told once, so the client can resubscribe, and is not tried again.
    expect(dropped).toEqual(['bad'])
    expect(attempts).toBe(3)
  })

  it('does not register a subscriber that already fails during its replay', () => {
    const { bus } = setup()
    for (let i = 0; i < 5; i++) publishStopped(bus)
    const dropped: string[] = []
    const receipt = bus.subscribe(
      'broken',
      { afterSequence: 0, replayLimit: 10, filter: MATCH_ALL_EVENTS },
      () => {
        throw new Error('port closed')
      },
      () => dropped.push('broken')
    )
    expect(receipt.replayed).toBe(5)
    expect(dropped).toEqual(['broken'])
    expect(bus.subscriberCount).toBe(0)
  })
})
