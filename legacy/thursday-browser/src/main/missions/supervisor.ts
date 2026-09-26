import type { Mission, MissionDraft } from '@shared/schemas.js'
import { describeError, log } from '../core/logger.js'
import { setActiveSkill, setBrainState } from '../core/app-state.js'
import { invokeSkill, listSkills } from '../skills/registry.js'
import { getProviderConfig, resolveProvider } from '../ai/router.js'
import {
  createMission,
  requireMission,
  setCurrentStep,
  setMissionStatus,
  updateStep
} from './store.js'

/**
 * Agent Supervisor.
 *
 * One supervisor, not a swarm. It takes a mission, walks its steps in order,
 * assigns each step's skill, retries what is retryable, pauses for approval
 * where the step demands it, and verifies the result before reporting done.
 */

const RETRY_BASE_DELAY_MS = 750

interface RunControl {
  cancelled: boolean
  paused: boolean
  /** Resolved by missions:approve / missions:reject. */
  approval: { resolve(value: { approved: boolean; reason?: string }): void } | null
}

const running = new Map<string, RunControl>()

export function isMissionRunning(missionId: string): boolean {
  return running.has(missionId)
}

export function startMission(missionId: string): Mission {
  const mission = requireMission(missionId)
  if (running.has(missionId)) {
    throw new Error(`Mission "${mission.title}" is already running`)
  }
  if (mission.status === 'COMPLETED') {
    throw new Error(`Mission "${mission.title}" has already completed`)
  }

  const control: RunControl = { cancelled: false, paused: false, approval: null }
  running.set(missionId, control)

  // Mark the mission running *before* the loop starts. `execute` runs
  // synchronously up to its first await, so it may already have moved the
  // mission to WAITING_APPROVAL by the time it yields — setting EXECUTING
  // afterwards would overwrite that and leave the mission blocked while
  // claiming to be running.
  setMissionStatus(missionId, 'EXECUTING')

  void execute(missionId, control).catch((err: unknown) => {
    log.error('MISSION', `Supervisor crashed on ${missionId}: ${describeError(err)}`)
    setMissionStatus(missionId, 'FAILED', { error: describeError(err) })
    running.delete(missionId)
  })

  // Report whatever state the loop has actually reached.
  return requireMission(missionId)
}

export function pauseMission(missionId: string): Mission {
  const control = running.get(missionId)
  if (!control) throw new Error('That mission is not running, so there is nothing to pause')
  control.paused = true
  return setMissionStatus(missionId, 'PAUSED')
}

export function resumeMission(missionId: string): Mission {
  const mission = requireMission(missionId)
  const control = running.get(missionId)
  if (control) {
    control.paused = false
    return setMissionStatus(missionId, 'EXECUTING')
  }
  if (mission.status !== 'PAUSED' && mission.status !== 'FAILED') {
    throw new Error(`Mission "${mission.title}" is ${mission.status} and cannot be resumed`)
  }
  // The run loop ended (app restart, or a failure); start a fresh pass which
  // skips everything already completed.
  return startMission(missionId)
}

export function cancelMission(missionId: string): Mission {
  const control = running.get(missionId)
  if (control) {
    control.cancelled = true
    control.paused = false
    control.approval?.resolve({ approved: false, reason: 'Mission cancelled' })
  }
  const mission = setMissionStatus(missionId, 'CANCELLED')
  running.delete(missionId)
  setBrainState('idle')
  return mission
}

export function resolveApproval(missionId: string, stepId: string, approved: boolean, reason?: string): Mission {
  const control = running.get(missionId)
  const mission = requireMission(missionId)
  const step = mission.steps.find((candidate) => candidate.id === stepId)
  if (!step) throw new Error(`Mission "${mission.title}" has no step ${stepId}`)
  if (step.status !== 'waiting_approval') {
    throw new Error(`Step "${step.title}" is ${step.status}, not waiting for approval`)
  }
  if (!control?.approval) {
    throw new Error(
      'The supervisor is no longer waiting on this step. Resume the mission to run it again.'
    )
  }
  log.info('MISSION', `Step "${step.title}" ${approved ? 'approved' : 'rejected'}`, {
    missionId,
    stepId,
    ...(reason ? { reason } : {})
  })
  control.approval.resolve({ approved, reason })
  control.approval = null
  return requireMission(missionId)
}

/* ------------------------------ execution ----------------------------- */

