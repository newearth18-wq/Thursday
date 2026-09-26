import { useCallback } from 'react'
import type { DomainEvent, EventFilter, MissionDetail, MissionSummary } from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import type { Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * Missions for the interface (SET 4–5). Everything shown is read from Jupiter
 * Core, and read again whenever Core publishes a change to a Mission.
 */

const MISSION_EVENT_TYPES: NonNullable<EventFilter['types']> = [
  'mission.created',
  'mission.status_changed',
  'mission.transition_rejected',
  'mission.planned',
  'mission.execution_started',
  'mission.step_started',
  'mission.step_finished',
  'mission.verification_recorded',
  'mission.artifact_recorded',
  'mission.plan_rejected',
  'mission.step_waiting',
  'mission.approval_decided',
  'mission.step_retry_scheduled',
  'mission.recovered',
  'mission.pause_requested',
  'mission.archived'
]

const ALL_MISSIONS: EventFilter = { types: MISSION_EVENT_TYPES, streams: null, missionId: null }

export function useMissionList(
  includeArchived: boolean,
  coreSession: string | null
): Loadable<MissionSummary[]> {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(ALL_MISSIONS, bump, coreSession)
  const load = useCallback(
    async () => (await request('missions.list', { includeArchived, limit: 200 })).missions,
    [includeArchived]
  )
  return useQuery(keyOf(coreSession, String(includeArchived), opened, version), load)[0]
}

export interface MissionView {
  readonly detail: MissionDetail
  readonly timeline: readonly DomainEvent[]
}

/** One Mission with its timeline (its stored events), kept live. */
export function useMission(
  missionId: string | null,
  coreSession: string | null
): { readonly mission: Loadable<MissionView>; readonly replace: (detail: MissionDetail) => void } {
  const [version, bump] = useBump(60)
  const filter: EventFilter | null =
    missionId === null
      ? null
      : { types: null, streams: [{ kind: 'mission', id: missionId }], missionId: null }
  const { opened } = useLiveEvents(filter, bump, coreSession)
  const load = useCallback(async (): Promise<MissionView> => {
    if (missionId === null) throw new Error('no Mission selected')
    const [detail, timeline] = await Promise.all([
      request('missions.get', { missionId }),
      request('missions.timeline', { missionId })
    ])
    return { detail, timeline: timeline.events }
  }, [missionId])
  const [mission, update] = useQuery(
    missionId === null ? null : keyOf(coreSession, missionId, opened, version),
    load
  )
  const replace = useCallback(
    (detail: MissionDetail) => {
      update((previous) =>
        previous.detail.mission.missionId === detail.mission.missionId
          ? { ...previous, detail }
          : previous
      )
      bump()
    },
    [update, bump]
  )
  return { mission, replace }
}
