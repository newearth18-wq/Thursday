import { z } from 'zod'
import { ActorType, RiskLevel } from './actor'
import { RouteDecision } from './ai'
import { ErrorEnvelope } from './errors'
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
 *   moves the Mission back to READY for a new execution.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  CREATED: ['ANALYZING', 'CANCELLED'],
  ANALYZING: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['WAITING_APPROVAL', 'WAITING_IDENTITY', 'READY', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['READY', 'FAILED', 'CANCELLED'],
  WAITING_IDENTITY: ['READY', 'FAILED', 'CANCELLED'],
  READY: ['RUNNING', 'CANCELLED'],
  RUNNING: ['PAUSED', 'VERIFYING', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED'],
  COMPLETED: ['READY'],
  PARTIAL_SUCCESS: ['READY'],
  FAILED: ['READY'],
  CANCELLED: ['READY']
}

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to)
}

export const MissionAction = z.enum(['pause', 'resume', 'cancel', 'retry', 'archive'])
export type MissionAction = z.infer<typeof MissionAction>

/** What a person can do with a Mission in this state. The interface offers exactly these. */
export function availableMissionActions(mission: {
  readonly status: MissionStatus
  readonly archived: boolean
  readonly pauseRequested: boolean
}): MissionAction[] {
  if (mission.archived) return []
  const actions: MissionAction[] = []
  if (mission.status === 'RUNNING' && !mission.pauseRequested) actions.push('pause')
  if (mission.status === 'PAUSED') actions.push('resume')
  if (canTransition(mission.status, 'CANCELLED')) actions.push('cancel')
  if (TERMINAL_MISSION_STATUSES.has(mission.status)) actions.push('retry', 'archive')
  return actions
}

export const MissionPriority = z.enum(['low', 'normal', 'high'])
export type MissionPriority = z.infer<typeof MissionPriority>

/**
 * Step kinds Jupiter can really execute in this build. Each is implemented
 * by a step executor in Core; the planner (SET 5), skills (SET 6) and agents
 * (SET 8) add more.
 */
export const StepKind = z.enum(['model.answer', 'model.summary', 'verify.answer'])
export type StepKind = z.infer<typeof StepKind>

export const StepStatus = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
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
    kind: StepKind,
    title: z.string().min(1).max(200),
    /** A required step that did not succeed means the Mission cannot be COMPLETED. */
    required: z.boolean(),
    status: StepStatus,
    /** What happened, in plain language (e.g. why it was skipped). */
    detail: z.string().max(500).nullable(),
    /** The model that ran this step, when it used one. */
    route: RouteDecision.nullable(),
    error: ErrorEnvelope.nullable(),
    startedAt: UtcTimestamp.nullable(),
    completedAt: UtcTimestamp.nullable()
  })
  .strict()
export type MissionStep = z.infer<typeof MissionStep>

export const ExecutionStatus = z.enum([
  'RUNNING',
  'PAUSED',
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

export const MissionPlan = z
  .object({
    /** `template`: Jupiter's standard plan. The planner (SET 5) will produce `planner` plans. */
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
    plan: MissionPlan.nullable(),
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
    transitions: z.array(MissionTransition).max(1000),
    actions: z.array(MissionAction).max(5)
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
