import type { DatabaseSync } from 'node:sqlite'
import {
  ErrorEnvelope,
  MissionArtifact,
  MissionErrorRecord,
  MissionExecution,
  MissionPlan,
  MissionPriority,
  MissionStatus,
  MissionStep,
  MissionTransition,
  Plan,
  PlanIssue,
  PlanStep,
  StepAttempt,
  VerificationResult
} from '@jupiter/contracts'
import type {
  ExecutionRecord,
  MissionChanges,
  MissionRecord,
  MissionStore,
  PlanRejectionRecord,
  StepChanges
} from '@jupiter/core'
import { integer, json, nullableInteger, nullableText, text } from '../rows'

type Row = Record<string, unknown>

/** Statuses in which a Mission is being worked on by a runner that lives only in memory. */
const IN_FLIGHT = ['ANALYZING', 'PLANNING', 'RUNNING', 'VERIFYING']

/** Missions and their history. Rows are validated against the contract when read. */
export class SqliteMissionStore implements MissionStore {
  constructor(private readonly db: DatabaseSync) {}

  insertMission(mission: MissionRecord): void {
    this.db
      .prepare(
        `INSERT INTO missions (mission_id, title, user_request, priority, status, pause_requested,
           archived_at, plan_json, current_execution_id, current_plan_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mission.missionId,
        mission.title,
        mission.userRequest,
        mission.priority,
        mission.status,
        mission.pauseRequested ? 1 : 0,
        mission.archivedAt,
        mission.plan ? JSON.stringify(mission.plan) : null,
        mission.currentExecutionId,
        mission.currentPlanId,
        mission.createdAt,
        mission.updatedAt
      )
  }

  mission(missionId: string): MissionRecord | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE mission_id = ?').get(missionId)
    return row ? toMission(row) : null
  }

  updateMission(missionId: string, changes: MissionChanges): void {
    const current = this.mission(missionId)
    if (!current) throw new Error(`No mission ${missionId}`)
    const next = { ...current, ...changes }
    this.db
      .prepare(
        `UPDATE missions SET status = ?, pause_requested = ?, archived_at = ?, plan_json = ?,
           current_execution_id = ?, current_plan_id = ?, updated_at = ?
         WHERE mission_id = ?`
      )
      .run(
        MissionStatus.parse(next.status),
        next.pauseRequested ? 1 : 0,
        next.archivedAt,
        next.plan ? JSON.stringify(next.plan) : null,
        next.currentExecutionId,
        next.currentPlanId,
        next.updatedAt,
        missionId
      )
  }

  listMissions(options: { includeArchived: boolean; limit: number }): MissionRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM missions ${options.includeArchived ? '' : 'WHERE archived_at IS NULL'}
         ORDER BY updated_at DESC, mission_id DESC LIMIT ?`
      )
      .all(options.limit)
      .map(toMission)
  }