async function execute(missionId: string, control: RunControl): Promise<void> {
  setBrainState('executing')

  try {
    for (;;) {
      if (control.cancelled) return

      const mission = requireMission(missionId)
      const next = mission.steps.find(
        (step) => step.status === 'pending' || step.status === 'waiting_approval'
      )

      if (!next) {
        await verify(missionId)
        return
      }

      // Honour a pause request between steps.
      while (control.paused && !control.cancelled) {
        await delay(200)
      }
      if (control.cancelled) return

      setCurrentStep(missionId, next.id)

      if (next.requiresApproval && next.status !== 'waiting_approval') {
        updateStep(next.id, { status: 'waiting_approval' })
        setMissionStatus(missionId, 'WAITING_APPROVAL')
        log.info('MISSION', `Waiting for approval on "${next.title}"`, { missionId, stepId: next.id })

        const decision = await waitForApproval(control)
        if (control.cancelled) return
        if (!decision.approved) {
          updateStep(next.id, {
            status: 'skipped',
            error: decision.reason ?? 'Rejected by the user',
            completedAt: Date.now()
          })
          setMissionStatus(missionId, 'EXECUTING')
          continue
        }
        setMissionStatus(missionId, 'EXECUTING')
      } else if (next.requiresApproval && next.status === 'waiting_approval') {
        // Left waiting by a previous run; ask again.
        setMissionStatus(missionId, 'WAITING_APPROVAL')
        const decision = await waitForApproval(control)
        if (control.cancelled) return
        if (!decision.approved) {
          updateStep(next.id, {
            status: 'skipped',
            error: decision.reason ?? 'Rejected by the user',
            completedAt: Date.now()
          })
          setMissionStatus(missionId, 'EXECUTING')
          continue
        }
        setMissionStatus(missionId, 'EXECUTING')
      }

      await runStep(missionId, next.id, control)
    }
  } finally {
    running.delete(missionId)
    setActiveSkill(null)
    if (!control.cancelled) setBrainState('idle')
  }
}

async function runStep(missionId: string, stepId: string, control: RunControl): Promise<void> {
  let step = requireMission(missionId).steps.find((candidate) => candidate.id === stepId)
  if (!step) return

  updateStep(stepId, { status: 'running', startedAt: Date.now(), error: null })

  // A step with no skill is a checkpoint: it records that the mission reached
  // this point. It performs no work and never claims to have done any.
  const skillId = step.skillId
  if (!skillId) {
    updateStep(stepId, {
      status: 'completed',
      output: { type: 'checkpoint', note: step.title },
      completedAt: Date.now()
    })
    log.info('MISSION', `Checkpoint reached: "${step.title}"`, { missionId, stepId })
    return
  }

  for (let attempt = 1; attempt <= step.maxAttempts; attempt++) {
    if (control.cancelled) return
    updateStep(stepId, { attempts: attempt })
    setActiveSkill(skillId)

    const result = await invokeSkill(skillId, step.input ?? {})
    setActiveSkill(null)

    if (result.ok) {
      updateStep(stepId, { status: 'completed', output: result.output, completedAt: Date.now() })
      log.info('MISSION', `Step "${step.title}" completed`, {
        missionId,
        stepId,
        skillId,
        attempt
      })
      return
    }

    // Input and lookup errors will fail identically on every retry.
    const recoverable = result.code === 'TIMEOUT' || result.code === 'PLUGIN_UNHEALTHY' || result.code === 'EXECUTION_ERROR'
    const lastAttempt = attempt >= step.maxAttempts

    if (!recoverable || lastAttempt) {
      updateStep(stepId, { status: 'failed', error: result.error, completedAt: Date.now() })
      setMissionStatus(missionId, 'FAILED', {
        error: `Step "${step.title}" failed: ${result.error}`
      })
      log.error('MISSION', `Step "${step.title}" failed permanently: ${result.error}`, {
        missionId,
        stepId,
        code: result.code,
        recoverable
      })
      control.cancelled = true
      setBrainState('error')
      return
    }

    const backoff = RETRY_BASE_DELAY_MS * attempt
    log.warn('MISSION', `Step "${step.title}" failed (${result.code}); retrying in ${backoff}ms`, {
      missionId,
      stepId,
      attempt,
      maxAttempts: step.maxAttempts
    })
    updateStep(stepId, { error: result.error })
    await delay(backoff)
    step = requireMission(missionId).steps.find((candidate) => candidate.id === stepId) ?? step
  }
}

