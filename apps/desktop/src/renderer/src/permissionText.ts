import type { DomainEvent, PermissionSubject, RiskLevel } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Permission events and requesters in plain language (SET 7). */

type PermissionEvent = Extract<DomainEvent, { type: `permission.${string}` }>

export const RISK_TONE: Record<RiskLevel, Tone> = {
  LOW: 'info',
  MEDIUM: 'warning',
  HIGH: 'error',
  CRITICAL: 'error'
}

export function isPermissionEvent(event: DomainEvent): event is PermissionEvent {
  return event.type.startsWith('permission.')
}

export function subjectText(subject: PermissionSubject, t: Translate): string {
  return t(`permission.subject.${subject.kind}` as MessageKey, { name: subject.name })
}

export function describePermissionEvent(
  event: PermissionEvent,
  t: Translate
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'permission.requested':
      return {
        tone: 'warning',
        title: t('permissionEvent.requested', { capability: event.payload.capability })
      }
    case 'permission.decided':
      return {
        tone: event.payload.decision === 'DENY' ? 'warning' : 'success',
        title: t('permissionEvent.decided', {
          capability: event.payload.capability,
          decision: t(`permission.decision.${event.payload.decision}` as MessageKey)
        })
      }
    case 'permission.grant_ended':
      return {
        tone: 'info',
        title: t('permissionEvent.ended', {
          capability: event.payload.capability,
          state: t(`permissions.state.${event.payload.state}` as MessageKey)
        })
      }
  }
}
