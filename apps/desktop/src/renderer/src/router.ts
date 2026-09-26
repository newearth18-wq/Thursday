import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_VIEW,
  conversationFromHash,
  hashForConversation,
  hashForItem,
  hashForView,
  itemFromHash,
  viewFromHash,
  type ViewId
} from '../../shared/views'

/** The conversation last open in Chat, for this window only (it is never stored). */
let lastConversation: string | null = null
/** The Mission last open in Missions, for this window only. */
let lastMission: string | null = null

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
    // Chat and Missions reopen the item that was open last in this window.
    window.location.hash =
      next === 'chat'
        ? hashForConversation(lastConversation)
        : next === 'missions'
          ? hashForItem('missions', lastMission)
          : hashForView(next)
  }, [])

  return { view, navigate }
}

/** The conversation open in Chat (`#/chat/<id>`), or null for a new one. */
export function useConversationRoute(): {
  conversationId: string | null
  openConversation: (conversationId: string | null) => void
} {
  const [conversationId, setConversationId] = useState<string | null>(() =>
    conversationFromHash(window.location.hash)
  )
  useEffect(() => {
    if (viewFromHash(window.location.hash) === 'chat') lastConversation = conversationId
  }, [conversationId])
  useEffect(() => {
    const sync = () => {
      if (viewFromHash(window.location.hash) === 'chat')
        setConversationId(conversationFromHash(window.location.hash))
    }
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
    }
  }, [])
  const openConversation = useCallback((next: string | null) => {
    const hash = hashForConversation(next)
    if (window.location.hash !== hash) window.location.hash = hash
    setConversationId(next)
  }, [])
  return { conversationId, openConversation }
}

/** The Mission open in Missions (`#/missions/<id>`), or null for the list alone. */
export function useMissionRoute(): {
  missionId: string | null
  openMission: (missionId: string | null) => void
} {
  const [missionId, setMissionId] = useState<string | null>(() =>
    itemFromHash(window.location.hash, 'missions')
  )
  useEffect(() => {
    if (viewFromHash(window.location.hash) === 'missions') lastMission = missionId
  }, [missionId])
  useEffect(() => {
    const sync = () => {
      if (viewFromHash(window.location.hash) === 'missions')
        setMissionId(itemFromHash(window.location.hash, 'missions'))
    }
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
    }
  }, [])
  const openMission = useCallback((next: string | null) => {
    const hash = hashForItem('missions', next)
    if (window.location.hash !== hash) window.location.hash = hash
    setMissionId(next)
  }, [])
  return { missionId, openMission }
}
