import type { DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Identity events in plain language (SET 14). No event carries a template or a score. */

type IdentityEvent = Extract<DomainEvent, { type: `identity.${string}` }>

export function isIdentityEvent(event: DomainEvent): event is IdentityEvent {
  return event.type.startsWith('identity.')
}

export function describeIdentityEvent(
  event: IdentityEvent,
  t: Translate
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'identity.verification':
      return {
        tone:
          event.payload.outcome === 'verified' || event.payload.outcome === 'recognized'
            ? 'success'
            : event.payload.outcome === 'cancelled'
              ? 'info'
              : 'warning',
        title: t(`identityEvent.verification.${event.payload.outcome}` as MessageKey, {
          method: t(`identity.method.${event.payload.method}` as MessageKey),
          level: t(`identity.level.${event.payload.level}` as MessageKey)
        })
      }
    case 'identity.enrollment':
      return {
        tone: event.payload.change === 'deleted' ? 'warning' : 'info',
        title: t(`identityEvent.enrollment.${event.payload.change}` as MessageKey, {
          method: t(`identity.method.${event.payload.method}` as MessageKey)
        })
      }
    case 'identity.protection_changed':
      return {
        tone: 'info',
        title: t(
          event.payload.enabled ? 'identityEvent.protectionOn' : 'identityEvent.protectionOff'
        )
      }
    case 'identity.assurance_changed':
      return {
        tone: 'info',
        title: t('identityEvent.assurance', {
          level: t(`identity.level.${event.payload.level}` as MessageKey)
        })
      }
  }
}
