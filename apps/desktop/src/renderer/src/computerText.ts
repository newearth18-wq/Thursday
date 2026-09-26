import type { ComputerTaskStatus, DomainEvent, InteractionMethod } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Computer Agent events and states in plain language (SET 8). */

type ComputerEvent = Extract<DomainEvent, { type: `computer.${string}` }>

export const TASK_TONE: Record<ComputerTaskStatus, Tone> = {
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'error',
  CANCELLED: 'warning',
  WAITING_APPROVAL: 'warning'
}

export function isComputerEvent(event: DomainEvent): event is ComputerEvent {
  return event.type.startsWith('computer.')
}

export function methodText(method: InteractionMethod, t: Translate): string {
  return t(`computerMethod.${method}` as MessageKey)
}

export function describeComputerEvent(
  event: ComputerEvent,
  t: Translate
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'computer.task_started':
      return {
        tone: 'info',
        title: t('computerEvent.started', { actions: event.payload.actions })
      }
    case 'computer.action_completed':
      return {
        tone: event.payload.success ? 'success' : 'error',
        title: t(
          event.payload.success ? 'computerEvent.actionDone' : 'computerEvent.actionFailed',
          {
            action: event.payload.action,
            method: methodText(event.payload.method, t)
          }
        )
      }
    case 'computer.task_finished':
      return {
        tone: TASK_TONE[event.payload.status],
        title: t('computerEvent.finished', {
          status: t(`computerStatus.${event.payload.status}` as MessageKey)
        })
      }
  }
}
