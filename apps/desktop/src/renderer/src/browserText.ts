import type { BrowserMethod, BrowserTaskStatus, DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Browser Agent events and states in plain language (SET 9). */

type BrowserEvent = Extract<DomainEvent, { type: `browser.${string}` }>

export const BROWSER_TASK_TONE: Record<BrowserTaskStatus, Tone> = {
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'warning',
  WAITING_APPROVAL: 'warning',
  SAFETY_STOP: 'error'
}

export function isBrowserEvent(event: DomainEvent): event is BrowserEvent {
  return event.type.startsWith('browser.')
}

export function browserMethodText(method: BrowserMethod, t: Translate): string {
  return t(`browserMethod.${method}` as MessageKey)
}

export function describeBrowserEvent(
  event: BrowserEvent,
  t: Translate
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'browser.task_started':
      return { tone: 'info', title: t('browserEvent.started', { actions: event.payload.actions }) }
    case 'browser.action_completed':
      return {
        tone: event.payload.success ? 'success' : 'error',
        title: t(event.payload.success ? 'browserEvent.actionDone' : 'browserEvent.actionFailed', {
          action: event.payload.action,
          origin: event.payload.origin ?? '—'
        })
      }
    case 'browser.suspicious_content':
      return {
        tone: 'warning',
        title: t('browserEvent.suspicious', {
          origin: event.payload.origin,
          kinds: event.payload.kinds.map((kind) => t(`suspicious.${kind}` as MessageKey)).join(', ')
        })
      }
    case 'browser.safety_stop':
      return {
        tone: 'error',
        title: t('browserEvent.safetyStop', { origin: event.payload.reached })
      }
    case 'browser.task_finished':
      return {
        tone: BROWSER_TASK_TONE[event.payload.status],
        title: t('browserEvent.finished', {
          status: t(`browserStatus.${event.payload.status}` as MessageKey)
        })
      }
  }
}
