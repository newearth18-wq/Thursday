import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase, JUPITER_MIGRATIONS, migrationChecksum, type Migration } from '../src'
import { createFixtureDatabase, integrityOf, raw, tempDirectory } from './support/helpers'

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

async function open(path: string, migrations?: readonly Migration[]) {
  const result = await JupiterDatabase.open({
    path,
    backupDirectory: join(dir, 'backups'),
    ...(migrations ? { migrations } : {})
  })
  opened.push(result.database)
  return result
}

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('migrations on a new database', () => {
  it('creates every table at the latest version, in WAL mode with foreign keys on', async () => {
    const { database, migration, preMigrationBackup } = await open(join(dir, 'jupiter.db'))
    expect(migration).toEqual({
      fromVersion: 0,
      toVersion: JUPITER_MIGRATIONS.length,
      applied: JUPITER_MIGRATIONS.map(({ version, name }) => ({ version, name }))
    })
    expect(preMigrationBackup).toBeNull()
    const info = database.info()
    expect(info).toMatchObject({
      schemaVersion: 2,
      latestKnownVersion: 2,
      journalMode: 'wal',
      foreignKeys: true,
      integrity: 'ok'
    })
    expect(info.migrations.map((item) => item.checksum)).toEqual(
      JUPITER_MIGRATIONS.map(migrationChecksum)
    )

    const db = raw(join(dir, 'jupiter.db'))
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name)
    db.close()
    expect(tables).toEqual(
      expect.arrayContaining([
        'schema_migrations',
        'settings',
        'events',
        'event_streams',
        'audit_log',
        'service_health'
      ])
    )
  })

  it('is a no-op when opened again', async () => {
    const path = join(dir, 'jupiter.db')
    ;(await open(path)).database.close()
    const second = await open(path)
    expect(second.migration.applied).toEqual([])
    expect(second.preMigrationBackup).toBeNull()
  })
})

describe('upgrading the previous schema fixture', () => {
  it('backs up, migrates v1 → v2 and keeps every existing row', async () => {
    const path = join(dir, 'jupiter.db')
    createFixtureDatabase(path)
    const { database, migration, preMigrationBackup } = await open(path)

    expect(migration).toEqual({
      fromVersion: 1,
      toVersion: 2,
      applied: [{ version: 2, name: '0002_audit_and_service_health' }]
    })
    expect(preMigrationBackup?.reason).toBe('pre-migration')

    // Existing data survived, and new tables work.
    expect(database.settings.get('logging.level')?.value).toBe('warn')
    const events = database.events.readAfter(0, { types: null, streams: null, missionId: null }, 10)
    expect(events.map((event) => [event.type, event.streamSequence, event.globalSequence])).toEqual(
      [
        ['core.started', 1, 1],
        ['settings.changed', 1, 2],
        ['core.stopped', 2, 3]
      ]
    )
    expect(database.audit.count()).toBe(0)
    expect(database.info().integrity).toBe('ok')

    // The pre-migration backup is a verified copy of the old version.
    const backupPath = join(dir, 'backups', preMigrationBackup?.file ?? '')
    expect(integrityOf(backupPath)).toEqual(['ok'])
    const backup = raw(backupPath)
    expect(backup.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v).toBe(1)
    backup.close()
  })
})

describe('refusing unsafe databases (nothing is modified)', () => {
  it('refuses a schema newer than this build', async () => {
    const path = join(dir, 'jupiter.db')
    ;(await open(path)).database.close()
    const db = raw(path)
    db.prepare(
      "INSERT INTO schema_migrations VALUES (3, '0003_from_the_future', ?, '2027-01-01T00:00:00.000Z')"
    ).run('f'.repeat(64))
    db.close()
    const before = hash(path)
    await expect(open(path)).rejects.toMatchObject({
      code: 'DATABASE_SCHEMA_NEWER',
      category: 'configuration'
    })
    expect(hash(path)).toBe(before)
  })

  it('refuses a database whose applied migration differs from this build', async () => {
    const path = join(dir, 'jupiter.db')
    ;(await open(path)).database.close()
    const edited = JUPITER_MIGRATIONS.map((migration) =>
      migration.version === 1 ? { ...migration, sql: `${migration.sql}\n-- edited` } : migration
    )
    await expect(open(path, edited)).rejects.toMatchObject({ code: 'DATABASE_MIGRATION_MODIFIED' })
  })

  it('rolls back a failing migration completely', async () => {
    const path = join(dir, 'jupiter.db')
    ;(await open(path)).database.close()
    const broken: Migration = {
      version: 3,
      name: '0003_broken',
      sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO no_such_table VALUES (1);'
    }
    await expect(open(path, [...JUPITER_MIGRATIONS, broken])).rejects.toMatchObject({
      code: 'DATABASE_MIGRATION_FAILED'
    })
    const db = raw(path)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()
    ).toBeUndefined()
    expect(db.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v).toBe(2)
    db.close()
    expect(integrityOf(path)).toEqual(['ok'])
  })

  it('reports a file that is not a database and leaves it untouched', async () => {
    const path = join(dir, 'jupiter.db')
    writeFileSync(path, 'this is not a database, it is a shopping list')
    const before = hash(path)
    await expect(open(path)).rejects.toMatchObject({
      code: 'DATABASE_UNREADABLE',
      category: 'dependency',
      retryable: true
    })
    expect(hash(path)).toBe(before)
  })
})

describe('schema guarantees', () => {
  it('keeps events and the audit log append-only', async () => {
    const path = join(dir, 'jupiter.db')
    createFixtureDatabase(path)
    ;(await open(path)).database.close()
    const db = raw(path)
    expect(() => {
      db.exec("UPDATE events SET type = 'x'")
    }).toThrow(/append-only/)
    expect(() => {
      db.exec('DELETE FROM events')
    }).toThrow(/append-only/)
    db.close()
  })

  it('enforces foreign keys between events and their streams', async () => {
    ;(await open(join(dir, 'jupiter.db'))).database.close()
    const db = raw(join(dir, 'jupiter.db'))
    db.exec('PRAGMA foreign_keys = ON')
    expect(() =>
      db
        .prepare(
          `INSERT INTO events (event_id, schema_version, type, stream_kind, stream_id, stream_sequence, occurred_at, recorded_at,
             correlation_id, actor_json, payload_json)
           VALUES ('e1', 1, 'core.stopped', 'system', 'missing', 1, 't', 't', 'c', '{}', '{}')`
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
    db.close()
  })
})
