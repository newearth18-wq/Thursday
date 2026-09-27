import { useCallback } from 'react'
import type {
  EventFilter,
  MemoryCandidate,
  MemoryDecisionRecord,
  MemoryStatus,
  NotesStatus
} from '@jupiter/contracts'
import { request } from './api'
import { keyOf, useBump, useQuery } from './useAi'
import type { Loadable } from './useRuntime'
import { useLiveEvents } from './useLiveEvents'

/**
 * The Memory System and Obsidian notes for the interface (SET 11): status,
 * the candidates waiting for the person, the policy's decisions and the
 * vault, read from Jupiter Core and read again whenever a memory, a note or
 * a setting changes. No memory content travels in an event: the interface
 * asks Core again.
 */

const MEMORY_EVENTS: EventFilter = {
  types: ['memory.decided', 'memory.saved', 'memory.changed', 'notes.changed', 'settings.changed'],
  streams: null,
  missionId: null
}

export interface MemoryData {
  readonly status: Loadable<MemoryStatus>
  readonly candidates: Loadable<MemoryCandidate[]>
  readonly decisions: Loadable<MemoryDecisionRecord[]>
  readonly notes: Loadable<NotesStatus>
  /** Changes every time something relevant happens, for views that reload their own results. */
  readonly version: number
  /**
   * Changes whenever views that load their own results should load again: a memory changed, or
   * Jupiter Core (re)connected. Null while there is no Core session to ask.
   */
  readonly reloadKey: string | null
  readonly reload: () => void
}

export function useMemory(coreSession: string | null): MemoryData {
  const [version, bump] = useBump(100)
  const { opened } = useLiveEvents(MEMORY_EVENTS, bump, coreSession)
  const loadStatus = useCallback(async () => request('memory.status', {}), [])
  const loadCandidates = useCallback(
    async () => (await request('memory.candidates', {})).candidates,
    []
  )
  const loadDecisions = useCallback(
    async () => (await request('memory.decisions', { limit: 100 })).decisions,
    []
  )
  const loadNotes = useCallback(async () => request('notes.status', {}), [])
  const [status] = useQuery(keyOf(coreSession, 'memory-status', opened, version), loadStatus)
  const [candidates] = useQuery(keyOf(coreSession, 'candidates', opened, version), loadCandidates)
  const [decisions] = useQuery(keyOf(coreSession, 'decisions', opened, version), loadDecisions)
  const [notes] = useQuery(keyOf(coreSession, 'notes-status', opened, version), loadNotes)
  return {
    status,
    candidates,
    decisions,
    notes,
    version,
    reloadKey: keyOf(coreSession, 'memories', opened, version),
    reload: bump
  }
}
