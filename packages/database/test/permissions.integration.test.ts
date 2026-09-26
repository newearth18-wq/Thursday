import { join } from 'node:path'
import type { PermissionAuditEntry, PermissionGrant, PermissionRequest } from '@jupiter/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

/** SET 7 tables on real SQLite files: requests, grants and an append-only audit trail. */

let dir: string
let cleanup: () => void
const opened: JupiterDatabase[] = []

beforeEach(() => {
  ;({ dir, cleanup } = tempDirectory())
})

afterEach(() => {
  for (const database of opened.splice(0)) database.close()
  cleanup()
})

async function open(): Promise<JupiterDatabase> {
  const { database } = await JupiterDatabase.open({
    path: join(dir, 'jupiter.db'),
    backupDirectory: join(dir, 'backups')
  })
  opened.push(database)
  return database
}

const NOW = '2026-09-26T10:00:00.000Z'
const SESSION_A = '01a0d82f-22b6-762b-b369-29675d970a01'
const SESSION_B = '01a0d82f-22b6-762b-b369-29675d970a02'
const subject = { kind: 'skill' as const, id: 'file_writer', name: 'File writer' }

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: '01a0d82f-22b6-762b-b369-29675d970b01',
  capability: 'files.write',
  subject,
  actor: 'core',
  target: '/home/me/notes.txt',
  reason: 'Save the summary',
  risk: 'HIGH',
  summary: 'Create or change a file',
  consequence: 'The file is written; an existing file is changed.',
  reversible: false,
  dataLeavesDevice: null,
  missionId: null,
  missionTitle: null,
  stepId: null,
  stepTitle: null,
  skillId: 'file_writer',
  offered: ['ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW', 'DENY'],
  status: 'PENDING',
  decision: null,
  createdAt: NOW,
  decidedAt: null,
  ...overrides
})

const grant = (overrides: Partial<PermissionGrant> = {}): PermissionGrant => ({
  grantId: '01a0d82f-22b6-762b-b369-29675d970c01',
  capability: 'files.write',
  subject,
  target: '/home/me/notes.txt',
  missionId: null,
  kind: 'ALWAYS_ALLOW',
  sessionId: null,
  state: 'ACTIVE',
  createdBy: 'user-interface',
  requestId: null,
  reason: 'Save the summary',
  createdAt: NOW,
  expiresAt: null,
  usedAt: null,
  endedAt: null,
  ...overrides
})

const entry = (overrides: Partial<PermissionAuditEntry> = {}): PermissionAuditEntry => ({
  entryId: '01a0d82f-22b6-762b-b369-29675d970d01',
  at: NOW,
  action: 'evaluated',
  capability: 'files.write',
  subjectKind: 'skill',
  subjectId: 'file_writer',
  target: '/home/me/notes.txt',
  outcome: 'DENIED',
  detail: 'No grant matches.',
  actor: 'core',
  missionId: null,
  requestId: null,
  grantId: null,
  ...overrides
})

describe('permission store', () => {
  it('keeps requests, grants and audit entries across reopening, validated on read', async () => {
    const first = await open()
    first.permissions.insertRequest(request(), SESSION_A)
    first.permissions.insertGrant(grant())
    first.permissions.insertAudit(entry())
    first.close()
    opened.splice(0)

    const second = await open()
    expect(second.permissions.request(request().requestId)).toEqual(request())
    expect(second.permissions.grants({ includeEnded: false, limit: 10 })).toEqual([grant()])
    expect(second.permissions.activeGrants('files.write', 'skill', 'file_writer')).toEqual([
      grant()
    ])
    expect(second.permissions.activeGrants('files.write', 'skill', 'other')).toEqual([])
    expect(second.permissions.audit(10)).toEqual([entry()])
  })

  it('finds pending requests and session grants of other sessions', async () => {
    const database = await open()
    database.permissions.insertRequest(request(), SESSION_A)
    database.permissions.insertGrant(
      grant({
        kind: 'ALLOW_SESSION',
        sessionId: SESSION_A,
        grantId: '01a0d82f-22b6-762b-b369-29675d970c02'
      })
    )
    expect(database.permissions.pendingFromOtherSessions(SESSION_A)).toEqual([])
    expect(database.permissions.pendingFromOtherSessions(SESSION_B)).toHaveLength(1)
    expect(database.permissions.sessionGrantsOutside(SESSION_A)).toEqual([])
    expect(database.permissions.sessionGrantsOutside(SESSION_B)).toHaveLength(1)
  })

  it('ends a grant without deleting it, and remembers that a default was ever given', async () => {
    const database = await open()
    database.permissions.insertGrant(grant({ createdBy: 'core' }))
    database.permissions.updateGrant(grant().grantId, {
      state: 'REVOKED',
      usedAt: null,
      endedAt: NOW
    })
    expect(database.permissions.activeGrants('files.write', 'skill', 'file_writer')).toEqual([])
    expect(database.permissions.grants({ includeEnded: true, limit: 10 })).toMatchObject([
      { state: 'REVOKED', endedAt: NOW }
    ])
    expect(database.permissions.everGranted('files.write', 'skill', 'file_writer', 'core')).toBe(
      true
    )
    expect(
      database.permissions.everGranted('files.write', 'skill', 'file_writer', 'user-interface')
    ).toBe(false)
  })

  it('refuses a session grant without a session, and never changes or deletes the audit trail', async () => {
    const database = await open()
    expect(() => {
      database.permissions.insertGrant(grant({ kind: 'ALLOW_SESSION', sessionId: null }))
    }).toThrow()
    database.permissions.insertAudit(entry())
    database.close()
    opened.splice(0)
    const db = raw(join(dir, 'jupiter.db'))
    try {
      expect(() => {
        db.exec(`UPDATE permission_audit SET at = 'x'`)
      }).toThrow(/append-only/)
      expect(() => {
        db.exec('DELETE FROM permission_audit')
      }).toThrow(/append-only/)
      const row = db.prepare('SELECT count(*) AS n FROM permission_audit').get() as { n: number }
      expect(row.n).toBe(1)
    } finally {
      db.close()
    }
  })
})
