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
  type MissionPlan,
  type MissionPriority,
  type MissionStatus,
  type MissionStep,
  type MissionSummary,
  type RouteDecision,
  type StepKind
} from '@jupiter/contracts'
import { completeText } from '../ai/complete'
import type { OperationContext, ProviderService } from '../ai/providers'
import { JupiterError, createErrorEnvelope, describeError, toErrorEnvelope } from '../errors'
import type { EventBus } from '../events/event-bus'
import { uuidv7 } from '../ids'
import type { Logger } from '../logging/logger'
import type { DatabasePort, ExecutionRecord, MissionRecord } from '../ports'

/**
 * The Mission Manager (SET 4).
 *
 * A Mission's status changes only through `transition`, which applies the
 * state machine from the contract: an allowed change is stored with its
 * reason and published; a change the machine does not allow is stored as
 * rejected, published, and refused with `INVALID_MISSION_TRANSITION`.
 *
 * Work runs in the background, one step at a time. Between steps is the
 * only safe boundary: Pause takes effect there. Cancel aborts the active
 * step's signal, which closes its provider request at once. Retry creates a
 * new execution linked to the previous one; nothing is erased.
 *
 * What Jupiter can really execute in this build: asking the configured chat
 * model (SET 3) and checking what it produced. The plan is Jupiter's
 * standard answer plan; the planner arrives in SET 5.
 */

export interface MissionManagerOptions {
  readonly database: () => DatabasePort
  readonly providers: ProviderService
  readonly bus: EventBus
  readonly logger: Logger
  readonly now: () => Date
  /** No data from a provider for this long ends a model step. Default 120 s. */
  readonly idleTimeoutMs?: number
}

const CORE_ACTOR: Actor = { type: 'core', id: 'core' }
const MAX_LISTED = 200

export const ANSWER_PLAN: MissionPlan = {
  source: 'template',
  templateId: 'answer-v1',
  summary:
    'Jupiter’s standard answer plan: the chat model answers the request, writes a one-line summary (optional), and the answer is checked. The planner that plans each request arrives in SET 5.',
  steps: [
    { kind: 'model.answer', title: 'Answer the request with the chat model', required: true },
    { kind: 'model.summary', title: 'Write a one-line summary of the answer', required: false },
    { kind: 'verify.answer', title: 'Check that an answer was produced', required: true }
  ]
}

interface Run {
  readonly missionId: string
  readonly controller: AbortController
  readonly correlationId: string
  cancel: { actor: Actor; reason: string } | null
  shutdown: boolean
  done: Promise<void>
}

