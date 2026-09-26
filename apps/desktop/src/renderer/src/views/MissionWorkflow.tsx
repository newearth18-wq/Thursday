import { useId, useState } from 'react'
import type {
  ErrorEnvelope,
  MissionDetail,
  MissionStep,
  Plan,
  PlanSource,
  StepAttempt
} from '@jupiter/contracts'
import { request } from '../api'
import { Dialog } from '../components/Dialog'
import { RadioGroup } from '../components/FormControls'
import { RouteBadge } from '../components/RouteBadge'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import { checkName, stepKindName } from '../missionText'
import { envelopeOf } from '../useRuntime'
import { LoadFailure } from './LoadFailure'

/**
 * The plan and the workflow of a Mission (SET 5): the plan in use with its
 * goal, assumptions and reasons, every earlier revision, plans that were
 * rejected and why, and the workflow as the Workflow Engine runs it —
 * steps grouped into stages by their dependencies, each with its real
 * status, attempts, time limit and condition. Nothing here is estimated.
 */

/** A step left out on purpose: its condition was not met. */
export function branchNotTaken(
  step: MissionStep,
  plan: Plan | null,
  steps: readonly MissionStep[]
): boolean {
  const condition = plan?.steps.find((item) => item.id === step.key)?.condition
  if (step.status !== 'SKIPPED' || !condition) return false
  const status = steps.find((item) => item.key === condition.step)?.status
  return condition.outcome === 'completed' ? status !== 'COMPLETED' : status !== 'FAILED'
}

/** Stage of each step: 1 for steps without dependencies, else one after its latest dependency. */
export function stagesOf(steps: readonly MissionStep[]): MissionStep[][] {
  const byKey = new Map(steps.map((step) => [step.key, step]))
  const depth = new Map<string, number>()
  const depthOf = (step: MissionStep, seen: Set<string>): number => {
    const known = depth.get(step.key)
    if (known !== undefined) return known
    if (seen.has(step.key)) return 0
    seen.add(step.key)
    let value = 0
    for (const key of step.dependencies) {
      const dependency = byKey.get(key)
      if (dependency) value = Math.max(value, depthOf(dependency, seen) + 1)
    }
    depth.set(step.key, value)
    return value
  }
  const stages: MissionStep[][] = []
  for (const step of steps) {
    const index = depthOf(step, new Set())
    ;(stages[index] ??= []).push(step)
  }
  return stages.filter((stage) => stage.length > 0)
}

const STEP_TONE: Record<MissionStep['status'], string> = {
  PENDING: 'muted',
  RUNNING: 'info',
  WAITING: 'warning',
  COMPLETED: 'success',
  FAILED: 'error',
  SKIPPED: 'muted',
  CANCELLED: 'warning'
}

