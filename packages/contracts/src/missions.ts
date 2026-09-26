import { z } from 'zod'
import { ActorType, RiskLevel } from './actor'
import { RouteDecision } from './ai'
import { ErrorEnvelope } from './errors'
import { Plan, PlanIssue, PlanStepKey, SkillId } from './plans'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * Missions (SET 4).
 *
 * A Mission is a persistent unit of work that starts from a person's
 * request. Its status is driven only by real execution: every change goes
 * through the finite-state machine below, and a change the machine does not
 * allow is rejected and recorded with its reason.
 *
 * Each run of a Mission is an *execution* (attempt 1, 2, …). Retrying starts
 * a new execution linked to the one before; nothing of a failed attempt is
 * erased.
 */

export const MissionId = Uuidv7
export const ExecutionId = Uuidv7
export const StepId = Uuidv7

export const MissionStatus = z.enum([
  'CREATED',
  'ANALYZING',
  'PLANNING',
  'WAITING_APPROVAL',
  'WAITING_IDENTITY',
  'READY',
  'RUNNING',
  'PAUSED',
  'VERIFYING',
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED'
])
export type MissionStatus = z.infer<typeof MissionStatus>

/** Statuses a Mission ends in. Only Retry (a new execution) leaves them. */
export const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED'
])

/**
 * The Mission state machine: from each status, the statuses it may move to.
 * Anything else is an invalid transition.
 *
 * - Approval and identity waits (SET 7, SET 14) lead back to READY.
 * - PAUSED is reached only at a safe boundary between steps.
 * - COMPLETED, PARTIAL_SUCCESS, FAILED and CANCELLED end an execution; Retry
 *   moves the Mission back to READY for a new execution of the same plan, and
 *   Re-plan (SET 5) back to PLANNING for a new plan revision.
 * - A running workflow waits at approval and identity checkpoints (SET 5);
 *   an answer brings it back to RUNNING.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  CREATED: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['WAITING_APPROVAL', 'WAITING_IDENTITY', 'READY', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['READY', 'RUNNING', 'FAILED', 'CANCELLED'],
  WAITING_IDENTITY: ['READY', 'RUNNING', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'WAITING_APPROVAL', 'WAITING_IDENTITY', 'VERIFYING', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'],
  COMPLETED: ['READY', 'PLANNING'],
  PARTIAL_SUCCESS: ['READY', 'PLANNING'],
  FAILED: ['READY', 'PLANNING'],
  CANCELLED: ['READY', 'PLANNING']
}

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to)
}

export const MissionAction = z.enum([
  'pause',
  'resume',
  'approve',
  'reject',
  'cancel',
  'retry',
  'replan',
  'archive'
])
export type MissionAction = z.infer<typeof MissionAction>

/** What a person can do with a Mission in this state. The interface offers exactly these. */
export function availableMissionActions(mission: {
  readonly status: MissionStatus
  readonly archived: boolean
  readonly pauseRequested: boolean
  /** False when there is no plan to run again (planning failed, or a SET 4 Mission): Re-plan instead. */
  readonly hasPlan?: boolean
}): MissionAction[] {
  if (mission.archived) return []
  const actions: MissionAction[] = []
  if (mission.status === 'RUNNING' && !mission.pauseRequested) actions.push('pause')
  if (mission.status === 'PAUSED') actions.push('resume')
  if (mission.status === 'WAITING_APPROVAL') actions.push('approve', 'reject')
  if (canTransition(mission.status, 'CANCELLED')) actions.push('cancel')
  if (TERMINAL_MISSION_STATUSES.has(mission.status)) {
    if (mission.hasPlan !== false) actions.push('retry')
    actions.push('replan', 'archive')
  }
  return actions
}

export const MissionPriority = z.enum(['low', 'normal', 'high'])
export type MissionPriority = z.infer<typeof MissionPriority>

/**
 * What a step does: a step type (skill) id. SET 4 Missions used
 * `model.answer`, `model.summary` and `verify.answer`; SET 5 workflows use the
 * step types of the Workflow Engine's catalogue (`model.generate`, …).
 */
export const StepKind = SkillId
export type StepKind = z.infer<typeof StepKind>