interface StepOutcome {
  readonly detail: string
  readonly route: RouteDecision | null
  readonly artifact: { readonly title: string; readonly text: string } | null
  readonly checks: readonly {
    readonly check: string
    readonly passed: boolean
    readonly detail: string
  }[]
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
    const executions = store.executions(missionId)
    const history: MissionExecution[] = executions.map((execution) => ({
      ...execution,
      steps: store.steps(execution.executionId)
    }))
    const steps = record.currentExecutionId ? store.steps(record.currentExecutionId) : []
    const current = steps.find((step) => step.status === 'RUNNING') ?? null
    const next = steps.find((step) => step.status === 'PENDING') ?? null
    return {
      mission: this.summaryOf(record, database),
      userRequest: record.userRequest,
      plan: record.plan,
      steps,
      currentStepId: current?.stepId ?? null,
      nextStepId: next?.stepId ?? null,
      permissions: [],
      artifacts: store.artifacts(missionId),
      errors: store.errors(missionId),
      verificationResults: store.verifications(missionId),
      executionHistory: history,
      transitions: store.transitions(missionId),
      actions: availableMissionActions({
        status: record.status,
        archived: record.archivedAt !== null,
        pauseRequested: record.pauseRequested
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

  // ---- commands ---------------------------------------------------------------------------

  create(
    input: { request: string; title?: string | undefined; priority?: MissionPriority | undefined },
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
        createdAt: now,
        updatedAt: now
      })
      this.publish(missionId, null, 'mission.created', { title, priority }, context)
    })
    this.launch(missionId, context.correlationId, (run) => this.prepareAndRun(run))
    return this.detail(missionId)
  }

  /** Pause at the next safe boundary: when the current step ends. */
  pause(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (record.status !== 'RUNNING') {
      this.reject(record, 'PAUSED', `A ${record.status} Mission cannot be paused.`, context)
    }
    if (!record.pauseRequested) {
      database.transactions.run(() => {
        database.missions.updateMission(missionId, { pauseRequested: true, updatedAt: this.now() })
        this.publish(missionId, record.currentExecutionId, 'mission.pause_requested', {}, context)
      })
    }
    return this.detail(missionId)
  }

  resume(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    this.transition(record, 'RUNNING', 'Resumed', context)
    if (record.currentExecutionId)
      database.missions.updateExecution(record.currentExecutionId, { status: 'RUNNING' })
    this.launch(missionId, context.correlationId, (run) => this.runSteps(run))
    return this.detail(missionId)
  }

  /** Stop the Mission now. The active step's signal is aborted, which ends its provider request. */
  async cancel(missionId: string, context: OperationContext): Promise<MissionDetail> {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (!canTransition(record.status, 'CANCELLED'))
      this.reject(record, 'CANCELLED', `A ${record.status} Mission cannot be cancelled.`, context)
    const run = this.active.get(missionId)
    if (run) {
      run.cancel = { actor: context.actor, reason: 'Cancelled by you' }
      run.controller.abort()
      await run.done
    } else {
      this.finishCancelled(this.load(missionId, database), null, context.actor, 'Cancelled by you')
    }
    return this.detail(missionId)
  }

  /** Run again as a new execution linked to the previous one. Nothing of earlier attempts is erased. */
  retry(missionId: string, context: OperationContext): MissionDetail {
    const database = this.options.database()
    const record = this.load(missionId, database)
    if (!TERMINAL_MISSION_STATUSES.has(record.status))
      this.reject(record, 'READY', `A ${record.status} Mission cannot be retried.`, context)
    // The same analysis as a new Mission: without a usable model nothing changes.
    this.assertModelAvailable()
    const previous = database.missions.executions(missionId).at(-1) ?? null
    database.transactions.run(() => {
      if (!record.plan) database.missions.updateMission(missionId, { plan: ANSWER_PLAN })
      this.transition(record, 'READY', 'Retry requested', context)
    })
    this.launch(missionId, context.correlationId, (run) => {
      this.startExecution(run, previous, context.actor)
      return this.runSteps(run)
    })
    return this.detail(missionId)
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
   * After Jupiter Core starts: work that was in progress when it stopped did
   * not finish, and is recorded as failed (Retry is available). Missions that
   * were ready to start are started.
   */
  recover(): { interrupted: number; started: number } {
    const database = this.options.database()
    const context = { correlationId: uuidv7(), actor: CORE_ACTOR }
    const stale = database.missions
      .inFlight()
      .filter((record) => !this.active.has(record.missionId))
    for (const record of stale) {
      const error = createErrorEnvelope({
        code: 'MISSION_INTERRUPTED',
        category: 'internal',
        message: 'Jupiter Core stopped while this Mission was running, so it did not finish.',
        userAction: 'Retry the Mission.',
        retryable: true,
        missionId: record.missionId
      })
      this.finish(record, 'FAILED', error.message, context.actor, error)
    }
    const ready = database.missions
      .listMissions({ includeArchived: false, limit: MAX_LISTED })
      .filter((record) => record.status === 'READY' && !this.active.has(record.missionId))
    for (const record of ready) {
      const previous = database.missions.executions(record.missionId).at(-1) ?? null
      this.launch(record.missionId, context.correlationId, (run) => {
        this.startExecution(run, previous, CORE_ACTOR)
        return this.runSteps(run)
      })
    }
    return { interrupted: stale.length, started: ready.length }
  }

  /** Shutdown: stop every active step. The Missions are recorded as interrupted at the next start. */
  async stopAll(): Promise<void> {
    const runs = [...this.active.values()]
    for (const run of runs) {
      run.shutdown = true
      run.controller.abort()
    }
    await Promise.race([
      Promise.all(runs.map((run) => run.done)),
      new Promise((resolve) => setTimeout(resolve, 3_000))
    ])
  }

  // ---- running ----------------------------------------------------------------------------

  private launch(
    missionId: string,
    correlationId: string,
    work: (run: Run) => Promise<void>
  ): void {
    const run: Run = {
      missionId,
      controller: new AbortController(),
      correlationId,
      cancel: null,
      shutdown: false,
      done: Promise.resolve()
    }
    this.active.set(missionId, run)
    // Started now, but a synchronous failure still lands in the handler below.
    run.done = new Promise<void>((resolve) => {
      resolve(work(run))
    })
      .catch((error: unknown) => {
        this.options.logger
          .child({ correlationId })
          .error(
            'mission.run.crashed',
            `A Mission run failed unexpectedly: ${describeError(error)}`
          )
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

  /** CREATED → ANALYZING → PLANNING → READY → RUNNING, then the steps. */
  private async prepareAndRun(run: Run): Promise<void> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    let record = this.load(run.missionId, database)
    this.transition(
      record,
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
    record = this.load(run.missionId, database)
    database.transactions.run(() => {
      this.transition(record, 'PLANNING', 'A chat model is available', context)
      database.missions.updateMission(run.missionId, { plan: ANSWER_PLAN, updatedAt: this.now() })
      this.publish(
        run.missionId,
        null,
        'mission.planned',
        { source: 'template', steps: ANSWER_PLAN.steps.length },
        context
      )
    })
    if (this.stopRequested(run)) return
    this.transition(
      this.load(run.missionId, database),
      'READY',
      'The plan needs no approval or identity check',
      context
    )
    if (this.stopRequested(run)) return
    this.startExecution(run, null, CORE_ACTOR)
    await this.runSteps(run)
  }

  /** A new execution (attempt), its steps from the plan, and READY → RUNNING. */
  private startExecution(run: Run, previous: ExecutionRecord | null, actor: Actor): void {
    const database = this.options.database()
    const record = this.load(run.missionId, database)
    const plan = record.plan ?? ANSWER_PLAN
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
        status: 'RUNNING',
        startedAt: now,
        endedAt: null
      })
      for (const [index, planned] of plan.steps.entries())
        database.missions.insertStep({
          stepId: uuidv7(),
          executionId,
          index,
          kind: planned.kind,
          title: planned.title,
          required: planned.required,
          status: 'PENDING',
          detail: null,
          route: null,
          error: null,
          startedAt: null,
          completedAt: null
        })
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
        attempt === 1 ? 'Started' : `Attempt ${String(attempt)} started`,
        context
      )
    })
  }

  /** Run the remaining steps of the current execution, one at a time. */
  private async runSteps(run: Run): Promise<void> {
    const database = this.options.database()
    const coreContext = { correlationId: run.correlationId, actor: CORE_ACTOR }
    for (;;) {
      const record = this.load(run.missionId, database)
      const executionId = record.currentExecutionId
      if (!executionId || (record.status !== 'RUNNING' && record.status !== 'VERIFYING')) return
      if (run.cancel) {
        this.finishCancelled(record, null, run.cancel.actor, run.cancel.reason)
        return
      }
      if (run.shutdown) return
      const steps = database.missions.steps(executionId)
      const step = steps.find((candidate) => candidate.status === 'PENDING')
      if (!step) {
        this.conclude(record, steps, coreContext)
        return
      }
      // Safe boundary: between steps.
      if (record.status === 'RUNNING' && record.pauseRequested) {
        database.transactions.run(() => {
          database.missions.updateMission(run.missionId, { pauseRequested: false })
          database.missions.updateExecution(executionId, { status: 'PAUSED' })
          this.transition(
            record,
            'PAUSED',
            'Paused at a safe point between steps, as requested',
            coreContext
          )
        })
        return
      }
      if (step.kind.startsWith('verify.') && record.status === 'RUNNING')
        this.transition(record, 'VERIFYING', 'Checking the results', coreContext)

      await this.runStep(run, record, step, steps)
      // The run can be cancelled while the step was running.
      const cancel = cancelOf(run)
      if (cancel) {
        this.finishCancelled(
          this.load(run.missionId, database),
          step.stepId,
          cancel.actor,
          cancel.reason
        )
        return
      }
      if (shuttingDown(run)) return
    }
  }

  private async runStep(
    run: Run,
    record: MissionRecord,
    step: MissionStep,
    steps: readonly MissionStep[]
  ): Promise<void> {
    const database = this.options.database()
    const context = { correlationId: run.correlationId, actor: CORE_ACTOR }
    const executionId = step.executionId
    database.transactions.run(() => {
      database.missions.updateStep(step.stepId, { status: 'RUNNING', startedAt: this.now() })
      this.publish(
        record.missionId,
        executionId,
        'mission.step_started',
        { stepId: step.stepId, index: step.index, kind: step.kind, model: null },
        context
      )
    })
    let outcome: StepOutcome
    try {
      outcome = await this.execute(run, record, step, steps)
    } catch (error) {
      if (run.cancel || run.shutdown) {
        database.transactions.run(() => {
          database.missions.updateStep(step.stepId, {
            status: 'CANCELLED',
            detail: run.cancel
              ? 'Stopped: the Mission was cancelled.'
              : 'Stopped: Jupiter was closing.',
            completedAt: this.now()
          })
          this.stepFinished(record.missionId, step, 'CANCELLED', null, context)
        })
        return
      }
      const envelope = toErrorEnvelope(error, {
        code: 'STEP_FAILED',
        category: 'internal',
        userAction: 'Retry the Mission.',
        retryable: true
      })
      this.options.logger
        .child({ correlationId: run.correlationId })
        .warn('mission.step.failed', `Step “${step.title}” failed: ${envelope.message}`, {
          code: envelope.code,
          missionId: record.missionId
        })
      database.transactions.run(() => {
        database.missions.updateStep(step.stepId, {
          status: 'FAILED',
          error: envelope,
          detail: step.required
            ? 'This step is required, so the Mission cannot complete.'
            : 'This step is optional; the Mission continues without it.',
          completedAt: this.now()
        })
        database.missions.insertError({
          errorId: uuidv7(),
          missionId: record.missionId,
          executionId,
          stepId: step.stepId,
          error: envelope,
          at: this.now()
        })
        this.stepFinished(record.missionId, step, 'FAILED', envelope.code, context)
        if (step.required) {
          for (const later of database.missions.steps(executionId))
            if (later.status === 'PENDING')
              database.missions.updateStep(later.stepId, {
                status: 'SKIPPED',
                detail: 'Not run: a required step before it failed.'
              })
        }
      })
      return
    }
    database.transactions.run(() => {
      const failedChecks = outcome.checks.filter((check) => !check.passed)
      for (const check of outcome.checks) {
        const verificationId = uuidv7()
        database.missions.insertVerification({
          verificationId,
          missionId: record.missionId,
          executionId,
          stepId: step.stepId,
          check: check.check,
          passed: check.passed,
          detail: check.detail,
          at: this.now()
        })
        this.publish(
          record.missionId,
          executionId,
          'mission.verification_recorded',
          { verificationId, check: check.check, passed: check.passed },
          context
        )
      }
      if (outcome.artifact) {
        const artifactId = uuidv7()
        database.missions.insertArtifact({
          artifactId,
          missionId: record.missionId,
          executionId,
          stepId: step.stepId,
          kind: 'text',
          title: outcome.artifact.title,
          text: outcome.artifact.text,
          createdAt: this.now()
        })
        this.publish(
          record.missionId,
          executionId,
          'mission.artifact_recorded',
          { artifactId, title: outcome.artifact.title },
          context
        )
      }
      if (failedChecks.length > 0) {
        const error = createErrorEnvelope({
          code: 'VERIFICATION_FAILED',
          category: 'internal',
          message: `Verification did not pass: ${failedChecks.map((check) => check.detail).join(' ')}`,
          userAction: 'Retry the Mission.',
          retryable: true,
          missionId: record.missionId,
          executionId
        })
        database.missions.updateStep(step.stepId, {
          status: 'FAILED',
          detail: outcome.detail,
          route: outcome.route,
          error,
          completedAt: this.now()
        })
        database.missions.insertError({
          errorId: uuidv7(),
          missionId: record.missionId,
          executionId,
          stepId: step.stepId,
          error,
          at: this.now()
        })
        this.stepFinished(record.missionId, step, 'FAILED', error.code, context)
        return
      }
      database.missions.updateStep(step.stepId, {
        status: 'SUCCEEDED',
        detail: outcome.detail,
        route: outcome.route,
        completedAt: this.now()
      })
      this.stepFinished(record.missionId, step, 'SUCCEEDED', null, context)
    })
  }

  /** What each step kind really does. */
  private async execute(
    run: Run,
    record: MissionRecord,
    step: MissionStep,
    steps: readonly MissionStep[]
  ): Promise<StepOutcome> {
    const database = this.options.database()
    const artifactOf = (kind: StepKind) => {
      const source = steps.find((candidate) => candidate.kind === kind)
      if (!source) return null
      return (
        database.missions
          .artifacts(record.missionId)
          .find((item) => item.stepId === source.stepId) ?? null
      )
    }
    const ask = async (prompt: string) => {
      const completion = await completeText(this.options.providers, {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        signal: run.controller.signal,
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
      return completion
    }
    const modelName = (route: RouteDecision) =>
      `${route.modelName ?? route.modelId} (${route.providerName})`

    switch (step.kind) {
      case 'model.answer': {
        const completion = await ask(record.userRequest)
        return {
          detail: `Answered by ${modelName(completion.route)}${completion.finishReason === 'length' ? '; the answer reached its length limit' : ''}.`,
          route: completion.route,
          artifact: { title: 'Answer', text: completion.text },
          checks: []
        }
      }
      case 'model.summary': {
        const answer = artifactOf('model.answer')
        if (!answer)
          throw new JupiterError('STEP_INPUT_MISSING', 'There is no answer to summarise.', {
            category: 'internal',
            userAction: 'Retry the Mission.'
          })
        const completion = await ask(
          `Summarise the following answer in one sentence.\n\n${answer.text}`
        )
        return {
          detail: `Summarised by ${modelName(completion.route)}.`,
          route: completion.route,
          artifact: { title: 'Summary', text: completion.text.trim() },
          checks: []
        }
      }
      case 'verify.answer': {
        const answer = artifactOf('model.answer')
        const summaryStep = database.missions
          .steps(step.executionId)
          .find((candidate) => candidate.kind === 'model.summary')
        const checks: { check: string; passed: boolean; detail: string }[] = [
          answer && answer.text.trim().length > 0
            ? {
                check: 'answer-present',
                passed: true,
                detail: `The answer is stored (${String(answer.text.length)} characters).`
              }
            : { check: 'answer-present', passed: false, detail: 'No answer was stored.' }
        ]
        if (summaryStep?.status === 'SUCCEEDED') {
          const summary = artifactOf('model.summary')
          checks.push(
            summary && summary.text.length > 0
              ? { check: 'summary-present', passed: true, detail: 'The summary is stored.' }
              : { check: 'summary-present', passed: false, detail: 'No summary was stored.' }
          )
        }
        return {
          detail: `${String(checks.filter((check) => check.passed).length)} of ${String(checks.length)} checks passed.`,
          route: null,
          artifact: null,
          checks
        }
      }
    }
  }

  /**
   * After the last step: COMPLETED needs at least one passed verification of
   * this execution and every required step succeeded; PARTIAL_SUCCESS is the
   * same with an optional step that did not succeed; anything else FAILED.
   */
  private conclude(
    record: MissionRecord,
    steps: readonly MissionStep[],
    context: Pick<OperationContext, 'correlationId' | 'actor'>
  ): void {
    const database = this.options.database()
    const executionId = record.currentExecutionId
    if (!executionId) return
    const verifications = database.missions
      .verifications(record.missionId)
      .filter((item) => item.executionId === executionId)
    const verified =
      verifications.some((item) => item.passed) && verifications.every((item) => item.passed)
    const failedRequired = steps.filter((step) => step.required && step.status !== 'SUCCEEDED')
    const notSucceeded = steps.filter((step) => step.status !== 'SUCCEEDED')
    if (failedRequired.length === 0 && verified) {
      if (record.status === 'RUNNING')
        this.transition(record, 'VERIFYING', 'Checking the results', context)
      const current = this.load(record.missionId, database)
      if (notSucceeded.length === 0) {
        this.finish(
          current,
          'COMPLETED',
          'Every step succeeded and the result was verified',
          CORE_ACTOR,
          null
        )
      } else {
        this.finish(
          current,
          'PARTIAL_SUCCESS',
          `Verified, but ${notSucceeded.map((step) => `“${step.title}” ${step.status.toLowerCase()}`).join(', ')}`,
          CORE_ACTOR,
          null
        )
      }
      return
    }
    const reason =
      failedRequired.length > 0
        ? `Required step “${failedRequired[0]?.title ?? ''}” ${failedRequired[0]?.status.toLowerCase() ?? 'failed'}`
        : 'No verification passed'
    this.finish(record, 'FAILED', reason, CORE_ACTOR, null)
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
      const executionId = record.currentExecutionId
      if (executionId) {
        for (const step of database.missions.steps(executionId)) {
          if (step.status === 'RUNNING')
            database.missions.updateStep(step.stepId, {
              status: 'FAILED',
              error,
              detail: 'Interrupted before it finished.',
              completedAt: this.now()
            })
          else if (step.status === 'PENDING')
            database.missions.updateStep(step.stepId, {
              status: 'SKIPPED',
              detail: 'Not run: the Mission ended first.'
            })
        }
        database.missions.updateExecution(executionId, {
          status: status,
          endedAt: this.now()
        })
      }
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

  private finishCancelled(
    record: MissionRecord,
    stoppedStepId: string | null,
    actor: Actor,
    reason: string
  ): void {
    const database = this.options.database()
    const context = { correlationId: uuidv7(), actor }
    database.transactions.run(() => {
      const executionId = record.currentExecutionId
      if (executionId) {
        for (const step of database.missions.steps(executionId)) {
          if (
            step.status === 'PENDING' ||
            (step.status === 'RUNNING' && step.stepId !== stoppedStepId)
          )
            database.missions.updateStep(step.stepId, {
              status: step.status === 'RUNNING' ? 'CANCELLED' : 'SKIPPED',
              detail: 'Not run: the Mission was cancelled.',
              ...(step.status === 'RUNNING' ? { completedAt: this.now() } : {})
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
    context: Pick<OperationContext, 'correlationId' | 'actor'>
  ): void {
    const database = this.options.database()
    const current = this.load(record.missionId, database)
    if (!canTransition(current.status, to))
      this.reject(
        current,
        to,
        `${current.status} cannot change to ${to} (allowed: ${MISSION_TRANSITIONS[current.status].join(', ') || 'none'}).`,
        context
      )
    if (to === 'COMPLETED') {
      const executionId = current.currentExecutionId
      const steps = executionId ? database.missions.steps(executionId) : []
      const passed = database.missions
        .verifications(current.missionId)
        .some((item) => item.executionId === executionId && item.passed)
      const unresolved = steps.filter((step) => step.required && step.status !== 'SUCCEEDED')
      if (!passed || unresolved.length > 0)
        this.reject(
          current,
          to,
          !passed
            ? 'COMPLETED needs at least one successful verification.'
            : `COMPLETED needs every required step to succeed; ${String(unresolved.length)} did not.`,
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
  private reject(
    record: MissionRecord,
    to: MissionStatus,
    reason: string,
    context: Pick<OperationContext, 'correlationId' | 'actor'>
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
      null,
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
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
    errorCode: string | null,
    context: Pick<OperationContext, 'correlationId' | 'actor'>
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
    const lastRoute = [...steps].reverse().find((step) => step.route !== null)?.route ?? null
    const latest = executions.at(-1) ?? null
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
          ? {
              done: steps.filter((step) => step.status !== 'PENDING' && step.status !== 'RUNNING')
                .length,
              total: steps.length
            }
          : null,
      currentStepTitle: running?.title ?? null,
      currentStepKind: running?.kind ?? null,
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
    context: Pick<OperationContext, 'correlationId' | 'actor'>
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

function cancelOf(run: Run): Run['cancel'] {
  return run.cancel
}

function shuttingDown(run: Run): boolean {
  return run.shutdown
}
