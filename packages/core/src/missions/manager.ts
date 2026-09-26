import {
  MISSION_TRANSITIONS,
  TERMINAL_MISSION_STATUSES,
  availableMissionActions,
  canTransition,
  missionTitleFrom,
  type Actor,
  type DomainEvent,
  type DomainEventType,
  type ErrorEnvelope,
  type EventPayload,
  type MissionDetail,
  type MissionExecution,
  type MissionPriority,
  type MissionStatus,
  type MissionStep,
  type MissionSummary,
  type OutputCheck,
  type Plan,
  type PlanIssue,
  type PlanSource,
  type PermissionRequest,
  type PlanStep,
  type RouteDecision,
  type StepStatus,
  type StepTypeInfo
} from '@jupiter/contracts'
import { completeText } from '../ai/complete'
import type { OperationContext, ProviderService } from '../ai/providers'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort, ExecutionRecord, MissionRecord } from '../ports'
import type { SkillRegistry } from '../skills/registry'
import {
  catalogueWith,
  skillStepType,
  stepTypeInfo,
  type StepTypeDefinition,
  type StepTypeLookup
} from '../workflow/catalogue'
import { plannerMessages, templatePlanDraft, type PlannerInput } from '../workflow/planner'
import { backoffBefore, parsePlanText, substitute, validatePlan } from '../workflow/validate'

/**
 * The Mission Manager (SET 4) and Workflow Engine (SET 5).
 *
 * A Mission's status changes only through `transition`, which applies the
 * state machine from the contract: an allowed change is stored with its
 * reason and published; a change the machine does not allow is stored as
 * rejected, published, and refused with `INVALID_MISSION_TRANSITION`.
 *
 * Planning: the Planner (the configured chat model, or Jupiter's template)
 * proposes a plan; only a plan that passes the strict schema and the plan
 * validator is stored, as a new revision, and run. Re-planning adds a
 * revision; earlier plans and executions are kept.
 *
 * Execution: the plan's steps form a dependency graph. A step starts once
 * every step it depends on has ended, so independent steps run in parallel
 * (at most `MAX_PARALLEL` at once). Each attempt has its own timeout; a
 * failed attempt is retried as the step's retry policy allows, after a
 * growing wait. A step's output is stored exactly once, in the same
 * transaction that completes it, and a step whose output is stored is never
 * run again (the step id is the idempotency key). Approval checkpoints wait
 * for a person. Pause takes effect when no step is running; Cancel aborts
 * every running step at once. Every change is durable, so after a restart
 * the workflow continues from its stored state.
 */

export interface MissionManagerOptions {
  readonly database: () => DatabasePort
  readonly providers: ProviderService
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  /** No data from a provider for this long ends a model request. Default 120 s. */
  readonly idleTimeoutMs?: number
  /** Most steps of one workflow running at once. Default 3. */
  readonly maxParallel?: number
  /** Registered Skills are step types too (SET 6). */
  readonly skills?: SkillRegistry
}

const CORE_ACTOR: Actor = { type: 'core', id: 'core' }
const MAX_LISTED = 200
const ENDED: ReadonlySet<StepStatus> = new Set(['COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED'])

interface StepTask {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

interface Run {
  readonly missionId: string
  readonly controller: AbortController
  readonly correlationId: string
  readonly tasks: Map<string, StepTask>
  cancel: { actor: Actor; reason: string } | null
  /** A required step failed: the other running steps are stopped. */
  halt: string | null
  shutdown: boolean
  wake: () => void
  done: Promise<void>
}

interface StepOutput {
  readonly text: string | null
  readonly detail: string
  readonly route: RouteDecision | null
}

type Context = Pick<OperationContext, 'correlationId' | 'actor'>

interface PlanRequest {
  readonly source: PlanSource
  readonly reason: string
  readonly feedback: string | null
}

export class MissionManager {
  private readonly active = new Map<string, Run>()

  constructor(private readonly options: MissionManagerOptions) {}

  get activeCount(): number {
    return this.active.size
  }

  // ---- queries ----------------------------------------------------------------------------

  list(includeArchived: boolean, limit: number): MissionSummary[] {
    const database = this.options.database()
    return database.missions
      .listMissions({ includeArchived, limit: Math.min(limit, MAX_LISTED) })
      .map((record) => this.summaryOf(record, database))
  }

  detail(missionId: string): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    const store = database.missions
    const history: MissionExecution[] = store.executions(missionId).map((execution) => ({
      ...execution,
      steps: store.steps(execution.executionId)
    }))
    const steps = record.currentExecutionId ? store.steps(record.currentExecutionId) : []
    const current =
      steps.find((step) => step.status === 'RUNNING') ??
      steps.find((step) => step.status === 'WAITING') ??
      null
    const next = steps.find((step) => step.status === 'PENDING') ?? null
    return {
      mission: this.summaryOf(record, database),
      userRequest: record.userRequest,
      plan: record.currentPlanId ? store.plan(record.currentPlanId) : null,
      planRevisions: store.plans(missionId),
      planRejections: store
        .planRejections(missionId)
        .map((rejection) => ({ at: rejection.at, issues: [...rejection.issues] })),
      steps,
      currentStepId: current?.stepId ?? null,
      nextStepId: next?.stepId ?? null,
      permissions: [],
      artifacts: store.artifacts(missionId),
      errors: store.errors(missionId),
      verificationResults: store.verifications(missionId),
      executionHistory: history,
      stepAttempts: record.currentExecutionId ? store.attempts(record.currentExecutionId) : [],
      transitions: store.transitions(missionId),
      actions: availableMissionActions({
        status: record.status,
        archived: record.archivedAt !== null,
        pauseRequested: record.pauseRequested,
        hasPlan: record.currentPlanId !== null
      })
    }
  }

  /** The Mission's stored events, oldest first. The timeline is rebuilt from these. */
  timeline(missionId: string): DomainEvent[] {
    const database = this.options.database()
    this.load(missionId, database)
    return database.events.readLatest(
      { types: null, streams: [{ kind: 'mission', id: missionId }], missionId: null },
      1000
    )
  }

  stepTypes(): StepTypeInfo[] {
    return stepTypeInfo(this.catalogue().types)
  }

  // ---- commands ---------------------------------------------------------------------------

  create(
    input: {
      request: string
      title?: string | undefined
      priority?: MissionPriority | undefined
      planner?: PlanSource | undefined
    },
    context: OperationContext
  ): MissionDetail {
    const database = this.options.database()
    const missionId = uuidv7()
    const now = this.now()
    const title = input.title ?? missionTitleFrom(input.request)
    const priority = input.priority ?? 'normal'
    database.transactions.run(() => {
      database.missions.insertMission({
        missionId,
        title,
        userRequest: input.request,
        priority,
        status: 'CREATED',
        pauseRequested: false,
        archivedAt: null,
        plan: null,
        currentExecutionId: null,
        currentPlanId: null,
        createdAt: now,
        updatedAt: now
      })
      this.publish(missionId, null, 'mission.created', { title, priority }, context)
    })
    const request: PlanRequest = {
      source: input.planner ?? 'template',
      reason: 'First plan',
      feedback: null
    }
    this.launch(missionId, context.correlationId, (run) => this.analyzeAndRun(run, request))
    return this.detail(missionId)
  }

  /** Pause at the next safe boundary: once no step is running. */
  pause(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (record.status !== 'RUNNING') {
      this.refuse(record, 'PAUSED', `A ${record.status} Mission cannot be paused.`, context)
    }
    if (!record.pauseRequested) {
      database.transactions.run(() => {
        database.missions.updateMission(missionId, { pauseRequested: true, updatedAt: this.now() })
        this.publish(missionId, record.currentExecutionId, 'mission.pause_requested', {}, context)
      })
      this.active.get(missionId)?.wake()
    }
    return this.detail(missionId)
  }

  resume(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    // Not inside a transaction: a refused transition must stay recorded.
    this.transition(record, 'RUNNING', 'Resumed', context)
    if (record.currentExecutionId)
      database.missions.updateExecution(record.currentExecutionId, { status: 'RUNNING' })
    this.launch(missionId, context.correlationId, (run) => this.runWorkflow(run))
    return this.detail(missionId)
  }