/** Workflow step states (SET 5). */
export const StepStatus = z.enum([
  'PENDING',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'FAILED',
  'SKIPPED',
  'CANCELLED'
])
export type StepStatus = z.infer<typeof StepStatus>

export const MissionStep = z
  .object({
    stepId: StepId,
    executionId: ExecutionId,
    index: z.number().int().nonnegative(),
    /** The step's id in its plan (e.g. `summarise`). */
    key: PlanStepKey,
    kind: StepKind,
    title: z.string().min(1).max(200),
    description: z.string().max(500),
    /** Keys of the steps that must end first. */
    dependencies: z.array(PlanStepKey).max(20),
    /** A required step that did not succeed means the Mission cannot be COMPLETED. */
    required: z.boolean(),
    status: StepStatus,
    /** What happened, in plain language (e.g. why it was skipped). */
    detail: z.string().max(500).nullable(),
    /** The model that ran this step, when it used one. */
    route: RouteDecision.nullable(),
    error: ErrorEnvelope.nullable(),
    /** Attempts made so far, and the most the retry policy allows. */
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    timeoutMs: z.number().int().positive().nullable(),
    /** What a WAITING step waits for. */
    waitingFor: z.enum(['approval', 'identity']).nullable(),
    startedAt: UtcTimestamp.nullable(),
    completedAt: UtcTimestamp.nullable()
  })
  .strict()
export type MissionStep = z.infer<typeof MissionStep>

/** One attempt at a step: kept for every attempt, including retries and interruptions. */
export const StepAttempt = z
  .object({
    stepId: StepId,
    attempt: z.number().int().positive(),
    outcome: z.enum(['completed', 'failed', 'timed-out', 'cancelled', 'interrupted']),
    errorCode: z.string().max(64).nullable(),
    startedAt: UtcTimestamp,
    endedAt: UtcTimestamp
  })
  .strict()
export type StepAttempt = z.infer<typeof StepAttempt>

export const ExecutionStatus = z.enum([
  'RUNNING',
  'PAUSED',
  'WAITING',
  'COMPLETED',
  'PARTIAL_SUCCESS',
  'FAILED',
  'CANCELLED'
])
export type ExecutionStatus = z.infer<typeof ExecutionStatus>

export const MissionExecution = z
  .object({
    executionId: ExecutionId,
    missionId: MissionId,
    attempt: z.number().int().positive(),
    /** The execution this one retries; null for the first. */
    retryOf: ExecutionId.nullable(),
    /** The plan revision this execution runs; null for SET 4 executions. */
    planId: Uuidv7.nullable(),
    status: ExecutionStatus,
    startedAt: UtcTimestamp,
    endedAt: UtcTimestamp.nullable(),
    steps: z.array(MissionStep).max(50)
  })
  .strict()
export type MissionExecution = z.infer<typeof MissionExecution>

/** Every requested status change, accepted or rejected, with its reason. */
export const MissionTransition = z
  .object({
    transitionId: Uuidv7,
    missionId: MissionId,
    executionId: ExecutionId.nullable(),
    from: MissionStatus,
    to: MissionStatus,
    accepted: z.boolean(),
    reason: z.string().min(1).max(500),
    actor: ActorType,
    at: UtcTimestamp
  })
  .strict()
export type MissionTransition = z.infer<typeof MissionTransition>

export const MissionErrorRecord = z
  .object({
    errorId: Uuidv7,
    missionId: MissionId,
    executionId: ExecutionId.nullable(),
    stepId: StepId.nullable(),
    error: ErrorEnvelope,
    at: UtcTimestamp
  })
  .strict()
export type MissionErrorRecord = z.infer<typeof MissionErrorRecord>

export const VerificationResult = z
  .object({
    verificationId: Uuidv7,
    missionId: MissionId,
    executionId: ExecutionId,
    stepId: StepId.nullable(),
    /** Stable name of the check, e.g. `answer-present`. */
    check: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    passed: z.boolean(),
    detail: z.string().max(500),
    at: UtcTimestamp
  })
  .strict()
export type VerificationResult = z.infer<typeof VerificationResult>

/**
 * Something a Mission produced. In this build only text (a model's answer
 * or summary); the Artifact Manager (SET 10) takes over files.
 */
