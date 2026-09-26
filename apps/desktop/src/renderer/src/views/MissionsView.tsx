import { useEffect, useId, useState } from 'react'
import {
  MissionPriority,
  type DomainEvent,
  type ErrorEnvelope,
  type MissionAction,
  type MissionDetail,
  type MissionStep,
  type MissionSummary,
  type PlanSource
} from '@jupiter/contracts'
import { Icon } from '@jupiter/ui'
import type { ViewId } from '../../../shared/views'
import { request } from '../api'
import { Dialog } from '../components/Dialog'
import { Select, Switch } from '../components/FormControls'
import { ConfirmDialog } from '../components/InfoDialogs'
import { formatElapsed } from '../components/MissionCard'
import { ProgressIndicator } from '../components/Progress'
import { RouteBadge } from '../components/RouteBadge'
import { StateMessage } from '../components/StateMessage'
import { Timeline, type TimelineEntry } from '../components/Timeline'
import { intlLocale, useI18n, type MessageKey } from '../i18n'
import {
  MISSION_STATUS_TONE,
  checkName,
  describeMissionEvent,
  isMissionEvent,
  stepKindName,
  type StepTitleOf
} from '../missionText'
import { useMissionRoute } from '../router'
import { useRoutePreview } from '../useAi'
import { useMission, useMissionList } from '../useMissions'
import { coreSessionOf, envelopeOf, useRuntimeContext, type Loadable } from '../useRuntime'
import { LoadFailure } from './LoadFailure'
import {
  ApprovalNotice,
  PlanPanel,
  PlannerChoice,
  ReplanDialog,
  WorkflowView,
  branchNotTaken
} from './MissionWorkflow'
import { ViewHeader } from './ViewHeader'

/**
 * Missions (SET 4–5): every Mission, its real status and progress, its plan
 * and workflow, the step it is on and the next one, what it produced, how it
 * was verified, its whole history, and the recovery actions its state
 * allows. Nothing here is estimated: progress counts finished steps of the
 * current attempt, and every status comes from Jupiter Core's state machine.
 */

export function MissionsView({ onNavigate }: { readonly onNavigate: (view: ViewId) => void }) {
  const { t } = useI18n()
  const { status } = useRuntimeContext()
  const coreSession = coreSessionOf(status)
  const { missionId, openMission } = useMissionRoute()
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const missions = useMissionList(showArchived, coreSession)

  return (
    <section className="view view-missions" aria-labelledby="missions-title">
      <ViewHeader id="missions-title" title={t('nav.missions')}>
        <button
          type="button"
          className="button button-primary"
          data-testid="mission-new"
          disabled={coreSession === null}
          onClick={() => {
            setCreating(true)
          }}
        >
          <Icon name="add" size={18} />
          <span>{t('missions.new')}</span>
        </button>
      </ViewHeader>
      <p className="muted">{t('feature.missions')}</p>
      {coreSession === null ? (
        <StateMessage
          kind="unavailable"
          title={t('missions.coreDown')}
          testId="missions-core-down"
        />
      ) : null}
      <div className="missions-layout">
        <div className="mission-list-panel">
          <Switch
            label={t('missions.showArchived')}
            testId="missions-show-archived"
            checked={showArchived}
            onChange={setShowArchived}
          />
          <MissionList missions={missions} selected={missionId} onSelect={openMission} />
        </div>
        <div className="mission-detail-panel">
          {missionId === null ? (
            <StateMessage kind="empty" title={t('missions.noneSelected')} testId="mission-none">
              <p>{t('missions.noneSelectedHint')}</p>
            </StateMessage>
          ) : (
            <MissionPanel
              key={missionId}
              missionId={missionId}
              coreSession={coreSession}
              onNavigate={onNavigate}
            />
          )}
        </div>
      </div>
      <NewMissionDialog
        open={creating}
        coreSession={coreSession}
        onClose={() => {
          setCreating(false)
        }}
        onCreated={(detail) => {
          setCreating(false)
          openMission(detail.mission.missionId)
        }}
        onNavigate={onNavigate}
      />
    </section>
  )
}