  /** Stop the Mission now. Every running step's signal is aborted, which ends its work. */
  async cancel(missionId: string, context: OperationContext): Promise<MissionDetail> {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (!canTransition(record.status, 'CANCELLED'))
      this.refuse(record, 'CANCELLED', `A ${record.status} Mission cannot be cancelled.`, context)
    // Paused and waiting Missions have no live loop to stop.
    const idle = ['PAUSED', 'WAITING_APPROVAL', 'WAITING_IDENTITY'].includes(record.status)
    const run = idle ? undefined : this.active.get(missionId)
    if (run) {
      run.cancel = { actor: context.actor, reason: 'Cancelled by you' }
      run.controller.abort()
      run.wake()
      await run.done
    }
    const after = this.load(missionId, database)
    if (after.status !== 'CANCELLED' && canTransition(after.status, 'CANCELLED'))
      this.finishCancelled(after, context.actor, 'Cancelled by you')
    return this.detail(missionId)
  }

  /** Run the same plan again as a new execution linked to the previous one. Nothing is erased. */
  retry(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (!TERMINAL_MISSION_STATUSES.has(record.status))
      this.refuse(record, 'READY', `A ${record.status} Mission cannot be retried.`, context)
    if (!record.currentPlanId)
      throw new JupiterError('MISSION_NOT_PLANNED', 'This Mission has no plan to run again.', {
        category: 'validation',
        userAction: 'Re-plan it instead.'
      })
    // The same analysis as a new Mission: without a usable model nothing changes.
    this.assertModelAvailable()
    const previous = database.missions.executions(missionId).at(-1) ?? null
    this.transition(record, 'READY', 'Retry requested', context)
    this.launch(missionId, context.correlationId, (run) => {
      this.startExecution(run, previous, context.actor)
      return this.runWorkflow(run)
    })
    return this.detail(missionId)
  }

