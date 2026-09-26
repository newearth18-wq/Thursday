/**
 * Child process used by crash.integration.test.ts. It opens a database with
 * Jupiter's real code and then gets itself killed at a chosen moment:
 *
 *   transaction  — commits a baseline, then starts a large transaction, writes
 *                  half of it and waits to be killed before committing.
 *   migration    — applies Jupiter's migrations, then a slow extra one, and
 *                  is killed while that one is half-applied.
 */
import { writeSync } from 'node:fs'
import { uuidv7 } from '@jupiter/core'
import { JupiterDatabase, JUPITER_MIGRATIONS, type Migration } from '../../src'

const [mode, path, backupDirectory] = process.argv.slice(2)
if (!mode || !path || !backupDirectory) throw new Error('usage: crash-writer <mode> <db> <backups>')

const actor = { type: 'core' as const, id: 'crash-writer' }
const block = () => {
  // Stay alive, holding the open transaction, until the parent kills us.
  setInterval(() => undefined, 1000)
}

if (mode === 'transaction') {
  const { database } = await JupiterDatabase.open({ path, backupDirectory })
  database.transactions.run(() => {
    database.settings.put('logging.level', 'info', actor, new Date().toISOString())
  })
  // The real transaction API: write half the work, then spin inside the open
  // transaction until the parent kills the process before it can commit.
  database.transactions.run(() => {
    database.settings.put('logging.level', 'debug', actor, new Date().toISOString())
    for (let i = 0; i < 2000; i++) {
      database.transactions.run(() => {
        database.events.append({
          eventId: uuidv7(),
          type: 'core.stopped',
          stream: { kind: 'mission', id: `uncommitted-${String(i)}` },
          occurredAt: new Date().toISOString(),
          correlationId: uuidv7(),
          causationId: null,
          actor,
          missionId: null,
          executionId: null,
          payload: { reason: 'shutdown' }
        })
      })
    }
    writeSync(1, 'IN_TRANSACTION\n')
    for (;;) {
      // Busy-wait: the transaction stays open until SIGKILL.
    }
  })
} else if (mode === 'migration') {
  const slow: Migration = {
    version: JUPITER_MIGRATIONS.length + 1,
    name: '9999_slow_migration',
    sql: `
      CREATE TABLE crash_probe (id INTEGER PRIMARY KEY, note TEXT);
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 200000)
      INSERT INTO crash_probe (note) SELECT 'row ' || x FROM n;
    `
  }
  // Apply Jupiter's migrations first, so the kill cannot land while the file is still being created.
  // Then signal the parent right before the slow migration starts, and keep it busy long
  // enough to be killed inside it.
  const current = await JupiterDatabase.open({ path, backupDirectory })
  current.database.close()
  writeSync(1, 'MIGRATING\n')
  const spin = {
    ...slow,
    sql: `${slow.sql}\nWITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50000000) SELECT count(*) FROM n;`
  }
  await JupiterDatabase.open({ path, backupDirectory, migrations: [...JUPITER_MIGRATIONS, spin] })
  process.stdout.write('MIGRATION_FINISHED\n')
  block()
} else {
  throw new Error(`unknown mode ${mode}`)
}
