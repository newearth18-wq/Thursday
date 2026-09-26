import type { DomainEvent, MissionStatus } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'

/**
 * Mission events in plain language (SET 4–5): the Mission timeline and the
 * Home activity feed read the same stored events the same way. Developer
 * details (event type, correlation id) are available on request, never by
 * default.
 */

/**
 * Step types with a name of their own: the Workflow Engine's catalogue (SET 5)
 * and the step kinds SET 4 Missions recorded.
 */
export const KNOWN_STEP_KINDS = [
  'model.generate',
  'text.compose',
  'checkpoint.approval',
  'checkpoint.identity',
  'model.answer',
  'model.summary',
  'verify.answer'
] as const

export function stepKindName(kind: string, t: Translate): string {
  return (KNOWN_STEP_KINDS as readonly string[]).includes(kind)
    ? t(`missionStep.${kind}` as MessageKey)
    : kind
}

/** How a step is called in an event: its title when known, else its type. */
export type StepTitleOf = (stepId: string, kind: string) => string

type MissionEvent = Extract<DomainEvent, { type: `mission.${string}` }>

export type Tone = 'info' | 'success' | 'warning' | 'error'

export const MISSION_STATUS_TONE: Record<MissionStatus, Tone> = {
  CREATED: 'info',
  ANALYZING: 'info',
  PLANNING: 'info',
  WAITING_APPROVAL: 'warning',
  WAITING_IDENTITY: 'warning',
  READY: 'info',
  RUNNING: 'info',
  PAUSED: 'warning',
  VERIFYING: 'info',
  COMPLETED: 'success',
  PARTIAL_SUCCESS: 'warning',
  FAILED: 'error',
  CANCELLED: 'warning'
}

export function isMissionEvent(event: DomainEvent): event is MissionEvent {
  return event.type.startsWith('mission.')
}

export function describeMissionEvent(
  event: MissionEvent,
  t: Translate,
  stepTitle: StepTitleOf = (_stepId, kind) => stepKindName(kind, t)
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'mission.created':
      return { tone: 'info', title: t('missionEvent.created', { title: event.payload.title }) }
    case 'mission.status_changed': {
      const { from, to } = event.payload
      if (from === 'PAUSED' && to === 'RUNNING')
        return { tone: 'info', title: t('missionEvent.resumed') }
      if (to === 'READY' && from !== 'PLANNING')
        return { tone: 'info', title: t('missionEvent.retryRequested') }
      if (to === 'PLANNING' && from !== 'ANALYZING')
        return { tone: 'info', title: t('missionEvent.replanRequested') }
      if (to === 'RUNNING' && (from === 'WAITING_APPROVAL' || from === 'WAITING_IDENTITY'))
        return { tone: 'info', title: t('missionEvent.continued') }
      return {
        tone: MISSION_STATUS_TONE[to],
        title: t(`missionEvent.status.${to}` as MessageKey)
      }
    }
    case 'mission.transition_rejected':
      return {
        tone: 'warning',
        title: t('missionEvent.rejected', {
          from: t(`missionStatus.${event.payload.from}` as MessageKey),
          to: t(`missionStatus.${event.payload.requested}` as MessageKey)
        })
      }
    case 'mission.planned':
      return {
        tone: 'info',
        title:
          event.payload.revision === undefined
            ? t('missionEvent.planned', { steps: event.payload.steps })
            : t(
                event.payload.source === 'model'
                  ? 'missionEvent.plannedByModel'
                  : 'missionEvent.plannedTemplate',
                { steps: event.payload.steps, revision: event.payload.revision }
              )
      }
    case 'mission.plan_rejected':
      return {
        tone: 'error',
        title: t('missionEvent.planRejected', {
          count: event.payload.issues,
          codes: event.payload.codes.join(', ')
        })
      }
    case 'mission.execution_started':
      return {
        tone: 'info',
        title:
          event.payload.attempt === 1
            ? t('missionEvent.executionStarted')
            : t('missionEvent.attemptStarted', { attempt: event.payload.attempt })
      }
    case 'mission.step_started':
      return {
        tone: 'info',
        title: t('missionEvent.stepStarted', {
          step: stepTitle(event.payload.stepId, event.payload.kind)
        })
      }
    case 'mission.step_finished': {
      const step = stepTitle(event.payload.stepId, event.payload.kind)
      switch (event.payload.status) {
        case 'SUCCEEDED':
        case 'COMPLETED':
          return { tone: 'success', title: t('missionEvent.stepSucceeded', { step }) }
        case 'CANCELLED':
          return { tone: 'warning', title: t('missionEvent.stepCancelled', { step }) }
        case 'SKIPPED':
          return { tone: 'info', title: t('missionEvent.stepSkipped', { step }) }
        default:
          return {
            tone: 'error',
            title: t('missionEvent.stepFailed', { step, code: event.payload.errorCode ?? '—' })
          }
      }
    }
    case 'mission.verification_recorded':
      return event.payload.passed
        ? {
            tone: 'success',
            title: t('missionEvent.checkPassed', { check: checkName(event.payload.check, t) })
          }
        : {
            tone: 'error',
            title: t('missionEvent.checkFailed', { check: checkName(event.payload.check, t) })
          }
    case 'mission.step_waiting':
      return {
        tone: 'warning',
        title: t('missionEvent.stepWaiting', {
          step: stepTitle(event.payload.stepId, 'checkpoint.approval')
        })
      }
    case 'mission.approval_decided': {
      const step = stepTitle(event.payload.stepId, 'checkpoint.approval')
      return event.payload.approved
        ? { tone: 'success', title: t('missionEvent.approved', { step }) }
        : { tone: 'warning', title: t('missionEvent.rejectedByYou', { step }) }
    }
    case 'mission.step_retry_scheduled':
      return {
        tone: 'warning',
        title: t('missionEvent.retryScheduled', {
          step: stepTitle(event.payload.stepId, ''),
          attempt: event.payload.nextAttempt,
          seconds: Math.round(event.payload.delayMs / 100) / 10,
          code: event.payload.errorCode
        })
      }
    case 'mission.recovered':
      return {
        tone: 'info',
        title: t('missionEvent.recovered', { count: event.payload.interruptedSteps })
      }
    case 'mission.artifact_recorded':
      return { tone: 'info', title: t('missionEvent.artifact', { title: event.payload.title }) }
    case 'mission.pause_requested':
      return { tone: 'info', title: t('missionEvent.pauseRequested') }
    case 'mission.archived':
      return { tone: 'info', title: t('missionEvent.archived') }
  }
}

/** A verification check in words: SET 4's named checks, or SET 5's `<step>-<check>`. */
export function checkName(check: string, t: Translate): string {
  if (check === 'answer-present' || check === 'summary-present') return t(`missionCheck.${check}`)
  const planned = /^(.+)-(non-empty|contains)$/.exec(check)
  if (planned?.[1] && planned[2])
    return t(`missionCheck.${planned[2]}` as MessageKey, { step: planned[1] })
  return check
}