  /**
   * Plan again: a new plan revision that takes the person's corrections and
   * the last failure into account, then a new execution of it. Earlier plan
   * revisions and executions are kept.
   */
  replan(
    missionId: string,
    input: { feedback?: string | undefined; planner?: PlanSource | undefined },
    context: OperationContext
  ): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (!TERMINAL_MISSION_STATUSES.has(record.status))
      this.refuse(record, 'PLANNING', `A ${record.status} Mission cannot be re-planned.`, context)
    this.assertModelAvailable()
    const current = record.currentPlanId ? database.missions.plan(record.currentPlanId) : null
    const request: PlanRequest = {
      source: input.planner ?? current?.source ?? 'model',
      reason: input.feedback
        ? `Re-planned with your corrections: ${input.feedback}`
        : `Re-planned after the Mission ended ${record.status}`,
      feedback: input.feedback ?? null
    }
    this.transition(record, 'PLANNING', 'Re-plan requested', context)
    this.launch(missionId, context.correlationId, (run) => this.planAndRun(run, request))
    return this.detail(missionId)
  }

  /** Answer an approval checkpoint. */
  decide(
    missionId: string,
    stepId: string,
    approved: boolean,
    context: OperationContext
  ): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    const step = record.currentExecutionId
      ? database.missions.steps(record.currentExecutionId).find((item) => item.stepId === stepId)
      : undefined
    if (
      step?.status !== 'WAITING' ||
      step.waitingFor !== 'approval' ||
      this.catalogue().lookup(step.kind)?.checkpoint !== 'approval' ||
      (record.status !== 'RUNNING' && record.status !== 'WAITING_APPROVAL')
    )
      throw new JupiterError('STEP_NOT_WAITING', 'That step is not waiting for approval.', {
        category: 'validation',
        userAction: 'Reload the Mission to see what it is doing now.'
      })
    const now = this.now()
    database.transactions.run(() => {
      database.missions.insertAttempt({
        stepId,
        attempt: step.attempts + 1,
        outcome: approved ? 'completed' : 'failed',
        errorCode: approved ? null : 'APPROVAL_REJECTED',
        startedAt: step.startedAt ?? now,
        endedAt: now
      })
      if (approved) {
        database.missions.updateStep(stepId, {
          status: 'COMPLETED',
          attempts: step.attempts + 1,
          waitingFor: null,
          detail: 'Approved by you.',
          completedAt: now
        })
      } else {
        const error = createErrorEnvelope({
          code: 'APPROVAL_REJECTED',
          category: 'permission',
          message: `You rejected “${step.title}”.`,
          userAction: 'Re-plan the Mission, or leave it as it is.',
          retryable: false,
          missionId,
          executionId: step.executionId
        })
        database.missions.updateStep(stepId, {
          status: 'FAILED',
          attempts: step.attempts + 1,
          waitingFor: null,
          error,
          detail: step.required
            ? 'Rejected by you. This step is required, so the Mission cannot complete.'
            : 'Rejected by you. This step is optional; the Mission continues without it.',
          completedAt: now
        })
        database.missions.insertError({
          errorId: uuidv7(),
          missionId,
          executionId: step.executionId,
          stepId,
          error,
          at: now
        })
      }
      this.publish(
        missionId,
        step.executionId,
        'mission.approval_decided',
        { stepId, approved },
        context
      )
      this.stepFinished(missionId, step, approved ? 'COMPLETED' : 'FAILED', null, context)
      if (record.status === 'WAITING_APPROVAL') {
        database.missions.updateExecution(step.executionId, { status: 'RUNNING' })
        this.transition(
          record,
          'RUNNING',
          approved ? `Approved: ${step.title}` : `Rejected: ${step.title}`,
          context
        )
      }
    })
    // A workflow waiting for approval has no live loop; a running one is woken.
    const run = this.active.get(missionId)
    if (record.status === 'RUNNING' && run) run.wake()
    else this.launch(missionId, context.correlationId, (next) => this.runWorkflow(next))
    return this.detail(missionId)
  }

  /**
   * The person answered a permission request (SET 7). A step that waited for
   * it runs again on allow (a new attempt, which the new grant covers), or
   * fails on deny. The answer itself comes only from the Permission Engine.
   */
  permissionAnswered(request: PermissionRequest): void {
    if (!request.missionId || !request.stepId || request.status === 'PENDING') return
    const database = this.options.database()
    const record = database.missions.mission(request.missionId)
    if (!record?.currentExecutionId) return
    const step = database.missions
      .steps(record.currentExecutionId)
      .find((item) => item.stepId === request.stepId)
    if (
      step?.status !== 'WAITING' ||
      step.waitingFor !== 'approval' ||
      this.catalogue().lookup(step.kind)?.checkpoint ||
      (record.status !== 'RUNNING' && record.status !== 'WAITING_APPROVAL')
    )
      return
    const context = { correlationId: uuidv7(), actor: CORE_ACTOR }
    const allowed = request.status === 'ALLOWED'
    const now = this.now()
    database.transactions.run(() => {
      if (allowed) {
        database.missions.updateStep(step.stepId, {
          status: 'PENDING',
          waitingFor: null,
          detail: 'Permission given; it runs again.'
        })
      } else {
        const error = createErrorEnvelope({
          code: 'PERMISSION_DENIED',
          category: 'permission',
          message: `You did not allow “${request.summary}” for “${step.title}”.`,
          userAction: 'Re-plan the Mission without this step, or leave it as it is.',
          retryable: false,
          missionId: record.missionId,
          executionId: step.executionId
        })
        database.missions.updateStep(step.stepId, {
          status: 'FAILED',
          waitingFor: null,
          error,
          detail: step.required
            ? 'Permission denied. This step is required, so the Mission cannot complete.'
            : 'Permission denied. This step is optional; the Mission continues without it.',
          completedAt: now
        })
        database.missions.insertError({
          errorId: uuidv7(),
          missionId: record.missionId,
          executionId: step.executionId,
          stepId: step.stepId,
          error,
          at: now
        })
        this.stepFinished(record.missionId, step, 'FAILED', 'PERMISSION_DENIED', context)
      }
      if (record.status === 'WAITING_APPROVAL') {
        database.missions.updateExecution(step.executionId, { status: 'RUNNING' })
        this.transition(
          record,
          'RUNNING',
          allowed ? `Permission given: ${step.title}` : `Permission denied: ${step.title}`,
          context
        )
      }
    })
    const run = this.active.get(record.missionId)
    if (record.status === 'RUNNING' && run) run.wake()
    else this.launch(record.missionId, context.correlationId, (next) => this.runWorkflow(next))
  }

  archive(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (record.archivedAt !== null) return this.detail(missionId)
    if (!TERMINAL_MISSION_STATUSES.has(record.status))
      throw new JupiterError(
        'MISSION_NOT_ARCHIVABLE',
        `Only a finished Mission can be archived; this one is ${record.status}.`,
        { category: 'validation', userAction: 'Cancel it first, or wait for it to finish.' }
      )
    database.transactions.run(() => {
      database.missions.updateMission(missionId, { archivedAt: this.now(), updatedAt: this.now() })
      this.publish(missionId, record.currentExecutionId, 'mission.archived', {}, context)
    })
    return this.detail(missionId)
  }

  // ---- lifecycle --------------------------------------------------------------------------

  /**
   * After Jupiter Core starts. A workflow that was running continues from
   * its stored state: steps that were cut off are recorded as interrupted
   * attempts and run again (a step whose output is stored is not). Planning
   * that was cut off is recorded as failed, with Retry or Re-plan available.
   * Paused Missions and Missions waiting for approval keep waiting.
   */
  recover(): { interrupted: number; resumed: number; started: number } {
    const database = this.options.database()
    const context = { correlationId: uuidv7(), actor: CORE_ACTOR }
    this.renewPermissionWaits(context)
    const stale = database.missions
      .inFlight()
      .filter((record) => !this.active.has(record.missionId))
    let resumed = 0
    let interrupted = 0
    for (const record of stale) {
      const executionId = record.currentExecutionId
      if (
        (record.status === 'RUNNING' || record.status === 'VERIFYING') &&
        record.currentPlanId &&
        executionId
      ) {
        const now = this.now()
        let cut = 0
        database.transactions.run(() => {
          const recorded = database.missions.attempts(executionId)
          for (const step of database.missions.steps(executionId)) {
            if (step.status !== 'RUNNING') continue
            cut += 1
            if (
              step.attempts > 0 &&
              !recorded.some(
                (item) => item.stepId === step.stepId && item.attempt === step.attempts
              )
            )
              database.missions.insertAttempt({
                stepId: step.stepId,
                attempt: step.attempts,
                outcome: 'interrupted',
                errorCode: 'CORE_STOPPED',
                startedAt: step.startedAt ?? now,
                endedAt: now
              })
            database.missions.updateStep(step.stepId, {
              status: 'PENDING',
              detail: 'Interrupted when Jupiter Core stopped; it runs again.'
            })
          }
          this.publish(
            record.missionId,
            executionId,
            'mission.recovered',
            { interruptedSteps: cut },
            context
          )
        })
        resumed += 1
        this.launch(record.missionId, context.correlationId, (run) => this.runWorkflow(run))
        continue
      }
      interrupted += 1
      const error = createErrorEnvelope({
        code: 'MISSION_INTERRUPTED',
        category: 'internal',
        message:
          'Jupiter Core stopped while this Mission was being prepared, so it did not finish.',
        userAction: record.currentPlanId ? 'Retry the Mission.' : 'Re-plan the Mission.',
        retryable: true,
        missionId: record.missionId
      })
      this.finish(record, 'FAILED', error.message, context.actor, error)
    }
    const ready = database.missions
      .listMissions({ includeArchived: false, limit: MAX_LISTED })
      .filter(
        (record) =>
          record.status === 'READY' &&
          record.currentPlanId !== null &&
          !this.active.has(record.missionId)
      )
    for (const record of ready) {
      const previous = database.missions.executions(record.missionId).at(-1) ?? null
      this.launch(record.missionId, context.correlationId, (run) => {
        this.startExecution(run, previous, CORE_ACTOR)
        return this.runWorkflow(run)
      })
    }
    return { interrupted, resumed, started: ready.length }
  }

  /**
   * A permission request ends with the Core session that asked it (SET 7).
   * A step that was waiting for one runs again, and so asks again; its
   * Mission is running again (and is continued by `recover`).
   */
  private renewPermissionWaits(context: Context): void {
    const database = this.options.database()
    const records = database.missions
      .listMissions({ includeArchived: false, limit: MAX_LISTED })
      .filter((record) => record.status === 'WAITING_APPROVAL' || record.status === 'RUNNING')
    for (const record of records) {
      const executionId = record.currentExecutionId
      if (!executionId || this.active.has(record.missionId)) continue
      const waiting = database.missions
        .steps(executionId)
        .filter(
          (step) =>
            step.status === 'WAITING' &&
            step.waitingFor === 'approval' &&
            !this.catalogue().lookup(step.kind)?.checkpoint
        )
      if (waiting.length === 0) continue
      database.transactions.run(() => {
        for (const step of waiting)
          database.missions.updateStep(step.stepId, {
            status: 'PENDING',
            waitingFor: null,
            detail: 'Its permission request ended when Jupiter Core stopped; it asks again.'
          })
        if (record.status === 'WAITING_APPROVAL') {
          database.missions.updateExecution(executionId, { status: 'RUNNING' })
          this.transition(
            record,
            'RUNNING',
            'Permission requests ended when Jupiter Core stopped; asking again',
            context
          )
        }
      })
    }
  }

  /** Shutdown: stop every running step. The workflows continue at the next start. */
  async stopAll(): Promise<void> {
    const runs = [...this.active.values()]
    for (const run of runs) {
      run.shutdown = true
      run.controller.abort()
      run.wake()
    }
    await Promise.race([
      Promise.all(runs.map((run) => run.done)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
  }

  // ---- planning ---------------------------------------------------------------------------

  private launch(
    missionId: string,
    correlationId: string,
    work: (run: Run) => Promise<void>
  ): void {
    const run: Run = {
      missionId,
      controller: new AbortController(),
      correlationId,
      tasks: new Map(),
      cancel: null,
      halt: null,
      shutdown: false,
      wake: () => undefined,
      done: Promise.resolve()
    }
    this.active.set(missionId, run)
    // Started now, but a synchronous failure still lands in the handler below.
    run.done = new Promise<void>((resolve) => {
      resolve(work(run))
    })
      .catch(async (error: unknown) => {
        this.options.logger
          .child({ correlationId })
          .error(
            'mission.run.crashed',
            `A Mission run failed unexpectedly: ${describeError(error)}`
          )
        run.halt = 'Jupiter hit an internal error.'
        for (const task of run.tasks.values()) task.controller.abort()
        await settle(run)
        try {
          const record = this.options.database().missions.mission(missionId)
          if (record && canTransition(record.status, 'FAILED'))
            this.finish(
              record,
              'FAILED',
              'Jupiter hit an internal error while running this Mission.',
              CORE_ACTOR,
              toErrorEnvelope(error, {
                code: 'MISSION_RUN_FAILED',
                category: 'internal',
                userAction: 'Retry the Mission.',
                retryable: true
              })
            )
        } catch (failure) {
          this.options.logger.error('mission.run.not-recorded', describeError(failure))
        }
      })
      .finally(() => {
        if (this.active.get(missionId) === run) this.active.delete(missionId)
      })
  }

  /** CREATED → ANALYZING → PLANNING, then the plan runs. */
  private async analyzeAndRun(run: Run, request: PlanRequest): Promise<void> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    this.transition(
      this.load(run.missionId, database),
      'ANALYZING',
      'Checking what is needed to carry out the request',
      context
    )
    await Promise.resolve()
    if (this.stopRequested(run)) return
    try {
      this.assertModelAvailable()
    } catch (error) {
      const envelope = toErrorEnvelope(error, {
        code: 'NO_MODEL_AVAILABLE',
        category: 'configuration',
        userAction: 'Set up a model in AI models.',
        retryable: false
      })
      this.finish(
        this.load(run.missionId, database),
        'FAILED',
        envelope.message,
        CORE_ACTOR,
        envelope
      )
      return
    }
    this.transition(
      this.load(run.missionId, database),
      'PLANNING',
      request.source === 'model'
        ? 'A chat model is available; the planner is planning'
        : 'A chat model is available; using Jupiter’s answer plan',
      context
    )
    await this.planAndRun(run, request)
  }

  /** In PLANNING: make a plan revision, and run it if it is valid. */
  private async planAndRun(run: Run, request: PlanRequest): Promise<void> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    const plan = await this.makePlan(run, request)
    if (!plan || this.stopRequested(run)) return
    this.transition(
      this.load(run.missionId, database),
      'READY',
      `Plan revision ${String(plan.revision)} passed validation`,
      context
    )
    if (this.stopRequested(run)) return
    const previous = database.missions.executions(run.missionId).at(-1) ?? null
    this.startExecution(run, previous, CORE_ACTOR)
    await this.runWorkflow(run)
  }

  /**
   * Ask the planner for a plan and validate it. A plan that does not pass is
   * stored as a rejection with its reasons and the Mission fails: nothing of
   * it runs.
   */
  private async makePlan(run: Run, request: PlanRequest): Promise<Plan | null> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    const record = this.load(run.missionId, database)
    const previous = record.currentPlanId ? database.missions.plan(record.currentPlanId) : null
    let issues: readonly PlanIssue[]
    let draft = null
    if (request.source === 'template') {
      draft = templatePlanDraft(record.userRequest)
      issues = validatePlan(draft, this.catalogue().lookup)
    } else {
      const { system, user } = plannerMessages(
        {
          request: record.userRequest,
          previous,
          failure: this.lastFailure(record),
          feedback: request.feedback
        } satisfies PlannerInput,
        this.catalogue().types
      )
      let text: string
      try {
        const completion = await completeText(this.options.providers, {
          messages: [
            { role: 'system', text: system },
            { role: 'user', content: [{ type: 'text', text: user }] }
          ],
          signal: run.controller.signal,
          correlationId: run.correlationId,
          actor: CORE_ACTOR,
          ...(this.options.idleTimeoutMs === undefined
            ? {}
            : { idleTimeoutMs: this.options.idleTimeoutMs })
        })
        text = completion.text
      } catch (error) {
        if (this.stopRequested(run)) return null
        const envelope = toErrorEnvelope(error, {
          code: 'PLANNER_FAILED',
          category: 'provider',
          userAction: 'Re-plan the Mission, or choose another model.',
          retryable: true
        })
        this.finish(
          this.load(run.missionId, database),
          'FAILED',
          `The planner could not answer: ${envelope.message}`,
          CORE_ACTOR,
          envelope
        )
        return null
      }
      if (this.stopRequested(run)) return null
      const parsed = parsePlanText(text)
      if (parsed.ok) {
        draft = parsed.draft
        issues = validatePlan(draft, this.catalogue().lookup)
      } else issues = parsed.issues
    }
    if (!draft || issues.length > 0) {
      const found = issues.length > 0 ? issues : null
      const codes = [...new Set((found ?? []).map((issue) => issue.code))]
      const error = createErrorEnvelope({
        code: 'PLAN_INVALID',
        category: 'validation',
        message: `The planner’s plan was rejected (${codes.join(', ')}), so nothing ran.`,
        userAction: 'Re-plan, with corrections if something was misunderstood.',
        retryable: true,
        missionId: run.missionId
      })
      database.transactions.run(() => {
        database.missions.insertPlanRejection({
          rejectionId: uuidv7(),
          missionId: run.missionId,
          issues: (found ?? []).slice(0, 50),
          at: this.now()
        })
        this.publish(
          run.missionId,
          null,
          'mission.plan_rejected',
          { issues: Math.max(1, found?.length ?? 1), codes: codes.slice(0, 20) },
          context
        )
      })
      this.finish(this.load(run.missionId, database), 'FAILED', error.message, CORE_ACTOR, error)
      return null
    }
    const plan: Plan = {
      ...draft,
      planId: uuidv7(),
      missionId: run.missionId,
      revision: database.missions.plans(run.missionId).length + 1,
      previousPlanId: previous?.planId ?? null,
      source: request.source,
      reason: request.reason.slice(0, 500),
      createdAt: this.now()
    }
    database.transactions.run(() => {
      database.missions.insertPlan(plan)
      database.missions.updateMission(run.missionId, {
        currentPlanId: plan.planId,
        updatedAt: this.now()
      })
      this.publish(
        run.missionId,
        null,
        'mission.planned',
        {
          source: plan.source,
          steps: plan.steps.length,
          planId: plan.planId,
          revision: plan.revision
        },
        context
      )
    })
    return plan
  }

  /** The failure a re-plan answers: the last execution's failed step, or the last error. */
  private lastFailure(record: MissionRecord): PlannerInput['failure'] {
    const database = this.options.database()
    const executionId = record.currentExecutionId
    const failed = executionId
      ? database.missions.steps(executionId).find((step) => step.status === 'FAILED' && step.error)
      : undefined
    if (failed?.error) return { step: failed.key, error: failed.error }
    const error = database.missions.errors(record.missionId).at(-1)?.error
    return error ? { step: null, error } : null
  }

  // ---- running ----------------------------------------------------------------------------

  /** A new execution (attempt) of the current plan, its steps, and READY → RUNNING. */
  private startExecution(run: Run, previous: ExecutionRecord | null, actor: Actor): void {
    const database = this.options.database()
    const record = this.load(run.missionId, database)
    const plan = record.currentPlanId ? database.missions.plan(record.currentPlanId) : null
    if (!plan)
      throw new JupiterError('MISSION_NOT_PLANNED', 'This Mission has no plan to run.', {
        category: 'internal',
        userAction: 'Re-plan the Mission.'
      })
    const executionId = uuidv7()
    const attempt = (database.missions.executions(run.missionId).at(-1)?.attempt ?? 0) + 1
    const now = this.now()
    const context = { correlationId: run.correlationId, actor }
    database.transactions.run(() => {
      database.missions.insertExecution({
        executionId,
        missionId: run.missionId,
        attempt,
        retryOf: previous?.executionId ?? null,
        planId: plan.planId,
        status: 'RUNNING',
        startedAt: now,
        endedAt: null
      })
      for (const [index, planned] of plan.steps.entries())
        database.missions.insertStep(
          {
            stepId: uuidv7(),
            executionId,
            index,
            key: planned.id,
            kind: planned.skillId,
            title: planned.title,
            description: planned.description,
            dependencies: [...planned.dependencies],
            required: planned.required,
            status: 'PENDING',
            detail: null,
            route: null,
            error: null,
            attempts: 0,
            maxAttempts: this.catalogue().lookup(planned.skillId)?.checkpoint
              ? 1
              : planned.retryPolicy.maxAttempts,
            timeoutMs: planned.timeoutMs,
            waitingFor: null,
            startedAt: null,
            completedAt: null
          },
          planned
        )
      database.missions.updateMission(run.missionId, {
        currentExecutionId: executionId,
        pauseRequested: false,
        updatedAt: now
      })
      this.publish(
        run.missionId,
        executionId,
        'mission.execution_started',
        { executionId, attempt, retryOf: previous?.executionId ?? null },
        context
      )
      this.transition(
        this.load(run.missionId, database),
        'RUNNING',
        attempt === 1
          ? 'Started'
          : `Attempt ${String(attempt)} started (plan revision ${String(plan.revision)})`,
        context
      )
    })
  }

  /**
   * The workflow loop: start every step whose dependencies have ended (up to
   * the parallel limit), wait for one to end or for a request (cancel, pause,
   * approval), and repeat until nothing is left, then verify.
   */
  private async runWorkflow(run: Run): Promise<void> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    const maxParallel = this.options.maxParallel ?? 3
    for (;;) {
      if (run.cancel) {
        await settle(run)
        this.finishCancelled(
          this.load(run.missionId, database),
          run.cancel.actor,
          run.cancel.reason
        )
        return
      }
      if (run.shutdown) {
        await settle(run)
        return
      }
      const record = this.load(run.missionId, database)
      const executionId = record.currentExecutionId
      const plan = record.currentPlanId ? database.missions.plan(record.currentPlanId) : null
      if (!executionId || !plan || (record.status !== 'RUNNING' && record.status !== 'VERIFYING')) {
        await settle(run)
        return
      }
      const ready = this.resolve(record, plan, executionId, context)
      const steps = database.missions.steps(executionId)

      // A required step that did not complete ends the workflow: stop the others.
      const blocking = steps.find((step) => blocks(step, plan, steps))
      if (blocking) {
        if (run.tasks.size > 0) {
          run.halt = `Stopped: required step “${blocking.title}” did not complete.`
          for (const task of run.tasks.values()) task.controller.abort()
          await settle(run)
          continue
        }
        this.conclude(this.load(run.missionId, database), plan, context)
        return
      }

      // Pause: at a boundary, when no step is running.
      if (record.pauseRequested && record.status === 'RUNNING') {
        if (run.tasks.size === 0) {
          database.transactions.run(() => {
            database.missions.updateMission(run.missionId, { pauseRequested: false })
            database.missions.updateExecution(executionId, { status: 'PAUSED' })
            this.transition(
              record,
              'PAUSED',
              'Paused at a safe point, with no step running, as requested',
              context
            )
          })
          return
        }
      } else if (record.status === 'RUNNING') {
        for (const step of ready) {
          if (run.tasks.size >= maxParallel) break
          if (!run.tasks.has(step.stepId)) this.startTask(run, plan, step)
        }
      }

      if (run.tasks.size > 0) {
        await new Promise<void>((resolve) => {
          run.wake = resolve
          for (const task of run.tasks.values()) void task.promise.then(resolve)
        })
        run.wake = () => undefined
        continue
      }

      const now = database.missions.steps(executionId)
      const waiting = now.find((step) => step.status === 'WAITING')
      if (waiting) {
        database.transactions.run(() => {
          database.missions.updateExecution(executionId, { status: 'WAITING' })
          this.transition(
            record,
            waiting.waitingFor === 'identity' ? 'WAITING_IDENTITY' : 'WAITING_APPROVAL',
            `Waiting for you: ${waiting.title}`,
            context
          )
        })
        return
      }
      if (now.some((step) => step.status === 'PENDING')) {
        // Validation rules this out (no cycles, no missing dependencies); say so if it happens.
        throw new JupiterError('WORKFLOW_STUCK', 'No remaining step can start.', {
          category: 'internal',
          userAction: 'Re-plan the Mission.'
        })
      }
      this.conclude(this.load(run.missionId, database), plan, context)
      return
    }
  }

  /**
   * Decide every pending step whose dependencies have all ended: skip it
   * (its condition is not met, or something it needs did not complete), or
   * return it as ready to start.
   */
  private resolve(
    record: MissionRecord,
    plan: Plan,
    executionId: string,
    context: Context
  ): MissionStep[] {
    const database = this.options.database()
    const steps = database.missions.steps(executionId)
    const byKey = new Map(steps.map((step) => [step.key, step]))
    const ready: MissionStep[] = []
    database.transactions.run(() => {
      for (const step of steps) {
        if (step.status !== 'PENDING') continue
        const definition = definitionOf(plan, step)
        const dependencies = step.dependencies.map((key) => byKey.get(key))
        if (!dependencies.every((dependency) => dependency && ENDED.has(dependency.status)))
          continue
        const condition = definition?.condition ?? null
        let skip: string | null = null
        if (condition && !conditionMet(condition, byKey))
          skip = `Not run: “${byKey.get(condition.step)?.title ?? condition.step}” did not ${condition.outcome === 'completed' ? 'complete' : 'fail'}.`
        else {
          const missing = dependencies.find(
            (dependency) =>
              dependency &&
              dependency.status !== 'COMPLETED' &&
              !(condition?.step === dependency.key && condition.outcome === 'failed')
          )
          if (missing) skip = `Not run: “${missing.title}” did not complete.`
        }
        if (skip === null) {
          ready.push(step)
          continue
        }
        database.missions.updateStep(step.stepId, { status: 'SKIPPED', detail: skip })
        byKey.set(step.key, { ...step, status: 'SKIPPED' })
        this.stepFinished(record.missionId, step, 'SKIPPED', null, context)
      }
    })
    return ready
  }

  private startTask(run: Run, plan: Plan, step: MissionStep): void {
    const controller = new AbortController()
    const forward = () => {
      controller.abort()
    }
    run.controller.signal.addEventListener('abort', forward, { once: true })
    if (run.controller.signal.aborted) controller.abort()
    const promise = this.runStep(run, plan, step, controller.signal)
      .catch((error: unknown) => {
        this.options.logger
          .child({ correlationId: run.correlationId })
          .error('mission.step.crashed', `A step failed unexpectedly: ${describeError(error)}`)
        this.failStep(
          run,
          step,
          toErrorEnvelope(error, {
            code: 'STEP_FAILED',
            category: 'internal',
            userAction: 'Retry the Mission.',
            retryable: true
          })
        )
      })
      .finally(() => {
        run.controller.signal.removeEventListener('abort', forward)
        run.tasks.delete(step.stepId)
      })
    run.tasks.set(step.stepId, { controller, promise })
  }

  /** One step, attempt after attempt as its retry policy allows. */
  private async runStep(
    run: Run,
    plan: Plan,
    initial: MissionStep,
    signal: AbortSignal
  ): Promise<void> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    const missionId = run.missionId
    const definition = definitionOf(plan, initial)
    const type = this.catalogue().lookup(initial.kind)
    if (!definition || !type)
      throw new JupiterError('STEP_UNKNOWN', `Jupiter cannot run “${initial.title}”.`, {
        category: 'internal',
        userAction: 'Re-plan the Mission.'
      })

    // Idempotency: the step id is the key. Output already stored is never produced again.
    const stored = database.missions
      .artifacts(missionId)
      .find((artifact) => artifact.stepId === initial.stepId)
    if (stored) {
      database.transactions.run(() => {
        database.missions.updateStep(initial.stepId, {
          status: 'COMPLETED',
          detail: 'Its output was already stored, so it was not run again.',
          completedAt: this.now()
        })
        this.stepFinished(missionId, initial, 'COMPLETED', null, context)
      })
      return
    }

    if (type.checkpoint) {
      database.transactions.run(() => {
        database.missions.updateStep(initial.stepId, {
          status: 'WAITING',
          waitingFor: type.checkpoint,
          detail: (definition.input.question ?? definition.input.reason ?? initial.title).slice(
            0,
            500
          ),
          startedAt: this.now()
        })
        this.publish(
          missionId,
          initial.executionId,
          'mission.step_waiting',
          {
            stepId: initial.stepId,
            index: initial.index,
            waitingFor: type.checkpoint ?? 'approval'
          },
          context
        )
      })
      return
    }

    const counted = database.missions
      .attempts(initial.executionId)
      .filter((item) => item.stepId === initial.stepId && item.outcome !== 'interrupted').length
    let attempt = initial.attempts
    let used = counted
    for (;;) {
      attempt += 1
      used += 1
      const startedAt = this.now()
      database.transactions.run(() => {
        database.missions.updateStep(initial.stepId, {
          status: 'RUNNING',
          attempts: attempt,
          detail:
            used > 1
              ? `Attempt ${String(used)} of ${String(definition.retryPolicy.maxAttempts)}`
              : null,
          startedAt: initial.startedAt ?? startedAt
        })
        this.publish(
          missionId,
          initial.executionId,
          'mission.step_started',
          { stepId: initial.stepId, index: initial.index, kind: initial.kind, model: null },
          context
        )
      })
      const attemptController = new AbortController()
      const forward = () => {
        attemptController.abort()
      }
      signal.addEventListener('abort', forward, { once: true })
      if (signal.aborted) attemptController.abort()
      const watchdog = { timedOut: false }
      const timer = setTimeout(() => {
        watchdog.timedOut = true
        attemptController.abort()
      }, definition.timeoutMs)
      try {
        const output = await this.execute(
          run,
          initial,
          definition,
          attemptController.signal,
          attempt
        )
        if (definition.verification && output.text !== null) {
          const result = checkOutput(output.text, definition.verification)
          if (!result.passed)
            throw new JupiterError(
              'OUTPUT_CHECK_FAILED',
              `The output did not pass its check: ${result.detail}`,
              { category: 'provider', userAction: 'Retry the Mission.', retryable: true }
            )
        }
        this.completeStep(run, initial, attempt, startedAt, output)
        return
      } catch (error) {
        if (shuttingDown(run)) return // Recorded as interrupted at the next start.
        if (cancelOf(run) || haltOf(run)) {
          this.stopStep(run, initial, attempt, startedAt)
          return
        }
        if (error instanceof PermissionWait) {
          this.waitForPermission(run, initial, error)
          return
        }
        const envelope = watchdog.timedOut
          ? createErrorEnvelope({
              code: 'STEP_TIMEOUT',
              category: 'timeout',
              message: `“${initial.title}” did not finish within ${formatMs(definition.timeoutMs)}, so it was stopped.`,
              userAction: 'Retry the Mission, or re-plan it with a longer timeout.',
              retryable: true,
              missionId,
              executionId: initial.executionId
            })
          : toErrorEnvelope(error, {
              code: 'STEP_FAILED',
              category: 'internal',
              userAction: 'Retry the Mission.',
              retryable: true
            })
        const retry = used < definition.retryPolicy.maxAttempts && envelope.retryable
        const delayMs = retry ? backoffBefore(definition, used + 1) : 0
        database.transactions.run(() => {
          database.missions.insertAttempt({
            stepId: initial.stepId,
            attempt,
            outcome: watchdog.timedOut ? 'timed-out' : 'failed',
            errorCode: envelope.code.slice(0, 64),
            startedAt,
            endedAt: this.now()
          })
          database.missions.insertError({
            errorId: uuidv7(),
            missionId,
            executionId: initial.executionId,
            stepId: initial.stepId,
            error: envelope,
            at: this.now()
          })
          if (retry) {
            database.missions.updateStep(initial.stepId, {
              error: envelope,
              detail: `Attempt ${String(used)} failed (${envelope.code}); trying again in ${formatMs(delayMs)}.`
            })
            this.publish(
              missionId,
              initial.executionId,
              'mission.step_retry_scheduled',
              {
                stepId: initial.stepId,
                index: initial.index,
                nextAttempt: used + 1,
                delayMs,
                errorCode: envelope.code.slice(0, 64)
              },
              context
            )
          }
        })
        if (!retry) {
          this.failStep(run, initial, envelope)
          return
        }
        this.options.logger
          .child({ correlationId: run.correlationId })
          .warn('mission.step.retry', `Step “${initial.title}” will be tried again.`, {
            code: envelope.code,
            missionId
          })
        const waited = await sleep(delayMs, signal)
        if (!waited) {
          if (shuttingDown(run)) return
          this.stopStep(run, initial, null, null)
          return
        }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', forward)
      }
    }
  }

  /**
   * A step whose Skill needs the person's permission waits for the answer.
   * If the request was already answered while the Skill was stopping, the
   * answer applies at once.
   */
  private waitForPermission(run: Run, step: MissionStep, wait: PermissionWait): void {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    const request = database.permissions.request(wait.requestId)
    if (request && request.status !== 'PENDING') {
      if (request.status === 'ALLOWED') {
        database.missions.updateStep(step.stepId, {
          status: 'PENDING',
          waitingFor: null,
          detail: 'Permission given; it runs again.'
        })
        return
      }
      this.failStep(
        run,
        step,
        createErrorEnvelope({
          code: request.status === 'DENIED' ? 'PERMISSION_DENIED' : 'PERMISSION_EXPIRED',
          category: 'permission',
          message:
            request.status === 'DENIED'
              ? `You did not allow “${request.summary}” for “${step.title}”.`
              : `The permission request for “${step.title}” expired.`,
          userAction: 'Re-plan the Mission, or retry it to ask again.',
          retryable: false,
          missionId: run.missionId,
          executionId: step.executionId
        })
      )
      return
    }
    database.transactions.run(() => {
      database.missions.updateStep(step.stepId, {
        status: 'WAITING',
        waitingFor: 'approval',
        detail: wait.message.slice(0, 500)
      })
      this.publish(
        run.missionId,
        step.executionId,
        'mission.step_waiting',
        { stepId: step.stepId, index: step.index, waitingFor: 'approval' },
        context
      )
    })
  }

  /** What each step type really does. */
  private async execute(
    run: Run,
    step: MissionStep,
    definition: PlanStep,
    signal: AbortSignal,
    attempt: number
  ): Promise<StepOutput> {
    const database = this.options.database()
    const outputs = new Map<string, string>()
    const steps = database.missions.steps(step.executionId)
    for (const artifact of database.missions.artifacts(run.missionId)) {
      const source = steps.find((candidate) => candidate.stepId === artifact.stepId)
      if (source) outputs.set(source.key, artifact.text)
    }
    switch (step.kind) {
      case 'model.generate': {
        const prompt = substitute(definition.input.prompt ?? '', outputs)
        const completion = await completeText(this.options.providers, {
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal,
          correlationId: run.correlationId,
          actor: CORE_ACTOR,
          ...(this.options.idleTimeoutMs === undefined
            ? {}
            : { idleTimeoutMs: this.options.idleTimeoutMs }),
          onRoute: (route) => {
            database.missions.updateStep(step.stepId, { route })
          }
        })
        if (!completion.text.trim())
          throw new JupiterError(
            'STEP_NO_OUTPUT',
            `${completion.route.modelName ?? completion.route.modelId} returned no text.`,
            {
              category: 'provider',
              userAction: 'Retry the Mission, or choose another model.',
              retryable: true
            }
          )
        const model = `${completion.route.modelName ?? completion.route.modelId} (${completion.route.providerName})`
        return {
          text: completion.text,
          route: completion.route,
          detail: `Answered by ${model}${completion.finishReason === 'length' ? '; the answer reached its length limit' : ''}.`
        }
      }
      case 'text.compose': {
        const text = substitute(definition.input.template ?? '', outputs).slice(0, 200_000)
        return {
          text,
          route: null,
          detail: `Composed locally (${String(text.length)} characters).`
        }
      }
      default: {
        const type = this.catalogue().lookup(step.kind)
        if (type?.runner === 'skill' && this.options.skills)
          return this.runSkill(run, step, definition, outputs, attempt, signal)
        throw new JupiterError('STEP_UNKNOWN', `Jupiter cannot run “${step.kind}” steps.`, {
          category: 'unsupported',
          userAction: 'Re-plan the Mission.'
        })
      }
    }
  }

  /**
   * A step that is a registered Skill (SET 6): run through the Skill
   * Registry, which grants permissions, validates input and output, and
   * stops the Skill's runtime on timeout or cancel. The step attempt is the
   * idempotency key, so a retry is a new invocation and a replay is refused.
   */
  private async runSkill(
    run: Run,
    step: MissionStep,
    definition: PlanStep,
    outputs: ReadonlyMap<string, string>,
    attempt: number,
    signal: AbortSignal
  ): Promise<StepOutput> {
    const registry = this.options.skills
    if (!registry)
      throw new JupiterError('SKILL_RUNTIME_UNAVAILABLE', 'Skills are not available.', {
        category: 'dependency',
        userAction: 'Check the Skill Registry service in Diagnostics.'
      })
    const input = Object.fromEntries(
      Object.entries(definition.input).map(([name, value]) => [name, substitute(value, outputs)])
    )
    const result = await registry.invoke({
      executionId: uuidv7(),
      skillId: step.kind,
      input,
      missionId: run.missionId,
      missionTitle: this.options.database().missions.mission(run.missionId)?.title ?? null,
      stepId: step.stepId,
      stepTitle: step.title,
      timeoutMs: definition.timeoutMs,
      idempotencyKey: `mission-step:${step.stepId}:${String(attempt)}`,
      actor: CORE_ACTOR,
      correlationId: run.correlationId,
      signal
    })
    // The Skill needs a permission the person has not given yet: the step waits for the answer.
    const requestId = result.error?.sanitizedDetails?.requestId
    if (result.status === 'WAITING_APPROVAL' && typeof requestId === 'string')
      throw new PermissionWait(requestId, result.error?.message ?? 'Waiting for your permission.')
    if (result.status !== 'SUCCESS' || result.error)
      throw new JupiterError(
        result.error?.code ?? 'SKILL_FAILED',
        result.error?.message ?? `${step.title} did not succeed (${result.status}).`,
        {
          category: result.error?.category ?? 'internal',
          userAction: result.error?.userAction ?? 'Retry the Mission.',
          retryable: result.error?.retryable ?? false
        }
      )
    const output = result.output
    const fields = output && typeof output === 'object' ? Object.values(output) : []
    const text =
      fields.length === 1 && typeof fields[0] === 'string' ? fields[0] : JSON.stringify(output)
    return {
      text: text.slice(0, 200_000),
      route: null,
      detail: `Ran the Skill ${result.skillId} ${result.version}.`
    }
  }

  /** Built-in step types and the registered Skills, as they are now. */
  private catalogue(): { types: readonly StepTypeDefinition[]; lookup: StepTypeLookup } {
    const skills = (): StepTypeDefinition[] => {
      try {
        return this.options.skills?.search().map(skillStepType) ?? []
      } catch {
        // Registry not started (no database yet): only the built-in step types.
        return []
      }
    }
    return catalogueWith(skills())
  }

  private completeStep(
    run: Run,
    step: MissionStep,
    attempt: number,
    startedAt: string,
    output: StepOutput
  ): void {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    database.transactions.run(() => {
      if (output.text !== null) {
        const artifactId = uuidv7()
        database.missions.insertArtifact({
          artifactId,
          missionId: run.missionId,
          executionId: step.executionId,
          stepId: step.stepId,
          kind: 'text',
          title: step.title,
          text: output.text,
          createdAt: this.now()
        })
        this.publish(
          run.missionId,
          step.executionId,
          'mission.artifact_recorded',
          { artifactId, title: step.title },
          context
        )
      }
      database.missions.insertAttempt({
        stepId: step.stepId,
        attempt,
        outcome: 'completed',
        errorCode: null,
        startedAt,
        endedAt: this.now()
      })
      database.missions.updateStep(step.stepId, {
        status: 'COMPLETED',
        detail: output.detail,
        route: output.route,
        error: null,
        completedAt: this.now()
      })
      this.stepFinished(run.missionId, step, 'COMPLETED', null, context)
    })
  }

  private failStep(run: Run, step: MissionStep, error: ErrorEnvelope): void {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    this.options.logger
      .child({ correlationId: run.correlationId })
      .warn('mission.step.failed', `Step “${step.title}” failed: ${error.message}`, {
        code: error.code,
        missionId: run.missionId
      })
    database.transactions.run(() => {
      database.missions.updateStep(step.stepId, {
        status: 'FAILED',
        error,
        detail: step.required
          ? 'This step is required, so the Mission cannot complete.'
          : 'This step is optional; the Mission continues without it.',
        completedAt: this.now()
      })
      this.stepFinished(run.missionId, step, 'FAILED', error.code, context)
    })
  }

  /** A running step stopped by Cancel, or because a required step failed. */
  private stopStep(
    run: Run,
    step: MissionStep,
    attempt: number | null,
    startedAt: string | null
  ): void {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    database.transactions.run(() => {
      if (attempt !== null && startedAt !== null)
        database.missions.insertAttempt({
          stepId: step.stepId,
          attempt,
          outcome: 'cancelled',
          errorCode: null,
          startedAt,
          endedAt: this.now()
        })
      database.missions.updateStep(step.stepId, {
        status: 'CANCELLED',
        detail: run.cancel
          ? 'Stopped: the Mission was cancelled.'
          : (run.halt ?? 'Stopped.').slice(0, 500),
        completedAt: this.now()
      })
      this.stepFinished(run.missionId, step, 'CANCELLED', null, context)
    })
  }

  /**
   * After the last step: check the results against the plan's verification
   * plan. COMPLETED needs every check to pass and every step to have
   * completed (or been left out by its condition); PARTIAL_SUCCESS is the
   * same with an optional step that did not; anything else FAILED.
   */
  private conclude(record: MissionRecord, plan: Plan, context: Context): void {
    const database = this.options.database()
    const executionId = record.currentExecutionId
    if (!executionId) return
    const steps = database.missions.steps(executionId)
    const blocking = steps.filter((step) => blocks(step, plan, steps))
    if (blocking.length > 0) {
      const first = blocking[0]
      this.finish(
        record,
        'FAILED',
        `Required step “${first?.title ?? ''}” ${first?.status.toLowerCase() ?? 'failed'}`,
        CORE_ACTOR,
        null
      )
      return
    }
    if (record.status === 'RUNNING')
      this.transition(record, 'VERIFYING', 'Checking the results against the plan', context)
    const byKey = new Map(steps.map((step) => [step.key, step]))
    const artifacts = database.missions
      .artifacts(record.missionId)
      .filter((artifact) => artifact.executionId === executionId)
    const results: { passed: boolean; detail: string }[] = []
    database.transactions.run(() => {
      for (const check of plan.verificationPlan.checks) {
        const step = byKey.get(check.step)
        if (!step) continue
        const text = artifacts.find((artifact) => artifact.stepId === step.stepId)?.text ?? null
        // An optional step that did not run has nothing to check; the outcome says so.
        if (text === null && !step.required) continue
        const result =
          text === null
            ? { passed: false, detail: `“${step.title}” produced no output.` }
            : checkOutput(text, check)
        const detail = `${check.description}: ${result.detail}`.slice(0, 500)
        results.push({ passed: result.passed, detail })
        const verificationId = uuidv7()
        const name = `${check.step}-${check.check}`.slice(0, 64)
        database.missions.insertVerification({
          verificationId,
          missionId: record.missionId,
          executionId,
          stepId: step.stepId,
          check: name,
          passed: result.passed,
          detail,
          at: this.now()
        })
        this.publish(
          record.missionId,
          executionId,
          'mission.verification_recorded',
          { verificationId, check: name, passed: result.passed },
          context
        )
      }
    })
    const current = this.load(record.missionId, database)
    const failed = results.filter((result) => !result.passed)
    if (results.length === 0 || failed.length > 0) {
      const error = createErrorEnvelope({
        code: 'VERIFICATION_FAILED',
        category: 'internal',
        message:
          results.length === 0
            ? 'Nothing could be verified.'
            : `Verification did not pass: ${failed.map((result) => result.detail).join(' ')}`,
        userAction: 'Retry or re-plan the Mission.',
        retryable: true,
        missionId: record.missionId,
        executionId
      })
      this.finish(current, 'FAILED', error.message, CORE_ACTOR, error)
      return
    }
    const notDone = steps.filter(
      (step) => step.status !== 'COMPLETED' && !branchNotTaken(step, plan, byKey)
    )
    if (notDone.length === 0)
      this.finish(
        current,
        'COMPLETED',
        'Every step completed and the result was verified',
        CORE_ACTOR,
        null
      )
    else
      this.finish(
        current,
        'PARTIAL_SUCCESS',
        `Verified, but ${notDone.map((step) => `“${step.title}” ${step.status.toLowerCase()}`).join(', ')}`,
        CORE_ACTOR,
        null
      )
  }

  /** End the current execution with `status` and move the Mission there. */
  private finish(
    record: MissionRecord,
    status: 'COMPLETED' | 'PARTIAL_SUCCESS' | 'FAILED',
    reason: string,
    actor: Actor,
    error: ErrorEnvelope | null
  ): void {
    const database = this.options.database()
    const context = { correlationId: uuidv7(), actor }
    database.transactions.run(() => {
      // During planning, the current execution (if any) is an earlier, finished one.
      const started = !['CREATED', 'ANALYZING', 'PLANNING'].includes(record.status)
      const executionId = started ? record.currentExecutionId : null
      if (executionId && status === 'FAILED') {
        for (const step of database.missions.steps(executionId)) {
          if (step.status === 'RUNNING')
            database.missions.updateStep(step.stepId, {
              status: 'FAILED',
              error,
              detail: 'Interrupted before it finished.',
              completedAt: this.now()
            })
          else if (step.status === 'PENDING' || step.status === 'WAITING')
            database.missions.updateStep(step.stepId, {
              status: 'SKIPPED',
              waitingFor: null,
              detail: 'Not run: the Mission ended first.'
            })
        }
      }
      if (executionId)
        database.missions.updateExecution(executionId, { status, endedAt: this.now() })
      if (error)
        database.missions.insertError({
          errorId: uuidv7(),
          missionId: record.missionId,
          executionId,
          stepId: null,
          error,
          at: this.now()
        })
      database.missions.updateMission(record.missionId, { pauseRequested: false })
      this.transition(this.load(record.missionId, database), status, reason, context)
    })
  }

  private finishCancelled(record: MissionRecord, actor: Actor, reason: string): void {
    const database = this.options.database()
    const context = { correlationId: uuidv7(), actor }
    database.transactions.run(() => {
      const started = !['CREATED', 'ANALYZING', 'PLANNING'].includes(record.status)
      const executionId = started ? record.currentExecutionId : null
      if (executionId) {
        for (const step of database.missions.steps(executionId)) {
          if (step.status === 'PENDING' || step.status === 'RUNNING' || step.status === 'WAITING')
            database.missions.updateStep(step.stepId, {
              status: step.status === 'PENDING' ? 'SKIPPED' : 'CANCELLED',
              waitingFor: null,
              detail: 'Not run: the Mission was cancelled.',
              ...(step.status === 'PENDING' ? {} : { completedAt: this.now() })
            })
        }
        database.missions.updateExecution(executionId, { status: 'CANCELLED', endedAt: this.now() })
      }
      database.missions.updateMission(record.missionId, { pauseRequested: false })
      this.transition(this.load(record.missionId, database), 'CANCELLED', reason, context)
    })
  }

  // ---- state machine ----------------------------------------------------------------------

  /**
   * The only way a Mission's status changes. Guards beyond the table:
   * COMPLETED needs a passed verification of the current execution and no
   * required step left unresolved.
   */
  private transition(
    record: MissionRecord,
    to: MissionStatus,
    reason: string,
    context: Context
  ): void {
    const database = this.options.database()
    const current = this.load(record.missionId, database)
    if (!canTransition(current.status, to))
      this.refuse(
        current,
        to,
        `${current.status} cannot change to ${to} (allowed: ${MISSION_TRANSITIONS[current.status].join(', ') || 'none'}).`,
        context
      )
    if (to === 'COMPLETED') {
      const executionId = current.currentExecutionId
      const steps = executionId ? database.missions.steps(executionId) : []
      const plan = current.currentPlanId ? database.missions.plan(current.currentPlanId) : null
      const passed = database.missions
        .verifications(current.missionId)
        .some((item) => item.executionId === executionId && item.passed)
      const byKey = new Map(steps.map((step) => [step.key, step]))
      const unresolved = steps.filter(
        (step) =>
          step.required &&
          step.status !== 'COMPLETED' &&
          !(plan && branchNotTaken(step, plan, byKey))
      )
      if (!passed || unresolved.length > 0)
        this.refuse(
          current,
          to,
          !passed
            ? 'COMPLETED needs at least one successful verification.'
            : `COMPLETED needs every required step to complete; ${String(unresolved.length)} did not.`,
          context
        )
    }
    database.transactions.run(() => {
      database.missions.insertTransition({
        transitionId: uuidv7(),
        missionId: current.missionId,
        executionId: current.currentExecutionId,
        from: current.status,
        to,
        accepted: true,
        reason: reason.slice(0, 500),
        actor: context.actor.type,
        at: this.now()
      })
      database.missions.updateMission(current.missionId, { status: to, updatedAt: this.now() })
      this.publish(
        current.missionId,
        current.currentExecutionId,
        'mission.status_changed',
        { from: current.status, to, reason: reason.slice(0, 500) },
        context
      )
    })
  }

  /** Record a refused change (it is kept, published and audited by the dispatcher) and refuse it. */
  private refuse(
    record: MissionRecord,
    to: MissionStatus,
    reason: string,
    context: Context
  ): never {
    const database = this.options.database()
    database.transactions.run(() => {
      database.missions.insertTransition({
        transitionId: uuidv7(),
        missionId: record.missionId,
        executionId: record.currentExecutionId,
        from: record.status,
        to,
        accepted: false,
        reason: reason.slice(0, 500),
        actor: context.actor.type,
        at: this.now()
      })
      this.publish(
        record.missionId,
        record.currentExecutionId,
        'mission.transition_rejected',
        { from: record.status, requested: to, reason: reason.slice(0, 500) },
        context
      )
    })
    throw new JupiterError('INVALID_MISSION_TRANSITION', reason, {
      category: 'validation',
      userAction: 'Reload the Mission to see what it is doing now.'
    })
  }

  // ---- helpers ------------------------------------------------------------------------------

  private stopRequested(run: Run): boolean {
    if (run.shutdown) return true
    if (!run.cancel) return false
    this.finishCancelled(
      this.load(run.missionId, this.options.database()),
      run.cancel.actor,
      run.cancel.reason
    )
    return true
  }

  private assertModelAvailable(): void {
    const { result } = this.options.providers.route('chat', null)
    if (!result.ok)
      throw new JupiterError(result.error.code, result.error.message, {
        category: result.error.category,
        userAction: result.error.userAction,
        retryable: result.error.retryable
      })
  }

  private stepFinished(
    missionId: string,
    step: MissionStep,
    status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SKIPPED',
    errorCode: string | null,
    context: Context
  ): void {
    this.publish(
      missionId,
      step.executionId,
      'mission.step_finished',
      { stepId: step.stepId, index: step.index, kind: step.kind, status, errorCode },
      context
    )
  }

  private summaryOf(record: MissionRecord, database: DatabasePort): MissionSummary {
    const executions = database.missions.executions(record.missionId)
    const steps = record.currentExecutionId
      ? database.missions.steps(record.currentExecutionId)
      : []
    const running = steps.find((step) => step.status === 'RUNNING') ?? null
    const waiting = steps.find((step) => step.status === 'WAITING') ?? null
    const lastRoute = [...steps].reverse().find((step) => step.route !== null)?.route ?? null
    const latest = executions.at(-1) ?? null
    const plan = record.currentPlanId ? database.missions.plan(record.currentPlanId) : null
    return {
      missionId: record.missionId,
      title: record.title,
      status: record.status,
      priority: record.priority,
      archived: record.archivedAt !== null,
      pauseRequested: record.pauseRequested,
      attempt: latest?.attempt ?? 0,
      progress:
        steps.length > 0
          ? { done: steps.filter((step) => ENDED.has(step.status)).length, total: steps.length }
          : null,
      currentStepTitle: (running ?? waiting)?.title ?? null,
      currentStepKind: (running ?? waiting)?.kind ?? null,
      waitingFor: waiting?.waitingFor ?? null,
      planRevision: plan?.revision ?? null,
      model: lastRoute
        ? `${lastRoute.modelName ?? lastRoute.modelId} (${lastRoute.providerName})`
        : null,
      startedAt: executions[0]?.startedAt ?? null,
      endedAt: latest && TERMINAL_MISSION_STATUSES.has(record.status) ? latest.endedAt : null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }
  }

  private publish<T extends DomainEventType>(
    missionId: string,
    executionId: string | null,
    type: T,
    payload: EventPayload<T>,
    context: Context
  ): void {
    this.options.bus.publish({
      type,
      stream: { kind: 'mission', id: missionId },
      payload,
      persistent: true,
      correlationId: context.correlationId,
      actor: context.actor,
      missionId,
      executionId
    })
  }

  private load(missionId: string, database: DatabasePort): MissionRecord {
    const record = database.missions.mission(missionId)
    if (!record)
      throw new JupiterError('MISSION_NOT_FOUND', 'That Mission does not exist.', {
        category: 'validation',
        userAction: 'Reload the Missions list.'
      })
    return record
  }

  private now(): string {
    return this.options.now().toISOString()
  }
}

