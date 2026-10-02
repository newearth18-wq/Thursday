import type { DomainEvent } from '@jupiter/contracts'
import type { MessageKey, Translate } from './i18n'
import type { Tone } from './missionText'

/** Plugin events in plain language (SET 15). No event carries plugin output. */

type PluginEvent = Extract<DomainEvent, { type: 'plugin.changed' }>

export function isPluginEvent(event: DomainEvent): event is PluginEvent {
  return event.type === 'plugin.changed'
}

const TONES: Record<PluginEvent['payload']['change'], Tone> = {
  installed: 'success',
  updated: 'success',
  enabled: 'success',
  recovered: 'success',
  disabled: 'info',
  uninstalled: 'info',
  degraded: 'warning',
  failed: 'error',
  'install-rejected': 'warning',
  'update-rejected': 'warning'
}

export function describePluginEvent(
  event: PluginEvent,
  t: Translate
): { title: string; tone: Tone } {
  const { pluginId, version, change } = event.payload
  return {
    tone: TONES[change],
    title: t(`pluginEvent.${change}` as MessageKey, {
      plugin: pluginId,
      version: version ?? '—'
    })
  }
}