/** Confirm every step really finished before the mission is called done. */
async function verify(missionId: string): Promise<void> {
  setMissionStatus(missionId, 'VERIFYING')
  setBrainState('thinking')
  setCurrentStep(missionId, null)

  const mission = requireMission(missionId)
  const unfinished = mission.steps.filter(
    (step) => step.status !== 'completed' && step.status !== 'skipped'
  )

  if (unfinished.length > 0) {
    const detail = unfinished.map((step) => `"${step.title}" is ${step.status}`).join('; ')
    setMissionStatus(missionId, 'FAILED', { error: `Verification failed — ${detail}` })
    setBrainState('error')
    log.error('MISSION', `Mission verification failed: ${detail}`, { missionId })
    return
  }

  setMissionStatus(missionId, 'COMPLETED')
  setBrainState('completed')
  log.info('MISSION', `Mission "${mission.title}" completed`, {
    missionId,
    steps: mission.steps.length
  })
}

function waitForApproval(control: RunControl): Promise<{ approved: boolean; reason?: string }> {
  return new Promise((resolve) => {
    control.approval = { resolve }
  })
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------- planning ----------------------------- */

/**
 * Break a goal into steps using the configured model.
 *
 * The model is given the live skill list and must answer with JSON. There is
 * no offline fallback that invents plausible-looking steps: with no working
 * provider this fails and says so.
 */
export async function planMission(input: {
  title: string
  goal: string
  providerId?: string
  model?: string
}): Promise<Mission> {
  const skills = listSkills()
  if (!input.providerId || !input.model) {
    throw new Error(
      'Planning needs a provider and model. Pick one in the sidebar, or create the mission with explicit steps.'
    )
  }
  const providerConfig = getProviderConfig(input.providerId)
  if (!providerConfig) throw new Error(`No provider with id ${input.providerId}`)

  setBrainState('planning')
  log.info('MISSION', `Planning mission "${input.title}"`, {
    goal: input.goal,
    availableSkills: skills.length
  })

  const catalogue = skills
    .map((skill) => `- ${skill.id}: ${skill.description} | input schema: ${JSON.stringify(skill.inputSchema)}`)
    .join('\n')

  const prompt =
    `Goal: ${input.goal}\n\n` +
    `Available skills:\n${catalogue || '(none registered)'}\n\n` +
    'Reply with ONLY a JSON object of the form ' +
    '{"steps":[{"title":"...","skillId":"<id or null>","input":{},"requiresApproval":false}]}. ' +
    'Use skillId null for a checkpoint step that performs no work. ' +
    'Only use skill ids from the list. Keep the plan to at most 6 steps.'

  let raw = ''
  try {
    const provider = resolveProvider(input.providerId)
    for await (const chunk of provider.chat(
      {
        providerId: input.providerId,
        model: input.model,
        messages: [
          {
            role: 'system',
            content: 'You are a planning component. You reply with JSON only, never prose or code fences.'
          },
          { role: 'user', content: prompt }
        ]
      },
      [],
      AbortSignal.timeout(60_000)
    )) {
      if (chunk.type === 'text') raw += chunk.text
      if (chunk.type === 'error') throw new Error(chunk.message)
    }
  } catch (err) {
    setBrainState('error')
    throw new Error(`Planning failed: ${describeError(err)}`)
  }

  const draft = parsePlan(raw, input, skills.map((skill) => skill.id))
  const mission = createMission(draft)
  setBrainState('idle')
  return mission
}

export function parsePlan(
  raw: string,
  input: { title: string; goal: string },
  knownSkillIds: string[]
): MissionDraft {
  // Models often wrap JSON in code fences; take the outermost object.
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(
      `The model did not return a JSON plan. It replied: ${raw.trim().slice(0, 200) || '(nothing)'}`
    )
  }

  let parsed: { steps?: unknown }
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { steps?: unknown }
  } catch (err) {
    throw new Error(`The model's plan was not valid JSON: ${(err as Error).message}`)
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('The model returned a plan with no steps')
  }

  const steps = parsed.steps.slice(0, 6).map((entry, index) => {
    const step = (entry ?? {}) as Record<string, unknown>
    const skillId = typeof step.skillId === 'string' && step.skillId.length > 0 ? step.skillId : null

    if (skillId && !knownSkillIds.includes(skillId)) {
      throw new Error(
        `The plan referenced skill "${skillId}", which is not registered. Registered skills: ${
          knownSkillIds.join(', ') || '(none)'
        }`
      )
    }
    return {
      title: typeof step.title === 'string' && step.title.trim() ? step.title.trim() : `Step ${index + 1}`,
      skillId,
      input:
        step.input && typeof step.input === 'object' && !Array.isArray(step.input)
          ? (step.input as Record<string, unknown>)
          : {},
      requiresApproval: step.requiresApproval === true,
      maxAttempts: 2
    }
  })

  return { title: input.title, goal: input.goal, steps }
}
