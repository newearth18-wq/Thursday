import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function tempDirectory(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'jupiter-db-'))
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Create a database file exactly as the committed schema-v1 fixture describes. */
export function createFixtureDatabase(path: string): void {
  const sql = readFileSync(new URL('../fixtures/schema-v1.sql', import.meta.url), 'utf8')
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(sql)
  db.close()
}

/** Open a raw connection for assertions that must bypass Jupiter's own code. */
export function raw(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

/**
 * Integrity of a database file, opened the way Jupiter opens it: read-write,
 * so SQLite first performs its normal recovery of a hot journal or WAL left by
 * a killed writer. (A read-only connection cannot recover, and fails with
 * SQLITE_READONLY_ROLLBACK when the kill landed while a journal was hot.)
 */
export function integrityOf(path: string): string[] {
  const db = new DatabaseSync(path)
  try {
    return db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => String(Object.values(row)[0]))
  } finally {
    db.close()
  }
}
