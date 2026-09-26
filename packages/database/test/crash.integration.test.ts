import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JUPITER_MIGRATIONS, JupiterDatabase } from '../src'
import { integrityOf, raw, tempDirectory } from './support/helpers'

/**
 * A process killed in the middle of a transaction or a migration must leave a
 * consistent database: the interrupted work disappears entirely, committed work
 * stays, and the file passes SQLite's integrity check.
 */

let dir: string
let cleanup: () => void

beforeEach(() => {
  ;({ dir, cleanup } = tempDirectory())
})

afterEach(() => {
  cleanup()
})

const writer = join(import.meta.dirname, 'support', 'crash-writer.ts')

/** Start the writer, wait for `marker` on stdout, then SIGKILL it. */
function killAt(mode: string, marker: string, delayMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--import',
        'tsx',
        writer,
        mode,
        join(dir, 'jupiter.db'),
        join(dir, 'backups')
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out waiting for ${marker}; output: ${output}`))
    }, 60_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes(marker)) {
        setTimeout(() => child.kill('SIGKILL'), delayMs)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (signal === 'SIGKILL' || (process.platform === 'win32' && code !== 0)) resolve()
      else reject(new Error(`writer exited on its own (code ${String(code)}); output: ${output}`))
    })
  })
}

describe('interrupted work never corrupts the database', () => {
  it('discards a transaction killed before commit and keeps committed data', async () => {
    await killAt('transaction', 'IN_TRANSACTION')

    expect(integrityOf(join(dir, 'jupiter.db'))).toEqual(['ok'])
    const { database } = await JupiterDatabase.open({
      path: join(dir, 'jupiter.db'),
      backupDirectory: join(dir, 'backups')
    })
    expect(database.settings.get('logging.level')?.value).toBe('info')
    expect(database.events.count()).toBe(0)
    database.close()
    const db = raw(join(dir, 'jupiter.db'))
    expect(
      db
        .prepare("SELECT count(*) AS n FROM event_streams WHERE stream_id LIKE 'uncommitted-%'")
        .get()?.n
    ).toBe(0)
    db.close()
  })

  it('leaves no trace of a migration killed half-way, and completes it on the next start', async () => {
    await killAt('migration', 'MIGRATING', 300)

    expect(integrityOf(join(dir, 'jupiter.db'))).toEqual(['ok'])
    const db = raw(join(dir, 'jupiter.db'))
    const version = db.prepare('SELECT max(version) AS v FROM schema_migrations').get()?.v
    const probe = db.prepare("SELECT name FROM sqlite_master WHERE name = 'crash_probe'").get()
    db.close()
    // Jupiter's migrations committed; the slow one was rolled back as a whole.
    expect(version).toBe(JUPITER_MIGRATIONS.length)
    expect(probe).toBeUndefined()

    const { database, migration } = await JupiterDatabase.open({
      path: join(dir, 'jupiter.db'),
      backupDirectory: join(dir, 'backups')
    })
    expect(migration.applied).toEqual([])
    expect(database.info()).toMatchObject({
      schemaVersion: JUPITER_MIGRATIONS.length,
      integrity: 'ok'
    })
    database.close()
  })
})