export const MissionArtifact = z
  .object({
    artifactId: Uuidv7,
    missionId: MissionId,
    executionId: ExecutionId,
    stepId: StepId,
    kind: z.enum(['text']),
    title: z.string().min(1).max(200),
    text: z.string().max(200_000),
    createdAt: UtcTimestamp
  })
  .strict()
export type MissionArtifact = z.infer<typeof MissionArtifact>

/** A permission a Mission needs. The Permission Engine arrives in SET 7; no step needs one yet. */
export const MissionPermission = z
  .object({
    name: z.string().min(1).max(120),
    risk: RiskLevel,
    decision: z.enum(['pending', 'granted', 'denied'])
  })
  .strict()
export type MissionPermission = z.infer<typeof MissionPermission>

/**
 * The SET 4 plan record, still stored for Missions planned before SET 5.
 * New Missions use `Plan` (plans.ts), kept as revisions.
 */
export const MissionPlan = z
  .object({
    /** `template`: Jupiter's standard answer plan of SET 4. */
    source: z.enum(['template']),
    templateId: z.string().max(64),
    summary: z.string().max(500),
    steps: z
      .array(
        z.object({ kind: StepKind, title: z.string().max(200), required: z.boolean() }).strict()
      )
      .min(1)
      .max(50)
  })
  .strict()
export type MissionPlan = z.infer<typeof MissionPlan>

export const MissionProgress = z
  .object({
    /** Steps that ended (succeeded, failed, skipped or cancelled) in the current execution. */
    done: z.number().int().nonnegative(),
    total: z.number().int().positive()
  })
  .strict()
export type MissionProgress = z.infer<typeof MissionProgress>

export const MissionSummary = z
  .object({
    missionId: MissionId,
    title: z.string().min(1).max(120),
    status: MissionStatus,
    priority: MissionPriority,
    archived: z.boolean(),
    /** Pause was asked for; it happens when the current step ends. */
    pauseRequested: z.boolean(),
    attempt: z.number().int().nonnegative(),
    progress: MissionProgress.nullable(),
    currentStepTitle: z.string().max(200).nullable(),
    currentStepKind: StepKind.nullable(),
    /** What the Mission waits for, when it waits at a checkpoint. */
    waitingFor: z.enum(['approval', 'identity']).nullable(),
    /** Revision of the plan in use; null before planning or for SET 4 Missions. */
    planRevision: z.number().int().positive().nullable(),
    model: z.string().max(200).nullable(),
    startedAt: UtcTimestamp.nullable(),
    endedAt: UtcTimestamp.nullable(),
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp
  })
  .strict()
export type MissionSummary = z.infer<typeof MissionSummary>

export const MissionDetail = z
  .object({
    mission: MissionSummary,
    userRequest: z.string().min(1).max(8000),
    /** The plan in use (latest revision). */
    plan: Plan.nullable(),
    /** Every plan revision, oldest first. */
    planRevisions: z.array(Plan).max(50),
    /** Model output that did not pass as a plan, with the reasons, oldest first. */
    planRejections: z
      .array(z.object({ at: UtcTimestamp, issues: z.array(PlanIssue).max(50) }).strict())
      .max(50),
    /** Steps of the current (latest) execution. */
    steps: z.array(MissionStep).max(50),
    currentStepId: StepId.nullable(),
    nextStepId: StepId.nullable(),
    permissions: z.array(MissionPermission).max(50),
    artifacts: z.array(MissionArtifact).max(100),
    errors: z.array(MissionErrorRecord).max(200),
    verificationResults: z.array(VerificationResult).max(200),
    /** Every execution, oldest first, each with its own steps. */
    executionHistory: z.array(MissionExecution).max(100),
    /** Every attempt at every step of the current execution (retries included). */
    stepAttempts: z.array(StepAttempt).max(500),
    transitions: z.array(MissionTransition).max(1000),
    actions: z.array(MissionAction).max(8)
  })
  .strict()
export type MissionDetail = z.infer<typeof MissionDetail>

export const MissionRequestText = z.string().trim().min(1).max(8000)

/** A title from the first line of a request. */
export function missionTitleFrom(text: string): string {
  const line = (text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? text)
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line || 'Mission'
}
