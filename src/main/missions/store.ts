import { randomUUID } from 'node:crypto'
import type { Mission, MissionDraft, MissionStatus, MissionStep, MissionStepStatus } from '@shared/schemas.js'
import { all, fromJson, get, run, toJson } from '../core/db.js'
import { emit } from '../core/events.js'
import { log } from '../core/logger.js'
import { publishCommandCenter } from '../core/app-state.js'

/**
 * Mission persistence.
 *
 * Missions and their steps live in SQLite, so closing Thursday and reopening
 * it leaves the history intact — including a mission that was mid-flight.
 */

export function createMission(draft: MissionDraft): Mission {
  const id = randomUUID()
  const now = Date.now()

  run(
    'INSERT INTO missions(id, title, goal, status, progress, current_step_id, errors, started_at, completed_at, created_at) ' +
      "VALUES (?, ?, ?, 'IDLE', 0, NULL, '[]', NULL, NULL, ?)",
    id,
    draft.title,
    draft.goal,
    now
  )

  draft.steps.forEach((step, index) => {
    run(
      'INSERT INTO mission_steps(id, mission_id, idx, title, skill_id, input, status, output, error, attempts, max_attempts, requires_approval, started_at, completed_at) ' +
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, ?, NULL, NULL)",
      randomUUID(),
      id,
      index,
      step.title,
      step.skillId ?? null,
      step.input ? toJson(step.input) : null,
      step.maxAttempts ?? 1,
      step.requiresApproval ? 1 : 0
    )
  })

  const mission = requireMission(id)
  log.info('MISSION', `Mission created: ${mission.title}`, {
    missionId: id,
    steps: mission.steps.length,
    goal: mission.goal
  })
  publish(mission)
  return mission
}

export function listMissions(): Mission[] {
  return all('SELECT id FROM missions ORDER BY created_at DESC').map((row) =>
    requireMission(String(row.id))
  )
}

export function getMission(id: string): Mission | null {
  const row = get('SELECT * FROM missions WHERE id = ?', id)
  if (!row) return null
  return {
    id: String(row.id),
    title: String(row.title),
    goal: String(row.goal),
    status: String(row.status) as MissionStatus,
    progress: Number(row.progress),
    currentStepId: row.current_step_id === null ? null : String(row.current_step_id),
    steps: loadSteps(id),
    errors: fromJson<string[]>(row.errors, []),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at)
  }
}

export function requireMission(id: string): Mission {
  const mission = getMission(id)
  if (!mission) throw new Error(`No mission with id ${id}`)
  return mission
}

function loadSteps(missionId: string): MissionStep[] {
  return all('SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY idx ASC', missionId).map(
    (row) => ({
      id: String(row.id),
      missionId: String(row.mission_id),
      index: Number(row.idx),
      title: String(row.title),
      skillId: row.skill_id === null ? null : String(row.skill_id),
      input: row.input === null ? null : fromJson<Record<string, unknown>>(row.input, {}),
      status: String(row.status) as MissionStepStatus,
      output: row.output === null ? null : fromJson<unknown>(row.output, null),
      error: row.error === null ? null : String(row.error),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      requiresApproval: Number(row.requires_approval) === 1,
      startedAt: row.started_at === null ? null : Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at)
    })
  )
}

export function setMissionStatus(id: string, status: MissionStatus, extra: { error?: string } = {}): Mission {
  const before = requireMission(id)
  const now = Date.now()
  const startedAt = before.startedAt ?? (status === 'PLANNING' || status === 'EXECUTING' ? now : null)
  const completedAt =
    status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED' ? now : before.completedAt

  const errors = extra.error ? [...before.errors, extra.error] : before.errors

  run(
    'UPDATE missions SET status = ?, started_at = ?, completed_at = ?, errors = ? WHERE id = ?',
    status,
    startedAt,
    completedAt,
    toJson(errors),
    id
  )
  const mission = requireMission(id)
  log.info('MISSION', `Mission "${mission.title}" → ${status}`, {
    missionId: id,
    progress: mission.progress,
    ...(extra.error ? { error: extra.error } : {})
  })
  publish(mission)
  return mission
}

export function setCurrentStep(missionId: string, stepId: string | null): Mission {
  run('UPDATE missions SET current_step_id = ? WHERE id = ?', stepId, missionId)
  const mission = requireMission(missionId)
  publish(mission)
  return mission
}

export function updateStep(
  stepId: string,
  patch: Partial<Pick<MissionStep, 'status' | 'output' | 'error' | 'attempts' | 'startedAt' | 'completedAt'>>
): Mission {
  const row = get('SELECT mission_id FROM mission_steps WHERE id = ?', stepId)
  if (!row) throw new Error(`No mission step with id ${stepId}`)
  const missionId = String(row.mission_id)

  const assignments: string[] = []
  const params: unknown[] = []
  if (patch.status !== undefined) {
    assignments.push('status = ?')
    params.push(patch.status)
  }
  if (patch.output !== undefined) {
    assignments.push('output = ?')
    params.push(patch.output === null ? null : toJson(patch.output))
  }
  if (patch.error !== undefined) {
    assignments.push('error = ?')
    params.push(patch.error)
  }
  if (patch.attempts !== undefined) {
    assignments.push('attempts = ?')
    params.push(patch.attempts)
  }
  if (patch.startedAt !== undefined) {
    assignments.push('started_at = ?')
    params.push(patch.startedAt)
  }
  if (patch.completedAt !== undefined) {
    assignments.push('completed_at = ?')
    params.push(patch.completedAt)
  }
  if (assignments.length > 0) {
    run(`UPDATE mission_steps SET ${assignments.join(', ')} WHERE id = ?`, ...params, stepId)
  }

  recomputeProgress(missionId)
  const mission = requireMission(missionId)
  publish(mission)
  return mission
}

function recomputeProgress(missionId: string): void {
  const steps = loadSteps(missionId)
  if (steps.length === 0) return
  const done = steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped'
  ).length
  run('UPDATE missions SET progress = ? WHERE id = ?', Math.round((done / steps.length) * 100), missionId)
}

export function deleteMission(id: string): void {
  requireMission(id)
  run('DELETE FROM mission_steps WHERE mission_id = ?', id)
  run('DELETE FROM missions WHERE id = ?', id)
  log.info('MISSION', 'Mission deleted', { missionId: id })
  emit('missions:invalidate', undefined)
  publishCommandCenter()
}

/** The mission the Command Center should be showing right now. */
export function activeMission(): Mission | null {
  const running = all(
    "SELECT id FROM missions WHERE status IN ('PLANNING','EXECUTING','WAITING_APPROVAL','VERIFYING','PAUSED') ORDER BY created_at DESC LIMIT 1"
  )
  if (running.length > 0) return getMission(String(running[0].id))
  const latest = all('SELECT id FROM missions ORDER BY created_at DESC LIMIT 1')
  return latest.length > 0 ? getMission(String(latest[0].id)) : null
}

function publish(mission: Mission): void {
  emit('mission:update', mission)
  publishCommandCenter()
}
