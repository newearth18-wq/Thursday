import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import type { BackupInfo, DatabaseInfo } from '@jupiter/contracts'
import {
  JupiterError,
  describeError,
  type BackupOptions,
  type DatabasePort,
  type Logger
} from '@jupiter/core'
import { applyMigrations, planMigrations, type Migration, type MigrationReport } from './migrations'
import { SqliteAuditStore } from './repositories/audit'
import { SqliteChatStore } from './repositories/chat'
import { SqliteMissionStore } from './repositories/missions'
import { SqliteEventStore } from './repositories/events'
import { SqliteProviderStore } from './repositories/providers'
import { SqliteServiceHealthStore } from './repositories/service-health'
import { SqliteSettingsStore } from './repositories/settings'
import { JUPITER_MIGRATIONS } from './schema'
import { SqliteTransactions } from './transactions'

/**
 * Jupiter's local database: one SQLite file in WAL mode with foreign keys
 * enforced and full synchronous durability.
 *
 * Opening it:
 *   1. checks the file is really a healthy SQLite database (quick_check) —
 *      a damaged database is reported, never recreated or overwritten;
 *   2. refuses a schema newer than this build, or one whose applied
 *      migrations were altered;
 *   3. backs up an existing database before applying new migrations
 *      (the pre-migration backup hook);
 *   4. applies pending migrations, each atomically.
 */

export interface OpenDatabaseOptions {
  readonly path: string
  readonly backupDirectory: string
  readonly migrations?: readonly Migration[]
  readonly logger?: Logger
  readonly now?: () => Date
  /** Backups kept per reason; older ones made by Jupiter are deleted. */
  readonly keepBackups?: number
}

export interface OpenedDatabase {
  readonly database: JupiterDatabase
  readonly migration: MigrationReport
  readonly preMigrationBackup: BackupInfo | null
}

const BACKUP_PATTERN = /^jupiter-(\d{8}T\d{9}Z)-(manual|pre-migration)(?:-\d+)?\.db$/

export class JupiterDatabase implements DatabasePort {
  readonly transactions: SqliteTransactions
  readonly events: SqliteEventStore
  readonly settings: SqliteSettingsStore
  readonly audit: SqliteAuditStore
  readonly serviceHealth: SqliteServiceHealthStore
  readonly providers: SqliteProviderStore
  readonly chat: SqliteChatStore
  readonly missions: SqliteMissionStore
  private integrity = 'not checked'
  private closed = false

  private constructor(
    private readonly db: DatabaseSync,
    private readonly options: Required<Omit<OpenDatabaseOptions, 'logger'>> & {
      logger: Logger | undefined
    }
  ) {
    this.transactions = new SqliteTransactions(db, options.logger)
    this.events = new SqliteEventStore(
      db,
      this.transactions,
      (sequence, problem) => {
        options.logger?.error(
          'database.event.invalid',
          `Stored event ${String(sequence)} failed validation and was skipped`,
          { problem }
        )
      },
      options.now
    )
    this.settings = new SqliteSettingsStore(db)
    this.audit = new SqliteAuditStore(db)
    this.serviceHealth = new SqliteServiceHealthStore(db)
    this.providers = new SqliteProviderStore(db)
    this.chat = new SqliteChatStore(db)
    this.missions = new SqliteMissionStore(db)
  }

