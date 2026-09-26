import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Local persistence.
 *
 * Uses Node's built-in `node:sqlite`, which ships inside Electron's Node
 * runtime. That avoids a native module rebuild step entirely, which is the
 * single most common way an Electron app fails to install on a new machine.
 */

export type Row = Record<string, unknown>

let db: DatabaseSync | null = null
let dbPath = ''

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE secrets (
        key       TEXT PRIMARY KEY,
        value     BLOB NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE providers (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        label      TEXT NOT NULL,
        base_url   TEXT NOT NULL DEFAULT '',
        model      TEXT,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE provider_models (
        provider_id TEXT NOT NULL,
        model_id    TEXT NOT NULL,
        label       TEXT NOT NULL,
        cached_at   INTEGER NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      );

      CREATE TABLE plugins (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        version              TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        dir                  TEXT NOT NULL,
        enabled              INTEGER NOT NULL DEFAULT 1,
        granted_permissions  TEXT NOT NULL DEFAULT '[]',
        installed_at         INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE missions (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        goal            TEXT NOT NULL,
        status          TEXT NOT NULL,
        progress        INTEGER NOT NULL DEFAULT 0,
        current_step_id TEXT,
        errors          TEXT NOT NULL DEFAULT '[]',
        started_at      INTEGER,
        completed_at    INTEGER,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE mission_steps (
        id                TEXT PRIMARY KEY,
        mission_id        TEXT NOT NULL,
        idx               INTEGER NOT NULL,
        title             TEXT NOT NULL,
        skill_id          TEXT,
        input             TEXT,
        status            TEXT NOT NULL,
        output            TEXT,
        error             TEXT,
        attempts          INTEGER NOT NULL DEFAULT 0,
        max_attempts      INTEGER NOT NULL DEFAULT 1,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        started_at        INTEGER,
        completed_at      INTEGER
      );
      CREATE INDEX idx_steps_mission ON mission_steps(mission_id, idx);

      CREATE TABLE workflows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        nodes       TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE workflow_runs (
        id              TEXT PRIMARY KEY,
        workflow_id     TEXT NOT NULL,
        status          TEXT NOT NULL,
        current_node_id TEXT,
        context         TEXT NOT NULL DEFAULT '{}',
        log             TEXT NOT NULL DEFAULT '[]',
        error           TEXT,
        started_at      INTEGER,
        completed_at    INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_runs_workflow ON workflow_runs(workflow_id, created_at);

      CREATE TABLE logs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        level    TEXT NOT NULL,
        category TEXT NOT NULL,
        message  TEXT NOT NULL,
        data     TEXT
      );
      CREATE INDEX idx_logs_ts ON logs(ts DESC);
      CREATE INDEX idx_logs_category ON logs(category, ts DESC);
    `
  }
]

export function openDatabase(userDataDir: string): DatabaseSync {
  if (db) return db
  dbPath = join(userDataDir, 'thursday.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  let current = row?.version ?? 0
  if (!row) db.prepare('INSERT INTO schema_version(version) VALUES (0)').run()

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(migration.sql)
      db.prepare('UPDATE schema_version SET version = ?').run(migration.version)
      db.exec('COMMIT')
      current = migration.version
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(
        `Database migration ${migration.version} failed: ${(err as Error).message}. Database: ${dbPath}`
      )
    }
  }
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database accessed before openDatabase() was called')
  return db
}

export function getDbPath(): string {
  return dbPath
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

/* --------------------------- small helpers --------------------------- */

export function all(sql: string, ...params: unknown[]): Row[] {
  return getDb()
    .prepare(sql)
    .all(...(params as never[])) as Row[]
}

export function get(sql: string, ...params: unknown[]): Row | undefined {
  return getDb()
    .prepare(sql)
    .get(...(params as never[])) as Row | undefined
}

export function run(sql: string, ...params: unknown[]): void {
  getDb()
    .prepare(sql)
    .run(...(params as never[]))
}

/** SQLite has no boolean type; everything round-trips through 0/1. */
export const toBool = (v: unknown): boolean => v === 1 || v === true || v === '1'
export const fromBool = (v: boolean): number => (v ? 1 : 0)

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    const parsed = JSON.parse(value)
    return (parsed ?? fallback) as T
  } catch {
    return fallback
  }
}
