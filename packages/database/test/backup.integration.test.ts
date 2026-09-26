import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@jupiter/core'
import { JupiterDatabase } from '../src'
import { integrityOf, raw, tempDirectory } from './support/helpers'

let dir: string
let cleanup: () => void
let database: JupiterDatabase
let clock = Date.UTC(2026, 8, 25, 10, 0, 0)

beforeEach(async () => {
  ;({ dir, cleanup } = tempDirectory())
  database = (
    await JupiterDatabase.open({
      path: join(dir, 'jupiter.db'),
      backupDirectory: join(dir, 'backups'),
      keepBackups: 3,
      now: () => new Date((clock += 1000))
    })
  ).database
  // Enough data that the backup copies many pages and reports real progress.
  const actor = { type: 'core' as const, id: 'test' }
  database.transactions.run(() => {
    for (let i = 0; i < 12000; i++) {
      database.events.append({
        eventId: uuidv7(),
        type: 'settings.changed',
        stream: { kind: 'settings', id: 'logging.level' },
        occurredAt: new Date(clock).toISOString(),
        correlationId: uuidv7(),
        causationId: null,
        actor,
        missionId: null,
        executionId: null,
        payload: { key: 'logging.level', previousValue: 'info', value: `debug ${'x'.repeat(150)}` }
      })
    }
  })
})

afterEach(() => {
  database.close()
  cleanup()
})

describe('database backups', () => {
  it('produces a verified copy and reports measurable progress', async () => {
    const progress: [number, number][] = []
    const info = await database.backup('manual', {
      onProgress: (done, total) => progress.push([done, total])
    })

    expect(info.reason).toBe('manual')
    expect(info.bytes).toBeGreaterThan(100_000)
    const path = join(dir, 'backups', info.file)
    // One self-contained file (rollback journal), with no -wal/-shm companions.
    expect(readdirSync(join(dir, 'backups'))).toEqual([info.file])
    const copy = raw(path)
    expect(copy.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete')
    copy.close()
    expect(integrityOf(path)).toEqual(['ok'])
    expect(progress.length).toBeGreaterThan(1)
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.[0]).toBeGreaterThanOrEqual(progress[i - 1]?.[0] ?? 0)
    }
    const [done, total] = progress.at(-1) ?? [0, 0]
    expect(done).toBeLessThanOrEqual(total)
    expect(database.info().backups[0]?.file).toBe(info.file)
  })

  it('keeps no file when cancelled', async () => {
    const controller = new AbortController()
    const attempt = database.backup('manual', {
      signal: controller.signal,
      onProgress: () => {
        controller.abort()
      }
    })
    await expect(attempt).rejects.toMatchObject({
      code: 'BACKUP_CANCELLED',
      category: 'cancellation'
    })
    expect(readdirSync(join(dir, 'backups'))).toEqual([])
  })

  it('prunes only its own old backups and never touches other files', async () => {
    writeFileSync(join(dir, 'backups-placeholder'), '')
    const mine: string[] = []
    for (let i = 0; i < 5; i++) mine.push((await database.backup('manual')).file)
    const person = join(dir, 'backups', 'my-important-copy.db')
    writeFileSync(person, 'belongs to the person')

    await database.backup('manual')
    const files = readdirSync(join(dir, 'backups'))
    expect(files).toContain('my-important-copy.db')
    expect(files.filter((file) => file.endsWith('-manual.db'))).toHaveLength(3)
    expect(existsSync(join(dir, 'backups', mine[0] ?? ''))).toBe(false)
  })
})