function definitionOf(plan: Plan, step: MissionStep): PlanStep | null {
  return plan.steps.find((candidate) => candidate.id === step.key) ?? null
}

function conditionMet(
  condition: NonNullable<PlanStep['condition']>,
  byKey: ReadonlyMap<string, MissionStep>
): boolean {
  const status = byKey.get(condition.step)?.status
  return condition.outcome === 'completed' ? status === 'COMPLETED' : status === 'FAILED'
}

/** A step left out on purpose: its condition was not met. */
function branchNotTaken(
  step: MissionStep,
  plan: Plan,
  byKey: ReadonlyMap<string, MissionStep>
): boolean {
  const condition = definitionOf(plan, step)?.condition
  return step.status === 'SKIPPED' && !!condition && !conditionMet(condition, byKey)
}

/** A required step that ended without completing (and was not a branch left out). */
function blocks(step: MissionStep, plan: Plan, steps: readonly MissionStep[]): boolean {
  if (!step.required) return false
  if (step.status === 'FAILED' || step.status === 'CANCELLED') return true
  if (step.status !== 'SKIPPED') return false
  return !branchNotTaken(step, plan, new Map(steps.map((item) => [item.key, item])))
}

function checkOutput(
  text: string,
  check: { readonly check: OutputCheck; readonly value?: string | undefined }
): { passed: boolean; detail: string } {
  if (check.check === 'non-empty')
    return text.trim().length > 0
      ? { passed: true, detail: `output present (${String(text.length)} characters).` }
      : { passed: false, detail: 'the output is empty.' }
  const value = check.value ?? ''
  return text.toLowerCase().includes(value.toLowerCase())
    ? { passed: true, detail: `the output contains “${value}”.` }
    : { passed: false, detail: `the output does not contain “${value}”.` }
}

/** Wait `ms`, or less if the signal aborts first. True when the full wait passed. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve(true)
    }, ms)
    const stop = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', stop, { once: true })
  })
}

async function settle(run: Run): Promise<void> {
  while (run.tasks.size > 0) await Promise.all([...run.tasks.values()].map((task) => task.promise))
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${String(ms)} ms` : `${String(Math.round(ms / 100) / 10)} s`
}

function cancelOf(run: Run): Run['cancel'] {
  return run.cancel
}

function haltOf(run: Run): string | null {
  return run.halt
}

function shuttingDown(run: Run): boolean {
  return run.shutdown
}

/** A Skill step stopped because it needs the person's permission (SET 7). */
class PermissionWait extends Error {
  constructor(
    readonly requestId: string,
    message: string
  ) {
    super(message)
    this.name = 'PermissionWait'
  }
}
