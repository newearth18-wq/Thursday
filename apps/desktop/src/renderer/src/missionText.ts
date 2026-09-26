import type { DomainEvent, MissionStatus } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'

/**
 * Mission events in plain language (SET 4): the Mission timeline and the
 * Home activity feed read the same stored events the same way. Developer
 * details (event type, correlation id) are available on request, never by
 * default.
 */

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
  t: Translate
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
      return { tone: 'info', title: t('missionEvent.planned', { steps: event.payload.steps }) }
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
          step: t(`missionStep.${event.payload.kind}` as MessageKey)
        })
      }
    case 'mission.step_finished': {
      const step = t(`missionStep.${event.payload.kind}` as MessageKey)
      switch (event.payload.status) {
        case 'SUCCEEDED':
          return { tone: 'success', title: t('missionEvent.stepSucceeded', { step }) }
        case 'CANCELLED':
          return { tone: 'warning', title: t('missionEvent.stepCancelled', { step }) }
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
    case 'mission.artifact_recorded':
      return { tone: 'info', title: t('missionEvent.artifact', { title: event.payload.title }) }
    case 'mission.pause_requested':
      return { tone: 'info', title: t('missionEvent.pauseRequested') }
    case 'mission.archived':
      return { tone: 'info', title: t('missionEvent.archived') }
  }
}

export function checkName(check: string, t: Translate): string {
  return check === 'answer-present' || check === 'summary-present'
    ? t(`missionCheck.${check}`)
    : check
}
