import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { JupiterError, describeError } from '@jupiter/core'
import type { AppliedMigration } from '@jupiter/contracts'
import type { SqliteTransactions } from './transactions'

/**
 * Versioned, checksummed migrations.
 *
 * Each migration runs in its own transaction together with the row that
 * records it, so a migration is either fully applied and recorded or not at
 * all — including when the process is killed half-way. Applied migrations are
 * immutable: if the SQL of an applied migration changes, the checksum no longer
 * matches and the database refuses to open instead of silently diverging.
 * A database created by a newer Jupiter is never modified by an older one.
 */

export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
  /**
   * The migration rebuilds a table that other tables reference (SQLite's
   * documented 12-step procedure): foreign keys are switched off for it, and
   * `PRAGMA foreign_key_check` must find nothing before it commits. Not part
   * of the checksum.
   */
  readonly rebuildsTables?: boolean
}

export interface MigrationPlan {
  readonly currentVersion: number
  readonly latestVersion: number
  readonly pending: readonly Migration[]
  readonly applied: readonly AppliedMigration[]
}

export interface MigrationReport {
  readonly fromVersion: number
  readonly toVersion: number
  readonly applied: readonly { version: number; name: string }[]
}

export const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at  TEXT NOT NULL
  ) STRICT;
`

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${String(migration.version)}\n${migration.name}\n${migration.sql}`)
    .digest('hex')
}

export function validateMigrationList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration versions must be 1..N without gaps; found ${String(migration.version)} at position ${String(index + 1)}`
      )
    }
    if (!/^\d{4}_[a-z0-9_]+$/.test(migration.name)) {
      throw new Error(`Migration name "${migration.name}" must look like 0001_description`)
    }
  })
}

export function readAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  const exists = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get()
  if (!exists) return []
  return db
    .prepare(
      'SELECT version, name, checksum, applied_at AS appliedAt FROM schema_migrations ORDER BY version'
    )
    .all()
    .map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appliedAt: String(row.appliedAt)
    }))
}

/** Compare what the database has applied with what this build knows, without changing anything. */
export function planMigrations(db: DatabaseSync, migrations: readonly Migration[]): MigrationPlan {
  validateMigrationList(migrations)
  const applied = readAppliedMigrations(db)
  applied.forEach((row, index) => {
    if (row.version !== index + 1) {
      throw new JupiterError(
        'DATABASE_MIGRATIONS_INCONSISTENT',
        `The database's migration history has a gap at version ${String(index + 1)}.`,
        {
          category: 'internal',
          userAction: 'Restore the database from a backup.'
        }
      )
    }
    const known = migrations[row.version - 1]
    if (!known) {
      throw new JupiterError(
        'DATABASE_SCHEMA_NEWER',
        `The database uses schema version ${String(applied.length)}, but this version of Jupiter only knows up to ${String(migrations.length)}. It was not changed.`,
        {
          category: 'configuration',
          userAction:
            'Open it with the newer version of Jupiter that created it, or restore a backup made by this version.'
        }
      )
    }
    if (migrationChecksum(known) !== row.checksum || known.name !== row.name) {
      throw new JupiterError(
        'DATABASE_MIGRATION_MODIFIED',
        `Migration ${row.name} was applied with different contents than this build ships. The database was not changed.`,
        {
          category: 'internal',
          userAction: 'Reinstall Jupiter. If this persists, restore the database from a backup.'
        }
      )
    }
  })
  return {
    currentVersion: applied.length,
    latestVersion: migrations.length,
    pending: migrations.slice(applied.length),
    applied
  }
}

/** Apply every pending migration, each atomically with its bookkeeping row. */
export function applyMigrations(
  db: DatabaseSync,
  transactions: SqliteTransactions,
  migrations: readonly Migration[],
  now: () => Date
): MigrationReport {
  transactions.run(() => {
    db.exec(MIGRATIONS_TABLE_SQL)
  })
  const plan = planMigrations(db, migrations)
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
  )
  for (const migration of plan.pending) {
    // Foreign keys can only be switched off outside a transaction.
    if (migration.rebuildsTables) db.exec('PRAGMA foreign_keys = OFF')
    try {
      transactions.run(() => {
        db.exec(migration.sql)
        if (migration.rebuildsTables) {
          const violations = db.prepare('PRAGMA foreign_key_check').all()
          if (violations.length > 0)
            throw new Error(
              `the rebuilt tables break ${String(violations.length)} foreign key references`
            )
        }
        record.run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          now().toISOString()
        )
      })
    } catch (error) {
      throw new JupiterError(
        'DATABASE_MIGRATION_FAILED',
        `Database migration ${migration.name} failed and was rolled back: ${describeError(error)}`,
        {
          category: 'internal',
          userAction: 'Restart Jupiter. If it fails again, restore the pre-migration backup.',
          cause: error
        }
      )
    } finally {
      if (migration.rebuildsTables) db.exec('PRAGMA foreign_keys = ON')
    }
  }
  return {
    fromVersion: plan.currentVersion,
    toVersion: plan.latestVersion,
    applied: plan.pending.map(({ version, name }) => ({ version, name }))
  }
}