export function PlanPanel({
  detail,
  onReplan
}: {
  readonly detail: MissionDetail
  readonly onReplan: (() => void) | null
}) {
  const { t, locale } = useI18n()
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const plan = detail.plan
  const rejection = detail.planRejections.at(-1) ?? null
  const rejectedLast =
    rejection !== null && (plan === null || Date.parse(rejection.at) > Date.parse(plan.createdAt))
  return (
    <section aria-labelledby="mission-plan-title" data-testid="mission-plan">
      <h3 id="mission-plan-title">{t('missions.plan')}</h3>
      {rejectedLast ? (
        <div className="notice notice-error" role="status" data-testid="plan-rejected">
          <p className="notice-title">{t('plan.rejectedTitle')}</p>
          <p>{t('plan.rejectedHint')}</p>
          <ul className="plain-list small">
            {rejection.issues.map((issue, index) => (
              <li key={index} data-code={issue.code}>
                <code>{issue.code}</code> {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan === null ? (
        <p className="muted small">
          {detail.executionHistory.length > 0 ? t('plan.legacy') : t('plan.none')}
        </p>
      ) : (
        <>
          <p className="mission-badges">
            <span className="badge badge-info" data-testid="plan-source" data-source={plan.source}>
              {t(plan.source === 'model' ? 'plan.sourceModel' : 'plan.sourceTemplate')}
            </span>
            <span className="badge badge-muted" data-testid="plan-revision">
              {t('plan.revision', { revision: plan.revision })}
            </span>
          </p>
          <dl className="facts plan-facts">
            <div>
              <dt>{t('plan.goal')}</dt>
              <dd data-testid="plan-goal">{plan.goal}</dd>
            </div>
            <div>
              <dt>{t('plan.assumptions')}</dt>
              <dd>
                {plan.assumptions.length === 0 ? (
                  t('plan.noAssumptions')
                ) : (
                  <ul className="plain-list" data-testid="plan-assumptions">
                    {plan.assumptions.map((assumption, index) => (
                      <li key={index}>{assumption}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            {plan.rationale ? (
              <div>
                <dt>{t('plan.rationale')}</dt>
                <dd data-testid="plan-rationale">{plan.rationale}</dd>
              </div>
            ) : null}
            {plan.expectedArtifacts.length > 0 ? (
              <div>
                <dt>{t('plan.expected')}</dt>
                <dd>
                  <ul className="plain-list">
                    {plan.expectedArtifacts.map((artifact, index) => (
                      <li key={index}>{artifact.description}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>{t('plan.checks')}</dt>
              <dd>
                <ul className="plain-list" data-testid="plan-checks">
                  {plan.verificationPlan.checks.map((check, index) => (
                    <li key={index}>
                      {check.description}{' '}
                      <span className="muted small">
                        ({checkName(`${check.step}-${check.check}`, t)})
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        </>
      )}
      {onReplan ? (
        <p className="plan-correct">
          <span className="muted small">{t('plan.correctHint')}</span>{' '}
          <button type="button" className="button" data-testid="plan-replan" onClick={onReplan}>
            {t('missions.action.replan')}
          </button>
        </p>
      ) : null}
      {detail.planRevisions.length > 1 ? (
        <details className="plan-revisions" data-testid="plan-revisions">
          <summary>{t('plan.revisions', { count: detail.planRevisions.length })}</summary>
          <ol className="plain-list small">
            {[...detail.planRevisions].reverse().map((revision) => (
              <li key={revision.planId} data-revision={revision.revision}>
                {t('plan.revisionEntry', {
                  revision: revision.revision,
                  when: format.format(new Date(revision.createdAt)),
                  reason: revision.reason
                })}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  )
}

/** The approval checkpoint step type; other steps wait only for a permission (SET 7). */
const APPROVAL_STEP = 'checkpoint.approval'

/** The approval a Mission is waiting for, with the only two answers. */
export function ApprovalNotice({
  detail,
  busy,
  onDecide
}: {
  readonly detail: MissionDetail
  readonly busy: boolean
  readonly onDecide: (stepId: string, approved: boolean) => void
}) {
  const { t } = useI18n()
  const waiting = detail.steps.find(
    (step) => step.status === 'WAITING' && step.waitingFor === 'approval'
  )
  if (
    !waiting ||
    (detail.mission.status !== 'WAITING_APPROVAL' && detail.mission.status !== 'RUNNING')
  )
    return null
  // A Skill step waiting for a permission is answered in the permission request, not here.
  if (waiting.kind !== APPROVAL_STEP)
    return (
      <div className="notice notice-warning" role="status" data-testid="mission-permission-wait">
        <p className="notice-title">{t('workflow.waitingPermission')}</p>
        <p>
          <strong>{waiting.title}</strong>
          {waiting.detail ? `: ${waiting.detail}` : null}
        </p>
        <p className="small">{t('workflow.permissionNotice')}</p>
      </div>
    )
  return (
    <div className="notice notice-warning" role="status" data-testid="mission-approval">
      <p className="notice-title">{t('workflow.waitingApproval')}</p>
      <p data-testid="mission-approval-question">
        <strong>{waiting.title}</strong>
        {waiting.detail ? `: ${waiting.detail}` : null}
      </p>
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="mission-approve"
          disabled={busy}
          onClick={() => {
            onDecide(waiting.stepId, true)
          }}
        >
          {t('missions.action.approve')}
        </button>
        <button
          type="button"
          className="button"
          data-testid="mission-reject"
          disabled={busy}
          onClick={() => {
            onDecide(waiting.stepId, false)
          }}
        >
          {t('missions.action.reject')}
        </button>
      </div>
    </div>
  )
}

export function WorkflowView({ detail }: { readonly detail: MissionDetail }) {
  const { t } = useI18n()
  const stages = stagesOf(detail.steps)
  const plan = detail.plan
  const execution = detail.executionHistory.at(-1) ?? null
  const revision = execution?.planId
    ? (detail.planRevisions.find((item) => item.planId === execution.planId)?.revision ?? null)
    : null
  const titleOf = (key: string) => detail.steps.find((step) => step.key === key)?.title ?? key
  return (
    <section aria-labelledby="mission-workflow-title" data-testid="mission-workflow">
      <div className="workflow-head">
        <h3 id="mission-workflow-title">{t('workflow.title')}</h3>
        {revision !== null ? (
          <span className="badge badge-muted" data-testid="workflow-revision">
            {t('workflow.revision', { revision })}
          </span>
        ) : null}
        {revision !== null && revision > 1 ? (
          <span className="badge badge-info" data-testid="workflow-replanned">
            {t('workflow.replanned')}
          </span>
        ) : null}
      </div>
      {detail.steps.length === 0 ? (
        <p className="muted small">{t('missions.noSteps')}</p>
      ) : (
        <ol className="workflow-stages" data-testid="mission-steps">
          {stages.map((stage, index) => (
            <li
              key={index}
              className="workflow-stage"
              data-testid="workflow-stage"
              aria-label={t('workflow.stage', { stage: index + 1 })}
            >
              <p className="workflow-stage-label muted small">
                {t('workflow.stage', { stage: index + 1 })}
                {stage.length > 1 ? ` · ${t('workflow.parallel')}` : ''}
              </p>
              <ul className="workflow-nodes">
                {stage.map((step) => (
                  <WorkflowNode
                    key={step.stepId}
                    step={step}
                    current={step.stepId === detail.currentStepId}
                    branchSkipped={branchNotTaken(step, plan, detail.steps)}
                    condition={plan?.steps.find((item) => item.id === step.key)?.condition ?? null}
                    attempts={detail.stepAttempts.filter((item) => item.stepId === step.stepId)}
                    titleOf={titleOf}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function WorkflowNode({
  step,
  current,
  branchSkipped,
  condition,
  attempts,
  titleOf
}: {
  readonly step: MissionStep
  readonly current: boolean
  readonly branchSkipped: boolean
  readonly condition: Plan['steps'][number]['condition']
  readonly attempts: readonly StepAttempt[]
  readonly titleOf: (key: string) => string
}) {
  const { t } = useI18n()
  // An attempt cut off by a restart does not use up the retry budget, so it is not counted here.
  const used = step.attempts - attempts.filter((item) => item.outcome === 'interrupted').length
  return (
    <li
      className="mission-step workflow-node"
      data-testid="mission-step"
      data-key={step.key}
      data-kind={step.kind}
      data-status={step.status}
      aria-current={current ? 'step' : undefined}
    >
      <div className="mission-step-head">
        <span className="mission-step-name">{step.title}</span>
        <span className={`badge badge-${STEP_TONE[step.status]}`} data-testid="step-status">
          {t(`stepStatus.${step.status}` as MessageKey)}
        </span>
        {step.required ? null : <span className="badge badge-muted">{t('missions.optional')}</span>}
        {current ? <span className="badge badge-info">{t('workflow.current')}</span> : null}
      </div>
      <p className="muted small">
        {stepKindName(step.kind, t)}
        {step.dependencies.length > 0
          ? ` · ${t('workflow.dependsOn', { steps: step.dependencies.map(titleOf).join(', ') })}`
          : ''}
      </p>
      {condition ? (
        <p className="small" data-testid="step-condition" data-branch-skipped={branchSkipped}>
          {t(
            condition.outcome === 'completed'
              ? 'workflow.conditionCompleted'
              : 'workflow.conditionFailed',
            { step: titleOf(condition.step) }
          )}
        </p>
      ) : null}
      {step.waitingFor ? (
        <p className="small" data-testid="step-waiting">
          {t(
            step.waitingFor === 'identity'
              ? 'workflow.waitingIdentity'
              : step.kind === APPROVAL_STEP
                ? 'workflow.waitingApproval'
                : 'workflow.waitingPermission'
          )}
        </p>
      ) : null}
      {step.detail ? <p className="muted small">{step.detail}</p> : null}
      <p className="muted small">
        {used > 0 ? (
          <span data-testid="step-attempts">
            {t('workflow.attempts', { attempts: used, max: step.maxAttempts })}
          </span>
        ) : null}
        {used > 0 && step.timeoutMs !== null ? ' · ' : null}
        {step.timeoutMs !== null && step.kind !== 'checkpoint.approval' ? (
          <span>{t('workflow.timeLimit', { seconds: Math.round(step.timeoutMs / 1000) })}</span>
        ) : null}
      </p>
      {attempts.length > 1 || attempts.some((item) => item.outcome !== 'completed') ? (
        <p className="small workflow-attempts" data-testid="step-attempt-list">
          <span className="muted">{t('workflow.attemptList')}:</span>{' '}
          {attempts.map((item) => (
            <span
              key={item.attempt}
              className={`badge badge-${item.outcome === 'completed' ? 'success' : item.outcome === 'interrupted' || item.outcome === 'cancelled' ? 'warning' : 'error'}`}
              data-outcome={item.outcome}
            >
              {item.attempt}: {t(`workflow.outcome.${item.outcome}` as MessageKey)}
              {item.errorCode ? ` (${item.errorCode})` : ''}
            </span>
          ))}
        </p>
      ) : null}
      {step.route ? <RouteBadge route={step.route} /> : null}
      {step.error ? (
        <p className="small mission-step-error">
          <code>{step.error.code}</code> {step.error.message}
        </p>
      ) : null}
    </li>
  )
}

export function ReplanDialog({
  open,
  detail,
  onClose,
  onDone
}: {
  readonly open: boolean
  readonly detail: MissionDetail
  readonly onClose: () => void
  readonly onDone: (detail: MissionDetail) => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('replan.title')}
      description={t('replan.hint')}
      testId="mission-replan-dialog"
    >
      {open ? <ReplanForm detail={detail} onCancel={onClose} onDone={onDone} /> : null}
    </Dialog>
  )
}

function ReplanForm({
  detail,
  onCancel,
  onDone
}: {
  readonly detail: MissionDetail
  readonly onCancel: () => void
  readonly onDone: (detail: MissionDetail) => void
}) {
  const { t } = useI18n()
  const feedbackId = useId()
  const [feedback, setFeedback] = useState('')
  const [planner, setPlanner] = useState<PlanSource>(detail.plan?.source ?? 'model')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  return (
    <form
      className="dialog-form"
      data-testid="mission-replan-form"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setFailure(null)
        request('missions.replan', {
          missionId: detail.mission.missionId,
          ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
          planner
        }).then(onDone, (error: unknown) => {
          setFailure(envelopeOf(error))
          setBusy(false)
        })
      }}
    >
      <div className="field">
        <label htmlFor={feedbackId}>{t('replan.feedback')}</label>
        <textarea
          id={feedbackId}
          className="composer-input"
          rows={4}
          value={feedback}
          maxLength={1000}
          data-testid="mission-replan-feedback"
          onChange={(event) => {
            setFeedback(event.target.value)
          }}
        />
      </div>
      <PlannerChoice value={planner} onChange={setPlanner} legend={t('replan.planner')} />
      {failure ? (
        <LoadFailure
          title={t('missions.actionFailed')}
          error={failure}
          testId="mission-replan-error"
        />
      ) : null}
      <div className="dialog-footer">
        <button type="button" className="button" onClick={onCancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="submit"
          className="button button-primary"
          data-testid="mission-replan-submit"
          disabled={busy}
        >
          {busy ? t('replan.busy') : t('replan.submit')}
        </button>
      </div>
    </form>
  )
}

export function PlannerChoice({
  value,
  onChange,
  legend
}: {
  readonly value: PlanSource
  readonly onChange: (value: PlanSource) => void
  readonly legend: string
}) {
  const { t } = useI18n()
  const name = useId()
  return (
    <RadioGroup<PlanSource>
      legend={legend}
      name={name}
      value={value}
      onChange={onChange}
      testId="mission-planner"
      choices={[
        { value: 'model', label: t('planner.model'), hint: t('planner.modelHint') },
        { value: 'template', label: t('planner.template'), hint: t('planner.templateHint') }
      ]}
    />
  )
}
