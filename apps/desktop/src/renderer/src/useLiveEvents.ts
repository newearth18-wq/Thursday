import { useEffect, useRef, useState } from 'react'
import type { DomainEvent, EventFilter } from '@jupiter/contracts'
import { subscribeEvents, type EventStream } from './api'

/**
 * Live events for one screen: no replay, only what happens from now on.
 *
 * The subscription is opened again when Jupiter Core restarts and when Core
 * ends it. `opened` counts the subscriptions that were opened: a screen puts
 * it in its load dependencies, so it reads its data again after every
 * (re)subscription and cannot miss a change that happened in between.
 */
export function useLiveEvents(
  filter: EventFilter | null,
  onEvent: (event: DomainEvent) => void,
  coreSession: string | null
): { readonly opened: number; readonly failed: boolean } {
  const handler = useRef(onEvent)
  useEffect(() => {
    handler.current = onEvent
  }, [onEvent])
  const [generation, setGeneration] = useState(0)
  const [opened, setOpened] = useState(0)
  const [failed, setFailed] = useState(false)
  const key = filter === null || coreSession === null ? null : JSON.stringify(filter)

  useEffect(() => {
    if (key === null) return
    const parsed = JSON.parse(key) as EventFilter
    let cancelled = false
    let stream: EventStream | null = null
    subscribeEvents({
      filter: parsed,
      replayLimit: 0,
      afterSequence: null,
      onEvent: (event) => {
        if (!cancelled) handler.current(event)
      },
      onReset: () => undefined,
      onEnded: () => {
        if (!cancelled) setGeneration((value) => value + 1)
      }
    }).then(
      (opening) => {
        if (cancelled) {
          opening.close()
          return
        }
        stream = opening
        setFailed(false)
        setOpened((value) => value + 1)
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
      stream?.close()
    }
  }, [key, coreSession, generation])

  return { opened, failed }
}