  static async open(input: OpenDatabaseOptions): Promise<OpenedDatabase> {
    const options = {
      path: input.path,
      backupDirectory: input.backupDirectory,
      migrations: input.migrations ?? JUPITER_MIGRATIONS,
      logger: input.logger,
      now: input.now ?? (() => new Date()),
      keepBackups: input.keepBackups ?? 10
    }
    mkdirSync(dirname(options.path), { recursive: true })
    const existed = existsSync(options.path) && statSync(options.path).size > 0

    let db: DatabaseSync
    try {
      db = new DatabaseSync(options.path, { enableForeignKeyConstraints: true, timeout: 5000 })
    } catch (error) {
      throw new JupiterError(
        'DATABASE_UNREADABLE',
        `Jupiter cannot open its database: ${describeError(error)}`,
        {
          category: 'dependency',
          userAction: `Make sure ${options.path} is a file your account can read and write, then press Retry.`,
          retryable: true,
          details: { path: options.path },
          cause: error
        }
      )
    }

    const database = new JupiterDatabase(db, options)
    try {
      database.configure()
      database.integrity = database.quickCheck()
      if (database.integrity !== 'ok') {
        throw new JupiterError(
          'DATABASE_CORRUPT',
          `The database failed its integrity check: ${database.integrity}`,
          {
            category: 'dependency',
            userAction:
              'Jupiter did not change the file. Restore a backup from the backups folder, or move the damaged file away and restart.',
            details: { path: options.path }
          }
        )
      }
      const plan = planMigrations(db, options.migrations)
      let preMigrationBackup: BackupInfo | null = null
      if (existed && plan.currentVersion > 0 && plan.pending.length > 0) {
        preMigrationBackup = await database.backup('pre-migration')
      }
      const migration = applyMigrations(db, database.transactions, options.migrations, options.now)
      options.logger?.info('database.opened', 'Database ready', {
        path: options.path,
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
        applied: migration.applied.map((item) => item.name)
      })
      return { database, migration, preMigrationBackup }
    } catch (error) {
      database.close()
      if (error instanceof JupiterError) throw error
      throw new JupiterError(
        'DATABASE_UNREADABLE',
        `Jupiter cannot use its database: ${describeError(error)}`,
        {
          category: 'dependency',
          userAction: `Jupiter did not change the file. Check ${options.path}, then press Retry.`,
          retryable: true,
          details: { path: options.path },
          cause: error
        }
      )
    }
  }

  get path(): string {
    return this.options.path
  }

  info(): DatabaseInfo {
    const walPath = `${this.options.path}-wal`
    const applied = planMigrations(this.db, this.options.migrations).applied
    return {
      path: this.options.path,
      sizeBytes: existsSync(this.options.path) ? statSync(this.options.path).size : 0,
      walBytes: existsSync(walPath) ? statSync(walPath).size : 0,
      schemaVersion: applied.length,
      latestKnownVersion: this.options.migrations.length,
      migrations: [...applied],
      journalMode: this.pragma('journal_mode'),
      foreignKeys: this.pragma('foreign_keys') === '1',
      integrity: this.integrity,
      sqliteVersion: this.scalar('SELECT sqlite_version() AS value'),
      counts: {
        events: this.events.count(),
        auditEntries: this.audit.count(),
        settings: Number(this.scalar('SELECT count(*) AS value FROM settings'))
      },
      backups: this.listBackups()
    }
  }

  /**
   * Copy the live database to the backups folder with SQLite's online backup,
   * verify the copy (integrity check and schema version) and only then give it
   * its final name. A cancelled or failed backup leaves no file behind.
   */
  async backup(reason: BackupInfo['reason'], options: BackupOptions = {}): Promise<BackupInfo> {
    mkdirSync(this.options.backupDirectory, { recursive: true })
    const createdAt = this.options.now()
    const stamp = createdAt.toISOString().replace(/[-:]/g, '').replace('.', '')
    let file = `jupiter-${stamp}-${reason}.db`
    for (let n = 2; existsSync(join(this.options.backupDirectory, file)); n++)
      file = `jupiter-${stamp}-${reason}-${String(n)}.db`
    const target = join(this.options.backupDirectory, file)
    const partial = `${target}.partial`

    try {
      await sqliteBackup(this.db, partial, {
        rate: 256,
        progress: ({ totalPages, remainingPages }) => {
          if (options.signal?.aborted) throw new Error('Backup cancelled')
          options.onProgress?.(totalPages - remainingPages, totalPages)
        }
      })
      if (options.signal?.aborted) throw new Error('Backup cancelled')
      this.makeSelfContained(partial)
      this.verifyBackup(partial)
      renameSync(partial, target)
    } catch (error) {
      for (const leftover of [partial, `${partial}-wal`, `${partial}-shm`])
        rmSync(leftover, { force: true })
      if (options.signal?.aborted) {
        throw new JupiterError(
          'BACKUP_CANCELLED',
          'The backup was cancelled; no backup file was kept.',
          {
            category: 'cancellation',
            userAction: null
          }
        )
      }
      throw new JupiterError(
        'BACKUP_FAILED',
        `The database backup failed: ${describeError(error)}`,
        {
          category: 'dependency',
          userAction: `Make sure ${this.options.backupDirectory} is writable and the disk has space, then try again.`,
          retryable: true,
          cause: error
        }
      )
    }
    this.pruneBackups(reason)
    const info: BackupInfo = {
      file,
      bytes: statSync(target).size,
      createdAt: createdAt.toISOString(),
      reason
    }
    this.options.logger?.info('database.backup.completed', `Database backed up to ${file}`, {
      ...info
    })
    return info
  }

