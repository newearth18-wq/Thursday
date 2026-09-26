import { useState } from 'react'
import type { PermissionDecision } from '@jupiter/contracts'
import { request } from '../api'
import { usePendingPermissions } from '../usePermissions'
import { envelopeOf } from '../useRuntime'
import { PermissionRequestDialog } from './SecurityDialogs'

/**
 * Puts Jupiter Core's pending permission requests to the person, oldest
 * first, wherever they are in the app (SET 7). The request comes from Core;
 * the answer goes back to Core, which alone creates grants.
 */
export function PermissionPrompt({ coreSession }: { readonly coreSession: string | null }) {
  const { data, refresh } = usePendingPermissions(coreSession)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ requestId: string; message: string } | null>(null)
  const pending = data.state === 'ready' ? [...data.value].reverse() : []
  const current = pending[0] ?? null

  const answer = (decision: PermissionDecision) => {
    if (!current) return
    setBusy(true)
    setFailure(null)
    request('permissions.decide', { requestId: current.requestId, decision }).then(
      () => {
        setBusy(false)
        refresh()
      },
      (error: unknown) => {
        setBusy(false)
        setFailure({ requestId: current.requestId, message: envelopeOf(error).message })
        refresh()
      }
    )
  }

  return (
    <PermissionRequestDialog
      request={current}
      busy={busy}
      error={failure && failure.requestId === current?.requestId ? failure.message : null}
      waiting={Math.max(0, pending.length - 1)}
      onAnswer={answer}
    />
  )
}
