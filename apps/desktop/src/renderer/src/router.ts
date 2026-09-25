import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_VIEW, hashForView, viewFromHash, type ViewId } from '../../shared/views'

/**
 * Hash routing: the selected view lives in the URL fragment
 * (`jupiter://app/index.html#/settings`), so reloading the interface keeps it
 * without asking Jupiter Core, and the host remembers it for the next launch.
 * An unknown or missing fragment means Home; the fragment is corrected so the
 * address always names the view on screen.
 */
export function currentView(): ViewId {
  return viewFromHash(window.location.hash) ?? DEFAULT_VIEW
}

export function useView(): { view: ViewId; navigate: (view: ViewId) => void } {
  const [view, setView] = useState<ViewId>(currentView)

  useEffect(() => {
    const sync = () => {
      const next = viewFromHash(window.location.hash)
      if (next) setView(next)
      else window.location.replace(hashForView(DEFAULT_VIEW))
    }
    if (viewFromHash(window.location.hash) === null) {
      window.location.replace(hashForView(currentView()))
    }
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  const navigate = useCallback((next: ViewId) => {
    if (viewFromHash(window.location.hash) === next) {
      setView(next)
      return
    }
    window.location.hash = hashForView(next)
  }, [])

  return { view, navigate }
}
