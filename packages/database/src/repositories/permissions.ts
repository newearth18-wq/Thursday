import type { DatabaseSync } from 'node:sqlite'
import { PermissionAuditEntry, PermissionGrant, PermissionRequest } from '@jupiter/contracts'
import type { PermissionStore } from '@jupiter/core'
import { json, nullableText, text } from '../rows'

type Row = Record<string, unknown>

/** Permission requests, grants and audit trail (SET 7). Rows are validated when read. */
export class SqlitePermissionStore implements PermissionStore {
  constructor(private readonly db: DatabaseSync) {}

  insertRequest(input: PermissionRequest, sessionId: string): void {
    const request = PermissionRequest.parse(input)
    this.db
      .prepare(
        `INSERT INTO permission_requests (request_id, capability, status, decision, mission_id,
           session_id, request_json, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.requestId,
        request.capability,
        request.status,
        request.decision,
        request.missionId,
        sessionId,
        JSON.stringify(request),
        request.createdAt,
        request.decidedAt
      )
  }

  request(requestId: string): PermissionRequest | null {
    const row = this.db
      .prepare('SELECT * FROM permission_requests WHERE request_id = ?')
      .get(requestId)
    return row ? toRequest(row) : null
  }

  requests(options: {
    pendingOnly: boolean
    missionId?: string | undefined
    limit: number
  }): PermissionRequest[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (options.pendingOnly) where.push("status = 'PENDING'")
    if (options.missionId !== undefined) {
      where.push('mission_id = ?')
      args.push(options.missionId)
    }
    return this.db
      .prepare(
        `SELECT * FROM permission_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, request_id DESC LIMIT ?`
      )
      .all(...args, options.limit)
      .map(toRequest)
  }

  updateRequest(
    requestId: string,
    changes: Pick<PermissionRequest, 'status' | 'decision' | 'decidedAt'>
  ): void {
    const current = this.request(requestId)
    if (!current) throw new Error(`No permission request ${requestId}`)
    const next = PermissionRequest.parse({ ...current, ...changes })
    this.db
      .prepare(
        `UPDATE permission_requests SET status = ?, decision = ?, decided_at = ?, request_json = ?
         WHERE request_id = ?`
      )
      .run(next.status, next.decision, next.decidedAt, JSON.stringify(next), requestId)
  }

  pendingFromOtherSessions(sessionId: string): PermissionRequest[] {
    return this.db
      .prepare(
        "SELECT * FROM permission_requests WHERE status = 'PENDING' AND session_id <> ? ORDER BY created_at"
      )
      .all(sessionId)
      .map(toRequest)
  }

  insertGrant(input: PermissionGrant): void {
    const grant = PermissionGrant.parse(input)
    this.db
      .prepare(
        `INSERT INTO permission_grants (grant_id, capability, subject_kind, subject_id, subject_name,
           target, mission_id, kind, session_id, state, created_by, request_id, reason, created_at,
           expires_at, used_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        grant.grantId,
        grant.capability,
        grant.subject.kind,
        grant.subject.id,
        grant.subject.name,
        grant.target,
        grant.missionId,
        grant.kind,
        grant.sessionId,
        grant.state,
        grant.createdBy,
        grant.requestId,
        grant.reason,
        grant.createdAt,
        grant.expiresAt,
        grant.usedAt,
        grant.endedAt
      )
  }

  grant(grantId: string): PermissionGrant | null {
    const row = this.db.prepare('SELECT * FROM permission_grants WHERE grant_id = ?').get(grantId)
    return row ? toGrant(row) : null
  }

  grants(options: { includeEnded: boolean; limit: number }): PermissionGrant[] {
    return this.db
      .prepare(
        `SELECT * FROM permission_grants ${options.includeEnded ? '' : "WHERE state = 'ACTIVE'"}
         ORDER BY created_at DESC, grant_id DESC LIMIT ?`
      )
      .all(options.limit)
      .map(toGrant)
  }

  activeGrants(capability: string, subjectKind: string, subjectId: string): PermissionGrant[] {
    return this.db
      .prepare(
        `SELECT * FROM permission_grants WHERE capability = ? AND subject_kind = ? AND subject_id = ?
           AND state = 'ACTIVE' ORDER BY created_at`
      )
      .all(capability, subjectKind, subjectId)
      .map(toGrant)
  }

  everGranted(
    capability: string,
    subjectKind: string,
    subjectId: string,
    createdBy: string
  ): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 AS found FROM permission_grants WHERE capability = ? AND subject_kind = ?
             AND subject_id = ? AND created_by = ? LIMIT 1`
        )
        .get(capability, subjectKind, subjectId, createdBy) !== undefined
    )
  }

  updateGrant(
    grantId: string,
    changes: Pick<PermissionGrant, 'state' | 'usedAt' | 'endedAt'>
  ): void {
    const result = this.db
      .prepare(
        'UPDATE permission_grants SET state = ?, used_at = ?, ended_at = ? WHERE grant_id = ?'
      )
      .run(changes.state, changes.usedAt, changes.endedAt, grantId)
    if (Number(result.changes) !== 1) throw new Error(`No permission grant ${grantId}`)
  }

  sessionGrantsOutside(sessionId: string): PermissionGrant[] {
    return this.db
      .prepare(
        `SELECT * FROM permission_grants WHERE kind = 'ALLOW_SESSION' AND state = 'ACTIVE'
           AND session_id <> ?`
      )
      .all(sessionId)
      .map(toGrant)
  }

  insertAudit(input: PermissionAuditEntry): void {
    const entry = PermissionAuditEntry.parse(input)
    this.db
      .prepare('INSERT INTO permission_audit (entry_id, at, entry_json) VALUES (?, ?, ?)')
      .run(entry.entryId, entry.at, JSON.stringify(entry))
  }

  audit(limit: number): PermissionAuditEntry[] {
    return this.db
      .prepare('SELECT entry_json FROM permission_audit ORDER BY at DESC, entry_id DESC LIMIT ?')
      .all(limit)
      .map((row) => PermissionAuditEntry.parse(json(row, 'entry_json')))
  }
}

function toRequest(row: Row): PermissionRequest {
  return PermissionRequest.parse(json(row, 'request_json'))
}

function toGrant(row: Row): PermissionGrant {
  return PermissionGrant.parse({
    grantId: text(row, 'grant_id'),
    capability: text(row, 'capability'),
    subject: {
      kind: text(row, 'subject_kind'),
      id: text(row, 'subject_id'),
      name: text(row, 'subject_name')
    },
    target: text(row, 'target'),
    missionId: nullableText(row, 'mission_id'),
    kind: text(row, 'kind'),
    sessionId: nullableText(row, 'session_id'),
    state: text(row, 'state'),
    createdBy: text(row, 'created_by'),
    requestId: nullableText(row, 'request_id'),
    reason: text(row, 'reason'),
    createdAt: text(row, 'created_at'),
    expiresAt: nullableText(row, 'expires_at'),
    usedAt: nullableText(row, 'used_at'),
    endedAt: nullableText(row, 'ended_at')
  })
}
