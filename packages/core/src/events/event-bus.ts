import {
  CONTRACT_VERSION,
  DomainEvent,
  EventPayloads,
  type Actor,
  type DomainEventType,
  type EventFilter,
  type EventPayload,
  type StreamRef
} from '@jupiter/contracts'
import { JupiterError, describeError } from '../errors'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { EventStore, TransactionRunner } from '../ports'

/**
 * Jupiter's event bus.
 *
 * Ordering: a persistent event is appended and gets its stream sequence inside
 * a synchronous transaction, and it is delivered only from that transaction's
 * after-commit hook. Commits are serialized, so every subscriber receives the
 * events of one stream (one Mission) in exactly their sequence order, and
 * never sees an event that was rolled back.
 *
 * Reconnection: `subscribe` replays stored events after the caller's cursor
 * and registers the subscriber in the same synchronous step, so no event can
 * slip between the replay and the live feed. Each subscriber also remembers
 * the last global sequence it received and never gets it twice.
 */

export interface PublishInput<T extends DomainEventType> {
  readonly type: T
  readonly stream: StreamRef
  readonly payload: EventPayload<T>
  readonly persistent: boolean
  readonly correlationId: string
  readonly causationId?: string | null
  readonly actor: Actor
  readonly missionId?: string | null
  readonly executionId?: string | null
}

export interface SubscribeOptions {
  /** Deliver stored events after this global sequence; null means the latest `replayLimit` events. */
  readonly afterSequence: number | null
  readonly replayLimit: number
  readonly filter: EventFilter
}

export interface SubscribeReceiptData {
  readonly replayed: number
  readonly latestSequence: number
  readonly truncated: boolean
}

export type EventDelivery = (event: DomainEvent) => void

interface Subscriber {
  readonly filter: EventFilter
  readonly deliver: EventDelivery
  /** Told when the bus gives up on this subscriber, so the client can resubscribe. */
  readonly onDropped: (() => void) | null
  lastDelivered: number
  failures: number
  dropped: boolean
}

const MAX_DELIVERY_FAILURES = 3

export function matchesFilter(filter: EventFilter, event: DomainEvent): boolean {
  if (filter.types && !filter.types.includes(event.type)) return false
  if (
    filter.streams &&
    !filter.streams.some(
      (stream) => stream.kind === event.stream.kind && stream.id === event.stream.id
    )
  )
    return false
  if (filter.missionId && event.missionId !== filter.missionId) return false
  return true
}

export class EventBus {
  private store: EventStore | null = null
  private transactions: TransactionRunner | null = null
  private readonly subscribers = new Map<string, Subscriber>()

