import { useCallback } from 'react'
import type { EventFilter, SkillExecutionRecord, SkillFilter, SkillInfo } from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import type { Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * Skills for the interface (SET 6). Everything shown is read from Jupiter
 * Core's Skill Registry, and read again whenever Core publishes a change to
 * a Skill (registration, state, health, an execution).
 */

const SKILL_EVENTS: EventFilter = {
  types: [
    'skill.registered',
    'skill.state_changed',
    'skill.health_checked',
    'skill.execution_started',
    'skill.execution_finished'
  ],
  streams: null,
  missionId: null
}

export function useSkillList(
  filter: SkillFilter,
  coreSession: string | null
): Loadable<SkillInfo[]> {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(SKILL_EVENTS, bump, coreSession)
  const key = JSON.stringify(filter)
  const load = useCallback(
    async () => (await request('skills.list', { filter: JSON.parse(key) as SkillFilter })).skills,
    [key]
  )
  return useQuery(keyOf(coreSession, key, opened, version), load)[0]
}

export interface SkillView {
  readonly info: SkillInfo
  readonly versions: readonly SkillInfo[]
  readonly executions: readonly SkillExecutionRecord[]
}

/** One Skill with its versions and execution history, kept live. */
export function useSkill(
  skillId: string | null,
  coreSession: string | null
): {
  readonly skill: Loadable<SkillView>
  readonly refresh: () => void
  /** Show what Core just returned at once, then read everything again. */
  readonly replace: (info: SkillInfo) => void
} {
  const [version, bump] = useBump(60)
  const filter: EventFilter | null =
    skillId === null
      ? null
      : { types: null, streams: [{ kind: 'skill', id: skillId }], missionId: null }
  const { opened } = useLiveEvents(filter, bump, coreSession)
  const load = useCallback(async (): Promise<SkillView> => {
    if (skillId === null) throw new Error('no Skill selected')
    const [info, versions, history] = await Promise.all([
      request('skills.get', { skillId }),
      request('skills.versions', { skillId }),
      request('skills.executions', { skillId, limit: 20 })
    ])
    return { info, versions: versions.versions, executions: history.executions }
  }, [skillId])
  const [skill, update] = useQuery(
    skillId === null ? null : keyOf(coreSession, skillId, opened, version),
    load
  )
  const replace = useCallback(
    (info: SkillInfo) => {
      update((previous) => ({ ...previous, info }))
      bump()
    },
    [update, bump]
  )
  return { skill, refresh: bump, replace }
}
