import { useCallback } from 'react'
import type {
  EventFilter,
  PermissionAuditEntry,
  PermissionGrant,
  PermissionRequest
} from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import type { Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * Permissions for the interface (SET 7). Requests, grants and the audit
 * trail are read from Jupiter Core's Permission Engine, and read again
 * whenever Core publishes a permission event. The interface only shows them
 * and sends the person's answers; it never decides anything itself.
 */

const PERMISSION_EVENTS: EventFilter = {
  types: ['permission.requested', 'permission.decided', 'permission.grant_ended'],
  streams: null,
  missionId: null
}

export function usePermissionData<T>(
  coreSession: string | null,
  name: string,
  load: () => Promise<T>
): { readonly data: Loadable<T>; readonly refresh: () => void } {
  const [version, bump] = useBump(80)
  const { opened } = useLiveEvents(PERMISSION_EVENTS, bump, coreSession)
  const [data] = useQuery(keyOf(coreSession, name, opened, version), load)
  return { data, refresh: bump }
}

export function usePendingPermissions(coreSession: string | null) {
  const load = useCallback(
    async (): Promise<PermissionRequest[]> =>
      (await request('permissions.requests', { status: 'PENDING', limit: 50 })).requests,
    []
  )
  return usePermissionData(coreSession, 'pending', load)
}

export function usePermissionGrants(coreSession: string | null, includeEnded: boolean) {
  const load = useCallback(
    async (): Promise<PermissionGrant[]> =>
      (await request('permissions.grants', { includeEnded, limit: 200 })).grants,
    [includeEnded]
  )
  return usePermissionData(coreSession, `grants:${String(includeEnded)}`, load)
}

export function usePermissionAudit(coreSession: string | null) {
  const load = useCallback(
    async (): Promise<PermissionAuditEntry[]> =>
      (await request('permissions.audit', { limit: 100 })).entries,
    []
  )
  return usePermissionData(coreSession, 'audit', load)
}
