import { useEffect, useRef, useState } from 'react'
import { MATCH_ALL_EVENTS, type DomainEvent } from '@jupiter/contracts'
import { subscribeEvents, type EventStream } from './api'

/**
 * The persistent event log, kept live.
 *
 * Events are stored by global sequence, so an event can never appear twice —
 * whether it arrives in a replay, live, or again after Jupiter Core restarts.
 * When Core restarts, the subscription resumes from the last sequence seen.
 * A page reload starts from the most recent `limit` events.
 */

export type EventLogState = 'connecting' | 'live' | 'waiting-for-core' | 'error'

/**
 * @param coreSession identifies the running Jupiter Core process (it changes on
 *   every restart), or `null` while Core is not running.
 */
export function useEventLog(
  limit: number,
  coreSession: string | null
): { events: DomainEvent[]; state: EventLogState } {
  const [events, setEvents] = useState<DomainEvent[]>([])
  const [generation, setGeneration] = useState(0)
  // The outcome of one specific subscription attempt; any other attempt is still "connecting".
  const [outcome, setOutcome] = useState<{ attempt: string; state: 'live' | 'error' } | null>(null)
  // The newest sequence received, readable synchronously when (re)subscribing.
  const cursor = useRef<number | null>(null)
  const attempt = coreSession === null ? null : `${coreSession}#${String(generation)}`

  useEffect(() => {
    if (attempt === null) return
    let cancelled = false
    let stream: EventStream | null = null
    subscribeEvents({
      filter: MATCH_ALL_EVENTS,
      replayLimit: limit,
      afterSequence: cursor.current,
      onEvent: (event) => {
        if (cancelled || event.globalSequence === null) return
        const sequence = event.globalSequence
        cursor.current = Math.max(cursor.current ?? 0, sequence)
        setEvents((existing) => {
          if (existing.some((item) => item.globalSequence === sequence)) return existing
          return [...existing, event]
            .sort((a, b) => (a.globalSequence ?? 0) - (b.globalSequence ?? 0))
            .slice(-limit)
        })
      },
      onReset: () => {
        if (cancelled) return
        cursor.current = null
        setEvents([])
      },
      onEnded: () => {
        if (!cancelled) setGeneration((value) => value + 1)
      }
    }).then(
      (opened) => {
        if (cancelled) {
          opened.close()
          return
        }
        stream = opened
        setOutcome({ attempt, state: 'live' })
      },
      () => {
        if (!cancelled) setOutcome({ attempt, state: 'error' })
      }
    )
    return () => {
      cancelled = true
      stream?.close()
    }
  }, [limit, attempt])

  const state: EventLogState =
    attempt === null
      ? 'waiting-for-core'
      : outcome?.attempt === attempt
        ? outcome.state
        : 'connecting'
  return { events, state }
}
