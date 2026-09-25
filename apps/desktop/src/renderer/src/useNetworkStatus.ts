import { useEffect, useState } from 'react'

/**
 * Whether this computer has a network connection, as Chromium reports it
 * (`navigator.onLine` and its online/offline events). Nothing in this build
 * needs the network, so this is information, not a feature switch.
 */
export function useNetworkStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine)
    }
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}
