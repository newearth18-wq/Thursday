import type { DatabaseSync } from 'node:sqlite'
import { EnrollableMethod, IdentityMethod } from '@jupiter/contracts'
import type { IdentityAttempts, IdentityStore, StoredIdentityMethod } from '@jupiter/core'
import { integer, nullableText, text } from '../rows'

type Row = Record<string, unknown>

/** Identity methods, attempts and protection (SET 14). Templates are stored sealed only. */
export class SqliteIdentityStore implements IdentityStore {
  constructor(private readonly db: DatabaseSync) {}

  method(method: EnrollableMethod): StoredIdentityMethod | null {
    const row = this.db.prepare('SELECT * FROM identity_methods WHERE method = ?').get(method)
    return row ? methodOf(row) : null
  }

  methods(): StoredIdentityMethod[] {
    return this.db
      .prepare('SELECT * FROM identity_methods ORDER BY method')
      .all()
      .map((row) => methodOf(row as Row))
  }

  putMethod(method: StoredIdentityMethod): void {
    this.db
      .prepare(
        `INSERT INTO identity_methods (method, enabled, sealed_template, template_version, samples,
           enrolled_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (method) DO UPDATE SET enabled = excluded.enabled,
           sealed_template = excluded.sealed_template, template_version = excluded.template_version,
           samples = excluded.samples, enrolled_at = excluded.enrolled_at,
           updated_at = excluded.updated_at`
      )
      .run(
        EnrollableMethod.parse(method.method),
        method.enabled ? 1 : 0,
        method.sealedTemplate,
        method.templateVersion,
        method.samples,
        method.enrolledAt,
        method.updatedAt
      )
  }

  setEnabled(method: EnrollableMethod, enabled: boolean, at: string): void {
    this.db
      .prepare('UPDATE identity_methods SET enabled = ?, updated_at = ? WHERE method = ?')
      .run(enabled ? 1 : 0, at, method)
  }

  deleteMethod(method: EnrollableMethod): boolean {
    const result = this.db.prepare('DELETE FROM identity_methods WHERE method = ?').run(method)
    return Number(result.changes) > 0
  }

  eraseRemnants(): void {
    // Old copies of changed pages live in the write-ahead log until it is checkpointed.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  attempts(method: IdentityMethod): IdentityAttempts {
    const row = this.db.prepare('SELECT * FROM identity_attempts WHERE method = ?').get(method) as
      Row | undefined
    if (!row) return { method, failures: 0, lockouts: 0, lockedUntil: null }
    return {
      method: IdentityMethod.parse(text(row, 'method')),
      failures: integer(row, 'failures'),
      lockouts: integer(row, 'lockouts'),
      lockedUntil: nullableText(row, 'locked_until')
    }
  }

  putAttempts(attempts: IdentityAttempts, at: string): void {
    this.db
      .prepare(
        `INSERT INTO identity_attempts (method, failures, lockouts, locked_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (method) DO UPDATE SET failures = excluded.failures,
           lockouts = excluded.lockouts, locked_until = excluded.locked_until,
           updated_at = excluded.updated_at`
      )
      .run(attempts.method, attempts.failures, attempts.lockouts, attempts.lockedUntil, at)
  }

  protection(): boolean {
    const row = this.db.prepare('SELECT protection FROM identity_state WHERE id = 1').get() as
      Row | undefined
    return row ? integer(row, 'protection') === 1 : false
  }

  setProtection(enabled: boolean, at: string): void {
    this.db
      .prepare(
        `INSERT INTO identity_state (id, protection, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET protection = excluded.protection, updated_at = excluded.updated_at`
      )
      .run(enabled ? 1 : 0, at)
  }
}

function methodOf(row: Row): StoredIdentityMethod {
  return {
    method: EnrollableMethod.parse(text(row, 'method')),
    enabled: integer(row, 'enabled') === 1,
    sealedTemplate: text(row, 'sealed_template'),
    templateVersion: integer(row, 'template_version'),
    samples: integer(row, 'samples'),
    enrolledAt: text(row, 'enrolled_at'),
    updatedAt: text(row, 'updated_at')
  }
}
