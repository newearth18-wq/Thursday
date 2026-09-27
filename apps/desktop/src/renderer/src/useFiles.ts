import { useCallback } from 'react'
import type { Artifact, ErrorEnvelope, EventFilter, FilesStatus } from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import { envelopeOf, type Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * The File Agent and the Artifact Manager for the interface (SET 10): the
 * approved folders, the document runtime and the artifacts, read from
 * Jupiter Core and read again whenever a file operation or an artifact
 * changes.
 */

const FILE_EVENTS: EventFilter = {
  types: ['file.operation', 'artifact.created', 'artifact.changed'],
  streams: null,
  missionId: null
}

export function useFiles(
  coreSession: string | null,
  options: { missionId: string | null; includeDeleted: boolean }
): {
  readonly status: Loadable<FilesStatus>
  readonly artifacts: Loadable<Artifact[]>
} {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(FILE_EVENTS, bump, coreSession)
  const loadStatus = useCallback(async () => request('files.status', {}), [])
  const { missionId, includeDeleted } = options
  const loadArtifacts = useCallback(
    async () =>
      (await request('artifacts.list', { missionId, includeDeleted, limit: 200 })).artifacts,
    [missionId, includeDeleted]
  )
  const [status] = useQuery(keyOf(coreSession, 'files-status', opened, version), loadStatus)
  const [artifacts] = useQuery(
    keyOf(coreSession, 'artifacts', missionId, String(includeDeleted), opened, version),
    loadArtifacts
  )
  return { status, artifacts }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Runs a file action. When Jupiter Core first asks the person for a
 * permission (the permission dialog shows it), this waits for the answer
 * and, if it was allowed, runs the action again (which may ask for the next
 * file, as a note with backlinks does). A denial, or no answer
 * within ten minutes, is returned as the error it is.
 */
export async function withPermission<T>(
  run: () => Promise<T>,
  onWaiting?: (waiting: boolean) => void
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const envelope: ErrorEnvelope = envelopeOf(error)
    const requestId = envelope.sanitizedDetails?.requestId
    if (envelope.code !== 'PERMISSION_REQUIRED' || typeof requestId !== 'string') throw error
    onWaiting?.(true)
    try {
      for (let waited = 0; waited < 600_000; waited += 500) {
        await sleep(500)
        const { requests } = await request('permissions.requests', { status: 'ALL', limit: 100 })
        const asked = requests.find((item) => item.requestId === requestId)
        if (!asked || asked.status === 'PENDING') continue
        // Allowed: run again. An operation on several files may then ask for the next one.
        if (asked.status === 'ALLOWED') return await withPermission(run, onWaiting)
        throw error
      }
      throw error
    } finally {
      onWaiting?.(false)
    }
  }
}

/**
 * Copies text to the clipboard from the page itself (the renderer is given
 * no clipboard permission; a copy command needs none).
 */
export function copyText(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'visually-hidden'
  document.body.append(area)
  area.select()
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only copy that needs no permission
    return document.execCommand('copy')
  } finally {
    area.remove()
  }
}
