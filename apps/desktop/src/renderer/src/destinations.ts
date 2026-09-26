import type { IconName } from '@jupiter/ui'
import type { ViewId } from '../../shared/views'
import type { MessageKey } from './i18n'

/**
 * Every navigation destination, in sidebar order, with what is true about it
 * today. `available` screens work; the others open a screen that says
 * "Coming later" and which SET builds them — nothing on them works yet.
 */
export interface Destination {
  readonly id: ViewId
  readonly label: MessageKey
  readonly icon: IconName
  readonly availability: 'available' | 'COMING_LATER'
  /** The SET(s) of the Master Prompt that build this screen. */
  readonly plannedSet: string | null
  readonly group: 'main' | 'system'
  /** Keyboard shortcut, as `event.key` with Ctrl (and Shift where noted). */
  readonly shortcut: { readonly key: string; readonly shift: boolean } | null
}

export const DESTINATIONS: readonly Destination[] = [
  main('home', 'nav.home', 'home', null, '1'),
  main('chat', 'nav.chat', 'chat', null, '2'),
  main('missions', 'nav.missions', 'missions', null, '3'),
  main('skills', 'nav.skills', 'skills', null, '4'),
  main('memory', 'nav.memory', 'memory', '11', '5'),
  main('files', 'nav.files', 'files', '10', '6'),
  main('automations', 'nav.automations', 'automations', '18', '7'),
  main('models', 'nav.aiModels', 'models', null, '8'),
  main('devices', 'nav.devices', 'devices', '12–13', '9'),
  main('plugins', 'nav.plugins', 'plugins', '15', null),
  {
    id: 'settings',
    label: 'nav.settings',
    icon: 'settings',
    availability: 'available',
    plannedSet: null,
    group: 'system',
    shortcut: { key: ',', shift: false }
  },
  {
    id: 'diagnostics',
    label: 'nav.diagnostics',
    icon: 'diagnostics',
    availability: 'available',
    plannedSet: null,
    group: 'system',
    shortcut: { key: 'D', shift: true }
  }
]

function main(
  id: ViewId,
  label: MessageKey,
  icon: IconName,
  plannedSet: string | null,
  digit: string | null
): Destination {
  return {
    id,
    label,
    icon,
    availability: plannedSet === null ? 'available' : 'COMING_LATER',
    plannedSet,
    group: 'main',
    shortcut: digit === null ? null : { key: digit, shift: false }
  }
}

export function destinationOf(view: ViewId): Destination {
  const found = DESTINATIONS.find((destination) => destination.id === view)
  if (!found) throw new Error(`No destination for ${view}`)
  return found
}

/** Human-readable shortcut, e.g. `Ctrl+Shift+D`. */
export function shortcutLabel(shortcut: NonNullable<Destination['shortcut']>): string {
  return `Ctrl+${shortcut.shift ? 'Shift+' : ''}${shortcut.key.toUpperCase()}`
}
