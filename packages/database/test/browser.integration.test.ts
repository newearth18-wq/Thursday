import { join } from 'node:path'
import type { BrowserTask } from '@jupiter/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

/** SET 9 table on real SQLite files: Browser Agent tasks, validated when read, linked to Missions. */

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

async function open(): Promise<JupiterDatabase> {
  const { database } = await JupiterDatabase.open({
    path: join(dir, 'jupiter.db'),
    backupDirectory: join(dir, 'backups')
  })
  opened.push(database)
  return database
}

const MISSION = '01a0d82f-22b6-762b-b369-29675d970c01'
const SESSION = '01a0d82f-22b6-762b-b369-29675d970d01'

const task = (overrides: Partial<BrowserTask> = {}): BrowserTask => ({
  taskId: '01a0d82f-22b6-762b-b369-29675d970e01',
  missionId: null,
  sessionId: SESSION,
  title: 'Read the article',
  status: 'RUNNING',
  actions: [
    { type: 'NAVIGATE', origin: 'http://127.0.0.1:8080' },
    { type: 'READ_PAGE', origin: null }
  ],
  allowedOrigins: ['http://127.0.0.1:8080'],
  results: [],
  error: null,
  permissionRequests: [],
  allowCoordinateFallback: false,
  createdAt: '2026-09-27T10:00:00.000Z',
  completedAt: null,
  ...overrides
})

describe('browser task store', () => {
  it('saves a task, updates it as it runs, and reads it back validated', async () => {
    const database = await open()
    database.browser.save(task())
    expect(database.browser.running().map((item) => item.taskId)).toEqual([task().taskId])
    const finished = task({
      status: 'SUCCEEDED',
      completedAt: '2026-09-27T10:00:05.000Z',
      results: [
        {
          index: 0,
          action: 'NAVIGATE',
          target: 'http://127.0.0.1:8080/',
          success: true,
          method: 'page',
          url: 'http://127.0.0.1:8080/',
          origin: 'http://127.0.0.1:8080',
          title: 'Fixture Shop',
          observation: 'Opened http://127.0.0.1:8080/ (HTTP 200).',
          content: null,
          extraction: null,
          suspicious: [],
          evidence: null,
          error: null,
          startedAt: '2026-09-27T10:00:01.000Z',
          completedAt: '2026-09-27T10:00:02.000Z'
        }
      ]
    })
    database.browser.save(finished)
    expect(database.browser.task(finished.taskId)).toEqual(finished)
    expect(database.browser.running()).toEqual([])
    expect(database.browser.tasks(10)).toHaveLength(1)
  })

  it('lists newest first, and a Mission’s tasks oldest first', async () => {
    const database = await open()
    const first = '01a0d82f-22b6-762b-b369-29675d970e02'
    const second = '01a0d82f-22b6-762b-b369-29675d970e03'
    database.browser.save(
      task({ taskId: first, missionId: MISSION, createdAt: '2026-09-27T10:00:00.000Z' })
    )
    database.browser.save(
      task({ taskId: second, missionId: MISSION, createdAt: '2026-09-27T10:01:00.000Z' })
    )
    database.browser.save(task({ createdAt: '2026-09-27T10:02:00.000Z' }))
    expect(database.browser.tasks(2).map((item) => item.taskId)).toEqual([task().taskId, second])
    expect(database.browser.forMission(MISSION).map((item) => item.taskId)).toEqual([first, second])
  })

  it('refuses an invalid task before writing, and the table refuses an unknown status', async () => {
    const database = await open()
    expect(() => {
      database.browser.save({ ...task(), status: 'DONE' } as unknown as BrowserTask)
    }).toThrow()
    expect(database.browser.tasks(10)).toEqual([])
    const direct = raw(join(dir, 'jupiter.db'))
    try {
      expect(() =>
        direct
          .prepare(
            `INSERT INTO browser_tasks (task_id, session_id, status, task_json, created_at)
             VALUES ('x', 'y', 'DONE', '{}', '2026-09-27T10:00:00.000Z')`
          )
          .run()
      ).toThrow(/CHECK/)
    } finally {
      direct.close()
    }
  })
})
