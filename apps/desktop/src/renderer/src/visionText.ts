import type { DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Vision and camera events in plain language (SET 13). No event carries an image or its text. */

type VisionEvent = Extract<DomainEvent, { type: `vision.${string}` | `camera.${string}` }>

export function isVisionEvent(event: DomainEvent): event is VisionEvent {
  return event.type.startsWith('vision.') || event.type.startsWith('camera.')
}

export function describeVisionEvent(
  event: VisionEvent,
  t: Translate
): { title: string; tone: Tone } {
  switch (event.type) {
    case 'vision.observed':
      return {
        tone: event.payload.tasks.some((task) => task.status === 'failed') ? 'warning' : 'info',
        title: t(
          event.payload.sentTo.includes('cloud')
            ? 'visionEvent.observedCloud'
            : 'visionEvent.observed',
          { source: t(`vision.source.${event.payload.source}` as MessageKey) }
        )
      }
    case 'camera.session':
      return event.payload.change === 'started'
        ? { tone: 'info', title: t('visionEvent.cameraStarted') }
        : { tone: 'info', title: t('visionEvent.cameraEnded', { frames: event.payload.frames }) }
    case 'camera.state_changed':
      return {
        tone: event.payload.state === 'ERROR' ? 'error' : 'info',
        title: t('visionEvent.cameraState', {
          state: t(`camera.state.${event.payload.state}` as MessageKey)
        })
      }
  }
}