  /** Write the WAL back into the main file. Used on graceful shutdown. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      if (this.db.isOpen) this.db.close()
    } catch (error) {
      this.options.logger?.warn(
        'database.close.failed',
        `Closing the database failed: ${describeError(error)}`
      )
    }
  }

  private configure(): void {
    const journal = this.pragmaSet('journal_mode', 'WAL')
    if (journal.toLowerCase() !== 'wal' && this.options.path !== ':memory:') {
      throw new Error(`SQLite refused WAL mode (journal_mode=${journal})`)
    }
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA foreign_keys = ON')
    if (this.pragma('foreign_keys') !== '1')
      throw new Error('SQLite refused to enable foreign keys')
  }

  private quickCheck(): string {
    const rows = this.db.prepare('PRAGMA quick_check').all()
    const results = rows.map((row) => String(Object.values(row)[0]))
    return results.length === 1 && results[0] === 'ok' ? 'ok' : results.slice(0, 5).join('; ')
  }

  /**
   * The copy inherits WAL mode from the live database. Switch it to a plain
   * rollback journal so the backup is one self-contained file: no `-wal` or
   * `-shm` companions are created now (by the verification) or later (by
   * whoever opens it to restore).
   */
  private makeSelfContained(path: string): void {
    const copy = new DatabaseSync(path)
    try {
      copy.exec('PRAGMA journal_mode = DELETE')
    } finally {
      copy.close()
    }
  }

  private verifyBackup(path: string): void {
    const copy = new DatabaseSync(path, { readOnly: true })
    try {
      const check = copy
        .prepare('PRAGMA integrity_check')
        .all()
        .map((row) => String(Object.values(row)[0]))
      if (check.length !== 1 || check[0] !== 'ok')
        throw new Error(`the copy failed its integrity check: ${check.join('; ')}`)
      const expected = planMigrations(this.db, this.options.migrations).currentVersion
      const actual = planMigrations(copy, this.options.migrations).currentVersion
      if (actual !== expected)
        throw new Error(
          `the copy has schema version ${String(actual)}, expected ${String(expected)}`
        )
    } finally {
      copy.close()
    }
  }

  private listBackups(): BackupInfo[] {
    if (!existsSync(this.options.backupDirectory)) return []
    return readdirSync(this.options.backupDirectory)
      .map((file) => ({ file, match: BACKUP_PATTERN.exec(file) }))
      .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
      .map(({ file, match }) => {
        const stamp = match[1] ?? ''
        const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`
        return {
          file,
          bytes: statSync(join(this.options.backupDirectory, file)).size,
          createdAt: iso,
          reason: match[2] === 'manual' ? ('manual' as const) : ('pre-migration' as const)
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.file.localeCompare(a.file))
      .slice(0, 50)
  }

  /** Only ever deletes files this class created (matching its own naming pattern) for the same reason. */
  private pruneBackups(reason: BackupInfo['reason']): void {
    const own = this.listBackups().filter((item) => item.reason === reason)
    for (const stale of own.slice(this.options.keepBackups)) {
      rmSync(join(this.options.backupDirectory, basename(stale.file)), { force: true })
    }
  }

  private pragma(name: string): string {
    const row = this.db.prepare(`PRAGMA ${name}`).get()
    return row ? String(Object.values(row)[0]) : ''
  }

  private pragmaSet(name: string, value: string): string {
    const row = this.db.prepare(`PRAGMA ${name} = ${value}`).get()
    return row ? String(Object.values(row)[0]) : ''
  }

  private scalar(sql: string): string {
    const row = this.db.prepare(sql).get()
    return row ? String(row.value) : ''
  }
}
