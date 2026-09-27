import { useCallback } from 'react'
import type { BrowserStatus, BrowserTask, EventFilter } from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import type { Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * The Browser Agent for the interface (SET 9): its availability and recent
 * tasks, read from Jupiter Core and read again whenever a task changes.
 */

const BROWSER_EVENTS: EventFilter = {
  types: [
    'browser.task_started',
    'browser.action_completed',
    'browser.suspicious_content',
    'browser.safety_stop',
    'browser.task_finished'
  ],
  streams: null,
  missionId: null
}

export function useBrowser(coreSession: string | null): {
  readonly status: Loadable<BrowserStatus>
  readonly tasks: Loadable<BrowserTask[]>
} {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(BROWSER_EVENTS, bump, coreSession)
  const loadStatus = useCallback(async () => request('browser.status', {}), [])
  const loadTasks = useCallback(
    async () => (await request('browser.tasks', { limit: 10 })).tasks,
    []
  )
  const [status] = useQuery(keyOf(coreSession, 'status', opened, version), loadStatus)
  const [tasks] = useQuery(keyOf(coreSession, 'tasks', opened, version), loadTasks)
  return { status, tasks }
}
