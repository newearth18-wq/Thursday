import type { DomainEvent, SkillExecutionStatus, SkillHealthStatus } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Skill events in plain language (SET 6), for the Skill Center and the activity feed. */

type SkillEvent = Extract<DomainEvent, { type: `skill.${string}` }>

export const HEALTH_TONE: Record<SkillHealthStatus, Tone | 'muted'> = {
  HEALTHY: 'success',
  UNHEALTHY: 'error',
  UNKNOWN: 'muted'
}

export const EXECUTION_TONE: Record<SkillExecutionStatus, Tone> = {
  RUNNING: 'info',
  SUCCESS: 'success',
  FAILED: 'error',
  CANCELLED: 'warning',
  TIMEOUT: 'error',
  WAITING_APPROVAL: 'warning',
  WAITING_IDENTITY: 'warning'
}

export function isSkillEvent(event: DomainEvent): event is SkillEvent {
  return event.type.startsWith('skill.')
}

export function describeSkillEvent(event: SkillEvent, t: Translate): { title: string; tone: Tone } {
  switch (event.type) {
    case 'skill.registered':
      return {
        tone: 'info',
        title: t('skillEvent.registered', {
          skill: event.payload.skillId,
          version: event.payload.version
        })
      }
    case 'skill.state_changed':
      return {
        tone: 'info',
        title: t(event.payload.enabled ? 'skillEvent.enabled' : 'skillEvent.disabled', {
          skill: event.payload.skillId
        })
      }
    case 'skill.health_checked':
      return {
        tone:
          event.payload.status === 'UNHEALTHY'
            ? 'error'
            : event.payload.status === 'HEALTHY'
              ? 'success'
              : 'info',
        title: t('skillEvent.health', {
          skill: event.payload.skillId,
          status: t(`skillHealth.${event.payload.status}` as MessageKey)
        })
      }
    case 'skill.execution_started':
      return { tone: 'info', title: t('skillEvent.started', { skill: event.payload.skillId }) }
    case 'skill.execution_finished': {
      const tone = EXECUTION_TONE[event.payload.status]
      return {
        tone,
        title: t('skillEvent.finished', {
          skill: event.payload.skillId,
          status: t(`skillStatus.${event.payload.status}` as MessageKey)
        })
      }
    }
  }
}
