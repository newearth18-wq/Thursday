import { useCallback } from 'react'
import type { ComputerStatus, ComputerTask, EventFilter } from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import type { Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * The Computer Agent for the interface (SET 8): its availability and recent
 * tasks, read from Jupiter Core and read again whenever a task changes.
 */

const COMPUTER_EVENTS: EventFilter = {
  types: ['computer.task_started', 'computer.action_completed', 'computer.task_finished'],
  streams: null,
  missionId: null
}

export function useComputer(coreSession: string | null): {
  readonly status: Loadable<ComputerStatus>
  readonly tasks: Loadable<ComputerTask[]>
} {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(COMPUTER_EVENTS, bump, coreSession)
  const loadStatus = useCallback(async () => request('computer.status', {}), [])
  const loadTasks = useCallback(
    async () => (await request('computer.tasks', { limit: 10 })).tasks,
    []
  )
  const [status] = useQuery(keyOf(coreSession, 'status', opened), loadStatus)
  const [tasks] = useQuery(keyOf(coreSession, 'tasks', opened, version), loadTasks)
  return { status, tasks }
}
