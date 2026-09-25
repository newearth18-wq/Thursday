import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, ErrorEnvelope, RuntimeStatus } from '@jupiter/contracts'
import { createErrorEnvelope } from '@jupiter/core'
import {
  BridgeError,
  fetchAppInfo,
  fetchRuntimeStatus,
  retryService,
  subscribeRuntimeStatus
} from './api'

export type Loadable<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'error'; readonly error: ErrorEnvelope }

function envelopeOf(error: unknown): ErrorEnvelope {
  if (error instanceof BridgeError) return error.envelope
  return createErrorEnvelope({
    code: 'UNEXPECTED_INTERFACE_ERROR',
    category: 'internal',
    message: error instanceof Error ? error.message : String(error),
    userAction: 'Try again. If it keeps failing, restart Jupiter.',
    retryable: true
  })
}

/** Keep whichever status is newer: pushed events and fetch replies can arrive in either order. */
function newer(previous: Loadable<RuntimeStatus>, next: RuntimeStatus): Loadable<RuntimeStatus> {
  if (previous.state === 'ready' && previous.value.updatedAt > next.updatedAt) return previous
  return { state: 'ready', value: next }
}

export interface RuntimeData {
  readonly info: Loadable<AppInfo>
  readonly runtime: Loadable<RuntimeStatus>
  /** Resolves to null on success, or the reason the retry request itself failed. */
  readonly retry: (serviceId: string) => Promise<ErrorEnvelope | null>
}

export function useRuntime(): RuntimeData {
  const [info, setInfo] = useState<Loadable<AppInfo>>({ state: 'loading' })
  const [runtime, setRuntime] = useState<Loadable<RuntimeStatus>>({ state: 'loading' })

  useEffect(() => {
    let active = true
    const unsubscribe = subscribeRuntimeStatus((status) => {
      if (active) setRuntime((previous) => newer(previous, status))
    })
    fetchAppInfo().then(
      (value) => {
        if (active) setInfo({ state: 'ready', value })
      },
      (error: unknown) => {
        if (active) setInfo({ state: 'error', error: envelopeOf(error) })
      }
    )
    fetchRuntimeStatus().then(
      (value) => {
        if (active) setRuntime((previous) => newer(previous, value))
      },
      (error: unknown) => {
        if (active) setRuntime({ state: 'error', error: envelopeOf(error) })
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const retry = useCallback(async (serviceId: string) => {
    try {
      const status = await retryService(serviceId)
      setRuntime((previous) => newer(previous, status))
      return null
    } catch (error) {
      return envelopeOf(error)
    }
  }, [])

  return { info, runtime, retry }
}
