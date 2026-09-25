import { useCallback, useEffect, useState } from 'react'
import type { ErrorEnvelope, GatewayStatus } from '@jupiter/contracts'
import { createErrorEnvelope } from '@jupiter/core'
import { BridgeError, fetchGatewayStatus, onGatewayStatus, retryService } from './api'

export type Loadable<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error'; readonly error: ErrorEnvelope }

export function envelopeOf(error: unknown): ErrorEnvelope {
  if (error instanceof BridgeError) return error.envelope
  return createErrorEnvelope({
    code: 'UNEXPECTED_INTERFACE_ERROR',
    category: 'internal',
    message: error instanceof Error ? error.message : String(error),
    userAction: 'Try again. If it keeps failing, restart Jupiter.',
    retryable: true
  })
}

/** Keep whichever status is newer: pushed updates and fetch replies can arrive in either order. */
function newer(previous: Loadable<GatewayStatus>, next: GatewayStatus): Loadable<GatewayStatus> {
  if (previous.state === 'ready' && previous.value.runtime.updatedAt > next.runtime.updatedAt)
    return previous
  return { state: 'ready', value: next }
}

export interface RuntimeData {
  readonly status: Loadable<GatewayStatus>
  /** Resolves to null on success, or the reason the retry request itself failed. */
  readonly retry: (serviceId: string) => Promise<ErrorEnvelope | null>
}

/** Gateway status: app info, runtime health and Jupiter Core's process state. Works even when Core is down. */
export function useRuntime(): RuntimeData {
  const [status, setStatus] = useState<Loadable<GatewayStatus>>({ state: 'loading' })

  useEffect(() => {
    let active = true
    const unsubscribe = onGatewayStatus((next) => {
      if (active) setStatus((previous) => newer(previous, next))
    })
    fetchGatewayStatus().then(
      (value) => {
        if (active) setStatus((previous) => newer(previous, value))
      },
      (error: unknown) => {
        if (active) setStatus({ state: 'error', error: envelopeOf(error) })
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const retry = useCallback(async (serviceId: string) => {
    try {
      const next = await retryService(serviceId)
      setStatus((previous) => newer(previous, next))
      return null
    } catch (error) {
      return envelopeOf(error)
    }
  }, [])

  return { status, retry }
}
