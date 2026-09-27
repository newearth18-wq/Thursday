import type { DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Memory and Obsidian notes events in plain language (SET 11). No event carries memory content. */

type MemoryEvent = Extract<DomainEvent, { type: `memory.${string}` | 'notes.changed' }>

export function isMemoryEvent(event: DomainEvent): event is MemoryEvent {
  return event.type.startsWith('memory.') || event.type === 'notes.changed'
}

export function describeMemoryEvent(
  event: MemoryEvent,
  t: Translate
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'memory.decided':
      return {
        tone:
          event.payload.decision === 'SAVE'
            ? 'success'
            : event.payload.decision === 'ASK_USER'
              ? 'warning'
              : 'info',
        title: t('memoryEvent.decided', {
          decision: t(`memory.decision.${event.payload.decision}`),
          reasons: event.payload.reasons.map((code) => t(`memory.reason.${code}`)).join('; ')
        })
      }
    case 'memory.saved':
      return {
        tone: 'success',
        title: t('memoryEvent.saved', {
          type: t(`memory.type.${event.payload.type}`),
          layer: t(`memory.layer.${event.payload.layer}`)
        })
      }
    case 'memory.changed':
      return {
        tone: event.payload.change === 'deleted' ? 'warning' : 'info',
        title: t(`memoryEvent.${event.payload.change}`)
      }
    case 'notes.changed':
      return {
        tone:
          event.payload.outcome === 'done'
            ? 'success'
            : event.payload.outcome === 'refused'
              ? 'warning'
              : 'error',
        title: t(`notesEvent.${event.payload.outcome}` as MessageKey, {
          op: t(`notesOp.${event.payload.op}` as MessageKey),
          path: event.payload.path,
          code: event.payload.errorCode ?? ''
        })
      }
  }
}