  constructor(
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Connect durable storage. Until then (or if the database fails) only transient events work. */
  attachStore(store: EventStore, transactions: TransactionRunner): void {
    this.store = store
    this.transactions = transactions
  }

  detachStore(): void {
    this.store = null
    this.transactions = null
  }

  get persistenceAvailable(): boolean {
    return this.store !== null
  }

  get subscriberCount(): number {
    return this.subscribers.size
  }

  latestSequence(): number {
    return this.store?.latestSequence() ?? 0
  }

  publish<T extends DomainEventType>(input: PublishInput<T>): DomainEvent {
    const payload = EventPayloads[input.type].safeParse(input.payload)
    if (!payload.success) {
      throw new JupiterError(
        'EVENT_PAYLOAD_INVALID',
        `Event ${input.type} has an invalid payload: ${payload.error.issues.map((issue) => issue.message).join('; ')}`,
        {
          category: 'validation',
          userAction: null
        }
      )
    }
    const base = {
      v: CONTRACT_VERSION,
      eventId: uuidv7(),
      type: input.type,
      stream: input.stream,
      occurredAt: this.now().toISOString(),
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      actor: input.actor,
      missionId: input.missionId ?? null,
      executionId: input.executionId ?? null,
      payload: payload.data
    }

    if (!input.persistent) {
      const event = this.validate({
        ...base,
        persistent: false,
        streamSequence: null,
        globalSequence: null
      })
      this.deliver(event)
      return event
    }

    const store = this.store
    const transactions = this.transactions
    if (!store || !transactions) {
      throw new JupiterError(
        'EVENT_PERSISTENCE_UNAVAILABLE',
        `Event ${input.type} could not be stored: the database is not available.`,
        {
          category: 'dependency',
          userAction: 'Check the Database service in Diagnostics and press Retry.',
          retryable: true
        }
      )
    }
    return transactions.run(() => {
      // Validate before touching storage, with placeholder sequences.
      this.validate({ ...base, persistent: true, streamSequence: 1, globalSequence: 1 })
      const sequences = store.append(base)
      const event = this.validate({ ...base, persistent: true, ...sequences })
      transactions.afterCommit(() => {
        this.deliver(event)
      })
      return event
    })
  }

  subscribe(
    id: string,
    options: SubscribeOptions,
    deliver: EventDelivery,
    onDropped: (() => void) | null = null
  ): SubscribeReceiptData {
    if (this.subscribers.has(id)) {
      throw new JupiterError('SUBSCRIPTION_EXISTS', `Subscription ${id} already exists.`, {
        category: 'validation',
        userAction: null
      })
    }
    const store = this.store
    const latestSequence = store?.latestSequence() ?? 0
    let replay: DomainEvent[] = []
    let truncated = false
    if (store && options.replayLimit > 0) {
      if (options.afterSequence === null) {
        replay = store.readLatest(options.filter, options.replayLimit)
      } else if (store.countAfter(options.afterSequence, options.filter) > options.replayLimit) {
        truncated = true
        replay = store.readLatest(options.filter, options.replayLimit)
      } else {
        replay = store.readAfter(options.afterSequence, options.filter, options.replayLimit)
      }
    }

    // Everything below is synchronous: no publish can run between the replay and the registration.
    const subscriber: Subscriber = {
      filter: options.filter,
      deliver,
      onDropped,
      lastDelivered: options.afterSequence ?? 0,
      failures: 0,
      dropped: false
    }
    for (const event of replay) {
      if (!subscriber.dropped) this.deliverTo(id, subscriber, event)
    }
    if (options.afterSequence === null || truncated)
      subscriber.lastDelivered = Math.max(subscriber.lastDelivered, latestSequence)
    if (!subscriber.dropped) this.subscribers.set(id, subscriber)
    return { replayed: replay.length, latestSequence, truncated }
  }

  unsubscribe(id: string): boolean {
    return this.subscribers.delete(id)
  }

  private validate(candidate: unknown): DomainEvent {
    const parsed = DomainEvent.safeParse(candidate)
    if (!parsed.success) {
      throw new JupiterError(
        'EVENT_INVALID',
        `Event failed contract validation: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        {
          category: 'internal',
          userAction: null
        }
      )
    }
    return parsed.data
  }

  private deliver(event: DomainEvent): void {
    for (const [id, subscriber] of [...this.subscribers]) {
      if (matchesFilter(subscriber.filter, event)) this.deliverTo(id, subscriber, event)
    }
  }

  private deliverTo(id: string, subscriber: Subscriber, event: DomainEvent): void {
    if (event.globalSequence !== null) {
      if (event.globalSequence <= subscriber.lastDelivered) return
      subscriber.lastDelivered = event.globalSequence
    }
    try {
      subscriber.deliver(event)
      subscriber.failures = 0
    } catch (error) {
      subscriber.failures++
      this.logger.warn(
        'events.delivery.failed',
        `Delivering ${event.type} to subscription ${id} failed: ${describeError(error)}`,
        {
          subscriptionId: id,
          failures: subscriber.failures
        }
      )
      if (subscriber.failures >= MAX_DELIVERY_FAILURES) {
        subscriber.dropped = true
        this.subscribers.delete(id)
        this.logger.warn(
          'events.subscription.dropped',
          `Subscription ${id} was dropped after repeated delivery failures`
        )
        try {
          subscriber.onDropped?.()
        } catch (notifyError) {
          this.logger.warn(
            'events.subscription.drop-notice.failed',
            `Could not report the dropped subscription ${id}: ${describeError(notifyError)}`
          )
        }
      }
    }
  }
}
