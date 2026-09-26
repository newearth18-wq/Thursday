import { useEffect, useRef } from 'react'
import type { ViewId } from '../../shared/views'
import { DESTINATIONS } from './destinations'

/**
 * Global keyboard shortcuts. The list shown in the Keyboard shortcuts dialog
 * is built from the same `DESTINATIONS` table, so the two cannot disagree.
 *
 *   Ctrl+1…9       open a destination       Ctrl+,         Settings
 *   Ctrl+Shift+D   Diagnostics              Ctrl+B         compact mode
 *   F1, Ctrl+/     keyboard shortcuts       F6 / Shift+F6  next / previous region
 *
 * Shortcuts are ignored while a modal dialog is open (it owns the keyboard)
 * and, apart from F-keys, while typing in a text field.
 */
export interface ShortcutActions {
  readonly navigate: (view: ViewId) => void
  readonly toggleCompact: () => void
  readonly showHelp: () => void
  readonly cycleRegion: (backwards: boolean) => void
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
  )
}

export function useShortcuts(actions: ShortcutActions): void {
  const latest = useRef(actions)
  useEffect(() => {
    latest.current = actions
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return
      const current = latest.current
      if (event.key === 'F6') {
        event.preventDefault()
        current.cycleRegion(event.shiftKey)
        return
      }
      if (event.key === 'F1' || (event.ctrlKey && event.key === '/')) {
        event.preventDefault()
        current.showHelp()
        return
      }
      if (!event.ctrlKey || event.altKey || event.metaKey || isTyping(event.target)) return
      if (event.key.toLowerCase() === 'b' && !event.shiftKey) {
        event.preventDefault()
        current.toggleCompact()
        return
      }
      const destination = DESTINATIONS.find(
        (item) =>
          item.shortcut !== null &&
          item.shortcut.shift === event.shiftKey &&
          item.shortcut.key.toLowerCase() === event.key.toLowerCase()
      )
      if (destination) {
        event.preventDefault()
        current.navigate(destination.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
