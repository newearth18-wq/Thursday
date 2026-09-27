import type { DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Voice events in plain language (SET 12). No event carries audio, a transcript or a reply. */

type VoiceEvent = Extract<DomainEvent, { type: `voice.${string}` }>

export function isVoiceEvent(event: DomainEvent): event is VoiceEvent {
  return event.type.startsWith('voice.')
}

export function describeVoiceEvent(event: VoiceEvent, t: Translate): { title: string; tone: Tone } {
  switch (event.type) {
    case 'voice.session':
      return event.payload.change === 'started'
        ? {
            tone: 'info',
            title: t('voiceEvent.started', {
              mode: t(`voiceMode.${event.payload.mode}` as MessageKey)
            })
          }
        : { tone: 'info', title: t('voiceEvent.ended') }
    case 'voice.state_changed':
      return {
        tone: event.payload.state === 'ERROR' ? 'error' : 'info',
        title: t('voiceEvent.state', {
          state: t(`voice.state.${event.payload.state}` as MessageKey)
        })
      }
    case 'voice.utterance_ready':
      return { tone: 'info', title: t('voiceEvent.ready') }
  }
}