function StatusBadgeFor({ status }: { readonly status: MissionSummary['status'] }) {
  const { t } = useI18n()
  return (
    <span
      className={`badge badge-${MISSION_STATUS_TONE[status] === 'info' ? 'info' : MISSION_STATUS_TONE[status]}`}
      data-testid="mission-status"
      data-status={status}
    >
      {t(`missionStatus.${status}` as MessageKey)}
    </span>
  )
}

function MissionList({
  missions,
  selected,
  onSelect
}: {
  readonly missions: Loadable<MissionSummary[]>
  readonly selected: string | null
  readonly onSelect: (missionId: string) => void
}) {
  const { t, locale } = useI18n()
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  if (missions.state === 'loading') return <p className="muted small">{t('load.loading')}</p>
  if (missions.state === 'error')
    return <LoadFailure title={t('missions.listFailed')} error={missions.error} />
  if (missions.value.length === 0)
    return (
      <p className="muted small" data-testid="missions-empty">
        {t('missions.empty')}
      </p>
    )
  return (
    <nav aria-label={t('nav.missions')}>
      <ul className="mission-list" data-testid="missions">
        {missions.value.map((mission) => (
          <li key={mission.missionId}>
            <button
              type="button"
              className="conversation-item mission-item"
              aria-current={mission.missionId === selected ? 'page' : undefined}
              data-testid="mission-item"
              data-mission-id={mission.missionId}
              data-status={mission.status}
              onClick={() => {
                onSelect(mission.missionId)
              }}
            >
              <span className="conversation-title">{mission.title}</span>
              <span className="mission-item-meta">
                <StatusBadgeFor status={mission.status} />
                <span className="muted small">
                  {mission.progress
                    ? t('missions.stepsDone', {
                        done: mission.progress.done,
                        total: mission.progress.total
                      })
                    : format.format(new Date(mission.updatedAt))}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function MissionPanel({
  missionId,
  coreSession,
  onNavigate
}: {
  readonly missionId: string
  readonly coreSession: string | null
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t } = useI18n()
  const { mission, replace } = useMission(missionId, coreSession)
  if (mission.state === 'loading') return <StateMessage kind="loading" title={t('load.loading')} />
  if (mission.state === 'error')
    return (
      <LoadFailure
        title={t('missions.loadFailed')}
        error={mission.error}
        testId="mission-load-failure"
      />
    )
  return (
    <MissionDetailView
      detail={mission.value.detail}
      timeline={mission.value.timeline}
      onChanged={replace}
      onNavigate={onNavigate}
    />
  )
}

/** Elapsed time from the first start to the end (or now, while it is not finished). */
function useElapsed(startedAt: string | null, endedAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt || endedAt) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [startedAt, endedAt])
  if (!startedAt) return null
  const end = endedAt ? Date.parse(endedAt) : now
  return formatElapsed(Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000)))
}

function MissionDetailView({
  detail,
  timeline,
  onChanged,
  onNavigate
}: {
  readonly detail: MissionDetail
  readonly timeline: readonly DomainEvent[]
  readonly onChanged: (detail: MissionDetail) => void
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t } = useI18n()
  const summary = detail.mission
  const [busy, setBusy] = useState<MissionAction | null>(null)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [replanning, setReplanning] = useState(false)
  const elapsed = useElapsed(summary.startedAt, summary.endedAt)
  const current = detail.steps.find((step) => step.stepId === detail.currentStepId) ?? null
  const next = detail.steps.find((step) => step.stepId === detail.nextStepId) ?? null
  const executionId = detail.executionHistory.at(-1)?.executionId ?? null

  const run = (action: MissionAction, work: () => Promise<MissionDetail>) => {
    setBusy(action)
    setFailure(null)
    work()
      .then(onChanged)
      .catch((error: unknown) => {
        setFailure(envelopeOf(error))
      })
      .finally(() => {
        setBusy(null)
      })
  }

  const act = (action: 'pause' | 'resume' | 'cancel' | 'retry' | 'archive') => {
    run(action, () => request(`missions.${action}`, { missionId: summary.missionId }))
  }
  const decide = (stepId: string, approved: boolean) => {
    run(approved ? 'approve' : 'reject', () =>
      request(approved ? 'missions.approve' : 'missions.reject', {
        missionId: summary.missionId,
        stepId
      })
    )
  }
  const stepName = (step: MissionStep) => step.title
  // Approve and Reject are answered where the question is shown (ApprovalNotice).
  const headerActions = detail.actions.filter(
    (action) => action !== 'approve' && action !== 'reject'
  )
  const stepTitles = new Map(
    detail.executionHistory.flatMap((execution) =>
      execution.steps.map((step) => [step.stepId, step.title] as const)
    )
  )

  return (
    <article
      className="mission-detail"
      aria-labelledby="mission-detail-title"
      data-testid="mission-detail"
      data-mission-id={summary.missionId}
      data-status={summary.status}
    >
      <header className="mission-detail-header">
        <div>
          <h2
            id="mission-detail-title"
            className="conversation-heading"
            data-testid="mission-title"
          >
            {summary.title}
          </h2>
          <p className="mission-badges">
            <StatusBadgeFor status={summary.status} />
            <span className="badge badge-muted">
              {t(`missionPriority.${summary.priority}` as MessageKey)}
            </span>
            {summary.attempt > 1 ? (
              <span className="badge badge-muted">
                {t('missions.attempt', { attempt: summary.attempt })}
              </span>
            ) : null}
            {summary.archived ? (
              <span className="badge badge-muted">{t('missions.archived')}</span>
            ) : null}
          </p>
        </div>
        <div className="actions" data-testid="mission-actions">
          {summary.pauseRequested ? (
            <span className="muted small" data-testid="mission-pausing">
              {t('missions.pausing')}
            </span>
          ) : null}
          {headerActions.map((action) => (
            <button
              key={action}
              type="button"
              className={`button${action === 'cancel' ? ' button-danger' : ''}`}
              data-testid={`mission-${action}`}
              disabled={busy !== null}
              onClick={() => {
                if (action === 'cancel') setConfirmCancel(true)
                else if (action === 'replan') setReplanning(true)
                else act(action)
              }}
            >
              {t(`missions.action.${action}` as MessageKey)}
            </button>
          ))}
        </div>
      </header>

      {failure ? (
        <LoadFailure
          title={t('missions.actionFailed')}
          error={failure}
          testId="mission-action-error"
        >
          {failure.category === 'configuration' ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                onNavigate('models')
              }}
            >
              {t('composer.openModels')}
            </button>
          ) : null}
        </LoadFailure>
      ) : null}

      <ApprovalNotice detail={detail} busy={busy !== null} onDecide={decide} />

      <section aria-labelledby="mission-request-title">
        <h3 id="mission-request-title">{t('missions.request')}</h3>
        <p className="message-text" data-testid="mission-request">
          {detail.userRequest}
        </p>
      </section>

      {summary.progress ? (
        <ProgressIndicator
          label={t('missions.progress')}
          completed={summary.progress.done}
          total={summary.progress.total}
          testId="mission-detail-progress"
        />
      ) : null}

      <dl className="facts mission-facts">
        <div>
          <dt>{t('missions.currentStep')}</dt>
          <dd data-testid="mission-current-step">{current ? stepName(current) : '—'}</dd>
        </div>
        <div>
          <dt>{t('missions.nextStep')}</dt>
          <dd data-testid="mission-next-step">{next ? stepName(next) : '—'}</dd>
        </div>
        <div>
          <dt>{t('mission.elapsed')}</dt>
          <dd data-testid="mission-detail-elapsed">{elapsed ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('mission.model')}</dt>
          <dd data-testid="mission-model">{summary.model ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('mission.agent')}</dt>
          <dd>
            <span className="badge badge-muted">{t('availability.COMING_LATER')}</span>{' '}
            <span className="muted small">{t('missions.agentLater')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('missions.skills')}</dt>
          <dd>
            <span className="badge badge-muted">{t('availability.COMING_LATER')}</span>{' '}
            <span className="muted small">{t('missions.skillsLater')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('missions.permissions')}</dt>
          <dd data-testid="mission-permissions">
            {detail.permissions.length === 0 ? t('missions.noPermissions') : null}
            {detail.permissions.map((permission) => (
              <span key={permission.name} className="badge badge-muted">
                {permission.name}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      <PlanPanel
        detail={detail}
        onReplan={
          detail.actions.includes('replan')
            ? () => {
                setReplanning(true)
              }
            : null
        }
      />

      {summary.status === 'PARTIAL_SUCCESS' ? (
        <PartialOutcome detail={detail} stepName={stepName} />
      ) : null}

      <WorkflowView detail={detail} />

      <section aria-labelledby="mission-results-title">
        <h3 id="mission-results-title">{t('missions.results')}</h3>
        {detail.artifacts.filter((item) => item.executionId === executionId).length === 0 ? (
          <p className="muted small">{t('missions.noResults')}</p>
        ) : (
          detail.artifacts
            .filter((item) => item.executionId === executionId)
            .map((artifact) => (
              <details
                key={artifact.artifactId}
                className="tool-call"
                data-testid="mission-artifact"
                open
              >
                <summary>{artifact.title}</summary>
                <p className="message-text">{artifact.text}</p>
              </details>
            ))
        )}
      </section>

      <section aria-labelledby="mission-verification-title">
        <h3 id="mission-verification-title">{t('missions.verification')}</h3>
        {detail.verificationResults.filter((item) => item.executionId === executionId).length ===
        0 ? (
          <p className="muted small">{t('missions.noVerification')}</p>
        ) : (
          <ul className="plain-list" data-testid="mission-verification">
            {detail.verificationResults
              .filter((item) => item.executionId === executionId)
              .map((result) => (
                <li key={result.verificationId} data-passed={result.passed}>
                  <span className={`badge badge-${result.passed ? 'success' : 'error'}`}>
                    {t(result.passed ? 'missions.checkPassed' : 'missions.checkFailed')}
                  </span>{' '}
                  {checkName(result.check, t)} <span className="muted small">{result.detail}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <MissionTimeline
        events={timeline}
        stepTitle={(stepId, kind) => stepTitles.get(stepId) ?? stepKindName(kind, t)}
      />

      {detail.executionHistory.length > 0 ? (
        <section aria-labelledby="mission-history-title">
          <h3 id="mission-history-title">{t('missions.history')}</h3>
          <ExecutionHistory detail={detail} />
        </section>
      ) : null}

      {detail.errors.length > 0 ? (
        <details className="mission-errors" data-testid="mission-errors">
          <summary>{t('missions.errors', { count: detail.errors.length })}</summary>
          <ul className="plain-list">
            {detail.errors.map((record) => (
              <li key={record.errorId}>
                <code>{record.error.code}</code> {record.error.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <ReplanDialog
        open={replanning}
        detail={detail}
        onClose={() => {
          setReplanning(false)
        }}
        onDone={(next) => {
          setReplanning(false)
          onChanged(next)
        }}
      />
      <ConfirmDialog
        open={confirmCancel}
        title={t('missions.cancelTitle')}
        description={t('missions.cancelConfirm')}
        confirmLabel={t('missions.action.cancel')}
        testId="mission-cancel-dialog"
        onCancel={() => {
          setConfirmCancel(false)
        }}
        onConfirm={() => {
          setConfirmCancel(false)
          act('cancel')
        }}
      />
    </article>
  )
}

function PartialOutcome({
  detail,
  stepName
}: {
  readonly detail: MissionDetail
  readonly stepName: (step: MissionStep) => string
}) {
  const { t } = useI18n()
  const steps = detail.steps
  const done = steps.filter((step) => step.status === 'COMPLETED')
  // A branch left out by its condition is part of the plan, not something missing.
  const notDone = steps.filter(
    (step) => step.status !== 'COMPLETED' && !branchNotTaken(step, detail.plan, steps)
  )
  return (
    <div className="notice notice-warning" role="status" data-testid="mission-partial">
      <p className="notice-title">{t('missions.partialTitle')}</p>
      <p>{t('missions.partialDone', { steps: done.map(stepName).join(', ') || '—' })}</p>
      <p data-testid="mission-partial-missing">
        {t('missions.partialMissing', {
          steps:
            notDone
              .map((step) => `${stepName(step)} (${t(`stepStatus.${step.status}` as MessageKey)})`)
              .join(', ') || '—'
        })}
      </p>
    </div>
  )
}

function MissionTimeline({
  events,
  stepTitle
}: {
  readonly events: readonly DomainEvent[]
  readonly stepTitle: StepTitleOf
}) {
  const { t, locale } = useI18n()
  const time = new Intl.DateTimeFormat(intlLocale(locale), { timeStyle: 'short' })
  const full = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'medium'
  })
  const entries: TimelineEntry[] = [...events]
    .reverse()
    .filter(isMissionEvent)
    .map((event) => ({
      id: event.eventId,
      at: event.occurredAt,
      ...describeMissionEvent(event, t, stepTitle),
      details: (
        <dl className="facts facts-compact">
          <div>
            <dt>{t('diagnostics.eventTime')}</dt>
            <dd>{full.format(new Date(event.occurredAt))}</dd>
          </div>
          <div>
            <dt>{t('diagnostics.eventType')}</dt>
            <dd>
              <code>{event.type}</code>
            </dd>
          </div>
          <div>
            <dt>{t('activity.correlation')}</dt>
            <dd>
              <code>{event.correlationId}</code>
            </dd>
          </div>
        </dl>
      )
    }))
  return (
    <section aria-labelledby="mission-timeline-title" data-testid="mission-timeline-section">
      <h3 id="mission-timeline-title">{t('missions.timeline')}</h3>
      <Timeline
        entries={entries}
        collapsedCount={12}
        formatTime={(iso) => time.format(new Date(iso))}
        emptyText={t('missions.timelineEmpty')}
        testId="mission-timeline"
      />
    </section>
  )
}

function ExecutionHistory({ detail }: { readonly detail: MissionDetail }) {
  const { t, locale } = useI18n()
  const format = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'short',
    timeStyle: 'medium'
  })
  return (
    <div className="table-scroll">
      <table className="data-table" data-testid="mission-history">
        <thead>
          <tr>
            <th scope="col">{t('missions.attemptColumn')}</th>
            <th scope="col">{t('missions.plan')}</th>
            <th scope="col">{t('missions.statusColumn')}</th>
            <th scope="col">{t('missions.startedColumn')}</th>
            <th scope="col">{t('missions.endedColumn')}</th>
            <th scope="col">{t('missions.stepsColumn')}</th>
          </tr>
        </thead>
        <tbody>
          {[...detail.executionHistory].reverse().map((execution) => (
            <tr
              key={execution.executionId}
              data-testid="mission-execution"
              data-attempt={execution.attempt}
              data-status={execution.status}
            >
              <td>
                {execution.retryOf
                  ? t('missions.retryOf', { attempt: execution.attempt })
                  : String(execution.attempt)}
              </td>
              <td data-testid="execution-plan-revision">
                {execution.planId
                  ? String(
                      detail.planRevisions.find((plan) => plan.planId === execution.planId)
                        ?.revision ?? '—'
                    )
                  : '—'}
              </td>
              <td>{t(`executionStatus.${execution.status}` as MessageKey)}</td>
              <td>{format.format(new Date(execution.startedAt))}</td>
              <td>{execution.endedAt ? format.format(new Date(execution.endedAt)) : '—'}</td>
              <td className="small">
                {execution.steps
                  .map((step) => t(`stepStatus.${step.status}` as MessageKey))
                  .join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function NewMissionDialog({
  open,
  coreSession,
  onClose,
  onCreated,
  onNavigate
}: {
  readonly open: boolean
  readonly coreSession: string | null
  readonly onClose: () => void
  readonly onCreated: (detail: MissionDetail) => void
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('missions.new')}
      description={t('missions.newHint')}
      testId="mission-new-dialog"
    >
      {open ? (
        <NewMissionForm
          coreSession={coreSession}
          onCancel={onClose}
          onCreated={onCreated}
          onNavigate={onNavigate}
        />
      ) : null}
    </Dialog>
  )
}

function NewMissionForm({
  coreSession,
  onCancel,
  onCreated,
  onNavigate
}: {
  readonly coreSession: string | null
  readonly onCancel: () => void
  readonly onCreated: (detail: MissionDetail) => void
  readonly onNavigate: (view: ViewId) => void
}) {
  const { t } = useI18n()
  const requestId = useId()
  const titleId = useId()
  const route = useRoutePreview('chat', null, coreSession)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<MissionPriority>('normal')
  const [planner, setPlanner] = useState<PlanSource>('model')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ErrorEnvelope | null>(null)
  const ready = route.state === 'ready' && route.value.route !== null
  const problem = route.state === 'ready' ? route.value.problem : null

  return (
    <form
      className="dialog-form"
      data-testid="mission-new-form"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setFailure(null)
        request('missions.create', {
          request: text.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          priority,
          planner
        }).then(onCreated, (error: unknown) => {
          setFailure(envelopeOf(error))
          setBusy(false)
        })
      }}
    >
      <div className="field">
        <label htmlFor={requestId}>{t('missions.requestLabel')}</label>
        <textarea
          id={requestId}
          className="composer-input"
          rows={4}
          value={text}
          maxLength={8000}
          data-testid="mission-new-request"
          onChange={(event) => {
            setText(event.target.value)
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={titleId}>{t('missions.titleLabel')}</label>
        <input
          id={titleId}
          className="input"
          value={title}
          maxLength={120}
          data-testid="mission-new-title"
          onChange={(event) => {
            setTitle(event.target.value)
          }}
        />
      </div>
      <Select<MissionPriority>
        label={t('missions.priority')}
        testId="mission-new-priority"
        value={priority}
        onChange={setPriority}
        choices={MissionPriority.options.map((value) => ({
          value,
          label: t(`missionPriority.${value}` as MessageKey)
        }))}
      />
      <PlannerChoice value={planner} onChange={setPlanner} legend={t('planner.legend')} />
      <div className="composer-status small" data-testid="mission-new-route">
        {route.state === 'ready' && route.value.route ? (
          <RouteBadge route={route.value.route} />
        ) : null}
        {problem ? (
          <span>
            <span className="badge badge-muted">
              {t(
                problem.code === 'NO_MODEL_AVAILABLE'
                  ? 'availability.NOT_CONFIGURED'
                  : 'availability.UNAVAILABLE'
              )}
            </span>{' '}
            {problem.message}{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                onNavigate('models')
              }}
            >
              {t('composer.openModels')}
            </button>
          </span>
        ) : null}
      </div>
      {failure ? (
        <LoadFailure
          title={t('missions.createFailed')}
          error={failure}
          testId="mission-new-error"
        />
      ) : null}
      <div className="dialog-footer">
        <button type="button" className="button" onClick={onCancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="submit"
          className="button button-primary"
          data-testid="mission-new-create"
          disabled={busy || !ready || text.trim().length === 0}
        >
          {busy ? t('missions.creating') : t('missions.create')}
        </button>
      </div>
    </form>
  )
}