  inFlight(): MissionRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM missions WHERE status IN (${IN_FLIGHT.map(() => '?').join(', ')}) ORDER BY created_at`
      )
      .all(...IN_FLIGHT)
      .map(toMission)
  }

  insertExecution(execution: ExecutionRecord): void {
    this.db
      .prepare(
        `INSERT INTO mission_executions (execution_id, mission_id, attempt, retry_of, plan_id, status,
           started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        execution.executionId,
        execution.missionId,
        execution.attempt,
        execution.retryOf,
        execution.planId,
        execution.status,
        execution.startedAt,
        execution.endedAt
      )
  }

  updateExecution(
    executionId: string,
    changes: Partial<Pick<ExecutionRecord, 'status' | 'endedAt'>>
  ): void {
    const row = this.db
      .prepare('SELECT * FROM mission_executions WHERE execution_id = ?')
      .get(executionId)
    if (!row) throw new Error(`No execution ${executionId}`)
    const current = toExecution(row)
    const next = { ...current, ...changes }
    this.db
      .prepare('UPDATE mission_executions SET status = ?, ended_at = ? WHERE execution_id = ?')
      .run(next.status, next.endedAt, executionId)
  }

  executions(missionId: string): ExecutionRecord[] {
    return this.db
      .prepare('SELECT * FROM mission_executions WHERE mission_id = ? ORDER BY attempt')
      .all(missionId)
      .map(toExecution)
  }

  insertStep(input: MissionStep, definition?: PlanStep): void {
    const step = MissionStep.parse(input)
    const plan = definition ? PlanStep.parse(definition) : null
    this.db
      .prepare(
        `INSERT INTO mission_steps (step_id, execution_id, idx, step_key, kind, title, description,
           required, status, detail, route_json, error_json, dependencies_json, input_json,
           condition_json, verification_json, timeout_ms, max_attempts, backoff_ms,
           backoff_multiplier, attempts, waiting_for, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        step.stepId,
        step.executionId,
        step.index,
        step.key,
        step.kind,
        step.title,
        step.description,
        step.required ? 1 : 0,
        step.status,
        step.detail,
        step.route ? JSON.stringify(step.route) : null,
        step.error ? JSON.stringify(step.error) : null,
        JSON.stringify(step.dependencies),
        JSON.stringify(plan?.input ?? {}),
        plan?.condition ? JSON.stringify(plan.condition) : null,
        plan?.verification ? JSON.stringify(plan.verification) : null,
        step.timeoutMs,
        step.maxAttempts,
        plan?.retryPolicy.backoffMs ?? 0,
        plan?.retryPolicy.multiplier ?? 1,
        step.attempts,
        step.waitingFor,
        step.startedAt,
        step.completedAt
      )
  }

  updateStep(stepId: string, changes: StepChanges): void {
    const row = this.db.prepare('SELECT * FROM mission_steps WHERE step_id = ?').get(stepId)
    if (!row) throw new Error(`No step ${stepId}`)
    const next = MissionStep.parse({ ...toStep(row), ...changes })
    this.db
      .prepare(
        `UPDATE mission_steps SET status = ?, detail = ?, route_json = ?, error_json = ?,
           attempts = ?, waiting_for = ?, started_at = ?, completed_at = ?
         WHERE step_id = ?`
      )
      .run(
        next.status,
        next.detail,
        next.route ? JSON.stringify(next.route) : null,
        next.error ? JSON.stringify(next.error) : null,
        next.attempts,
        next.waitingFor,
        next.startedAt,
        next.completedAt,
        stepId
      )
  }

  steps(executionId: string): MissionStep[] {
    return this.db
      .prepare('SELECT * FROM mission_steps WHERE execution_id = ? ORDER BY idx')
      .all(executionId)
      .map(toStep)
  }

  insertAttempt(input: StepAttempt): void {
    const attempt = StepAttempt.parse(input)
    this.db
      .prepare(
        `INSERT INTO mission_step_attempts (step_id, attempt, outcome, error_code, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        attempt.stepId,
        attempt.attempt,
        attempt.outcome,
        attempt.errorCode,
        attempt.startedAt,
        attempt.endedAt
      )
  }

  attempts(executionId: string): StepAttempt[] {
    return this.db
      .prepare(
        `SELECT a.* FROM mission_step_attempts a JOIN mission_steps s ON s.step_id = a.step_id
         WHERE s.execution_id = ? ORDER BY s.idx, a.attempt LIMIT 500`
      )
      .all(executionId)
      .map((row) =>
        StepAttempt.parse({
          stepId: text(row, 'step_id'),
          attempt: integer(row, 'attempt'),
          outcome: text(row, 'outcome'),
          errorCode: nullableText(row, 'error_code'),
          startedAt: text(row, 'started_at'),
          endedAt: text(row, 'ended_at')
        })
      )
  }

  insertPlan(input: Plan): void {
    const plan = Plan.parse(input)
    this.db
      .prepare(
        `INSERT INTO mission_plans (plan_id, mission_id, revision, previous_plan_id, source, reason,
           plan_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        plan.planId,
        plan.missionId,
        plan.revision,
        plan.previousPlanId,
        plan.source,
        plan.reason,
        JSON.stringify(plan),
        plan.createdAt
      )
  }

  plan(planId: string): Plan | null {
    const row = this.db.prepare('SELECT plan_json FROM mission_plans WHERE plan_id = ?').get(planId)
    return row ? Plan.parse(json(row, 'plan_json')) : null
  }

  plans(missionId: string): Plan[] {
    return this.db
      .prepare(
        'SELECT plan_json FROM mission_plans WHERE mission_id = ? ORDER BY revision LIMIT 50'
      )
      .all(missionId)
      .map((row) => Plan.parse(json(row, 'plan_json')))
  }

  insertPlanRejection(rejection: PlanRejectionRecord): void {
    const issues = PlanIssue.array().min(1).max(50).parse(rejection.issues)
    this.db
      .prepare(
        `INSERT INTO mission_plan_rejections (rejection_id, mission_id, issues_json, at)
         VALUES (?, ?, ?, ?)`
      )
      .run(rejection.rejectionId, rejection.missionId, JSON.stringify(issues), rejection.at)
  }

  planRejections(missionId: string): PlanRejectionRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM mission_plan_rejections WHERE mission_id = ?
         ORDER BY at, rejection_id LIMIT 50`
      )
      .all(missionId)
      .map((row) => ({
        rejectionId: text(row, 'rejection_id'),
        missionId: text(row, 'mission_id'),
        issues: PlanIssue.array().parse(json(row, 'issues_json')),
        at: text(row, 'at')
      }))
  }

  insertTransition(input: MissionTransition): void {
    const transition = MissionTransition.parse(input)
    this.db
      .prepare(
        `INSERT INTO mission_transitions (transition_id, mission_id, execution_id, from_status,
           to_status, accepted, reason, actor_type, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        transition.transitionId,
        transition.missionId,
        transition.executionId,
        transition.from,
        transition.to,
        transition.accepted ? 1 : 0,
        transition.reason,
        transition.actor,
        transition.at
      )
  }

  transitions(missionId: string): MissionTransition[] {
    return this.db
      .prepare(
        'SELECT * FROM mission_transitions WHERE mission_id = ? ORDER BY at, transition_id LIMIT 1000'
      )
      .all(missionId)
      .map((row) =>
        MissionTransition.parse({
          transitionId: text(row, 'transition_id'),
          missionId: text(row, 'mission_id'),
          executionId: nullableText(row, 'execution_id'),
          from: text(row, 'from_status'),
          to: text(row, 'to_status'),
          accepted: integer(row, 'accepted') === 1,
          reason: text(row, 'reason'),
          actor: text(row, 'actor_type'),
          at: text(row, 'at')
        })
      )
  }

  insertError(error: MissionErrorRecord): void {
    this.db
      .prepare(
        `INSERT INTO mission_errors (error_id, mission_id, execution_id, step_id, error_json, at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        error.errorId,
        error.missionId,
        error.executionId,
        error.stepId,
        JSON.stringify(error.error),
        error.at
      )
  }

  errors(missionId: string): MissionErrorRecord[] {
    return this.db
      .prepare('SELECT * FROM mission_errors WHERE mission_id = ? ORDER BY at, error_id LIMIT 200')
      .all(missionId)
      .map((row) =>
        MissionErrorRecord.parse({
          errorId: text(row, 'error_id'),
          missionId: text(row, 'mission_id'),
          executionId: nullableText(row, 'execution_id'),
          stepId: nullableText(row, 'step_id'),
          error: ErrorEnvelope.parse(json(row, 'error_json')),
          at: text(row, 'at')
        })
      )
  }

  insertVerification(result: VerificationResult): void {
    this.db
      .prepare(
        `INSERT INTO mission_verifications (verification_id, mission_id, execution_id, step_id,
           check_name, passed, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        result.verificationId,
        result.missionId,
        result.executionId,
        result.stepId,
        result.check,
        result.passed ? 1 : 0,
        result.detail,
        result.at
      )
  }

  verifications(missionId: string): VerificationResult[] {
    return this.db
      .prepare(
        'SELECT * FROM mission_verifications WHERE mission_id = ? ORDER BY at, verification_id LIMIT 200'
      )
      .all(missionId)
      .map((row) =>
        VerificationResult.parse({
          verificationId: text(row, 'verification_id'),
          missionId: text(row, 'mission_id'),
          executionId: text(row, 'execution_id'),
          stepId: nullableText(row, 'step_id'),
          check: text(row, 'check_name'),
          passed: integer(row, 'passed') === 1,
          detail: text(row, 'detail'),
          at: text(row, 'at')
        })
      )
  }

  insertArtifact(artifact: MissionArtifact): void {
    this.db
      .prepare(
        `INSERT INTO mission_artifacts (artifact_id, mission_id, execution_id, step_id, kind, title, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifact.artifactId,
        artifact.missionId,
        artifact.executionId,
        artifact.stepId,
        artifact.kind,
        artifact.title,
        artifact.text,
        artifact.createdAt
      )
  }

  artifacts(missionId: string): MissionArtifact[] {
    return this.db
      .prepare(
        'SELECT * FROM mission_artifacts WHERE mission_id = ? ORDER BY created_at, artifact_id LIMIT 100'
      )
      .all(missionId)
      .map((row) =>
        MissionArtifact.parse({
          artifactId: text(row, 'artifact_id'),
          missionId: text(row, 'mission_id'),
          executionId: text(row, 'execution_id'),
          stepId: text(row, 'step_id'),
          kind: text(row, 'kind'),
          title: text(row, 'title'),
          text: text(row, 'text'),
          createdAt: text(row, 'created_at')
        })
      )
  }
}

function parseNullable(row: Row, key: string): unknown {
  const value = nullableText(row, key)
  return value === null ? null : (JSON.parse(value) as unknown)
}

function toMission(row: Row): MissionRecord {
  const plan = parseNullable(row, 'plan_json')
  return {
    missionId: text(row, 'mission_id'),
    title: text(row, 'title'),
    userRequest: text(row, 'user_request'),
    priority: MissionPriority.parse(text(row, 'priority')),
    status: MissionStatus.parse(text(row, 'status')),
    pauseRequested: integer(row, 'pause_requested') === 1,
    archivedAt: nullableText(row, 'archived_at'),
    plan: plan === null ? null : MissionPlan.parse(plan),
    currentExecutionId: nullableText(row, 'current_execution_id'),
    currentPlanId: nullableText(row, 'current_plan_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at')
  }
}

function toExecution(row: Row): ExecutionRecord {
  return MissionExecution.omit({ steps: true }).parse({
    executionId: text(row, 'execution_id'),
    missionId: text(row, 'mission_id'),
    attempt: integer(row, 'attempt'),
    retryOf: nullableText(row, 'retry_of'),
    planId: nullableText(row, 'plan_id'),
    status: text(row, 'status'),
    startedAt: text(row, 'started_at'),
    endedAt: nullableText(row, 'ended_at')
  })
}

function toStep(row: Row): MissionStep {
  return MissionStep.parse({
    stepId: text(row, 'step_id'),
    executionId: text(row, 'execution_id'),
    index: integer(row, 'idx'),
    key: text(row, 'step_key'),
    kind: text(row, 'kind'),
    title: text(row, 'title'),
    description: text(row, 'description'),
    dependencies: json(row, 'dependencies_json'),
    required: integer(row, 'required') === 1,
    status: text(row, 'status'),
    detail: nullableText(row, 'detail'),
    route: parseNullable(row, 'route_json'),
    error: parseNullable(row, 'error_json'),
    attempts: integer(row, 'attempts'),
    maxAttempts: integer(row, 'max_attempts'),
    timeoutMs: nullableInteger(row, 'timeout_ms'),
    waitingFor: nullableText(row, 'waiting_for'),
    startedAt: nullableText(row, 'started_at'),
    completedAt: nullableText(row, 'completed_at')
  })
}
