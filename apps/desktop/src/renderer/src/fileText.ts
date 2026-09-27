import type { DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** File Agent and Artifact Manager events in plain language (SET 10). */

type FileEvent = Extract<DomainEvent, { type: 'file.operation' | `artifact.${string}` }>

export function isFileEvent(event: DomainEvent): event is FileEvent {
  return event.type === 'file.operation' || event.type.startsWith('artifact.')
}

export function describeFileEvent(event: FileEvent, t: Translate): { title: string; tone: Tone } {
  switch (event.type) {
    case 'file.operation':
      return {
        tone:
          event.payload.outcome === 'done'
            ? 'success'
            : event.payload.outcome === 'refused'
              ? 'warning'
              : 'error',
        title: t(`fileEvent.${event.payload.outcome}` as MessageKey, {
          op: t(`fileOp.${event.payload.op}` as MessageKey),
          place: `${t(`files.root.${event.payload.root}` as MessageKey)}/${event.payload.path}`,
          code: event.payload.errorCode ?? ''
        })
      }
    case 'artifact.created':
      return {
        tone: event.payload.verificationStatus === 'VERIFIED' ? 'success' : 'error',
        title: t('fileEvent.artifactCreated', {
          name: event.payload.name,
          version: event.payload.version,
          status: t(`artifacts.status.${event.payload.verificationStatus}` as MessageKey)
        })
      }
    case 'artifact.changed':
      return {
        tone:
          event.payload.change === 'deleted' || event.payload.change === 'cleaned'
            ? 'warning'
            : 'info',
        title: t(`fileEvent.artifact.${event.payload.change}` as MessageKey, {
          status: t(`artifacts.status.${event.payload.verificationStatus}` as MessageKey)
        })
      }
  }
}
