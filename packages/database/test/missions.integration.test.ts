import { join } from 'node:path'
import type { MissionStep } from '@jupiter/contracts'
import type { MissionRecord } from '@jupiter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { raw, tempDirectory } from './support/helpers'

/**
 * SET 4 tables on real SQLite files: Missions survive reopening, executions
 * keep their attempts and links, and history (transitions, errors,
 * verification results, artifacts) cannot be rewritten or erased.
 */

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

const NOW = '2026-09-26T10:00:00.000Z'
const LATER = '2026-09-26T10:05:00.000Z'
const MISSION = '01a0d82f-22b6-762b-b369-29675d970a10'
const EXEC_1 = '01a0d82f-22b6-762b-b369-29675d970a11'
const EXEC_2 = '01a0d82f-22b6-762b-b369-29675d970a12'
const STEP = '01a0d82f-22b6-762b-b369-29675d970a13'

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    missionId: MISSION,
    title: 'Write a haiku',
    userRequest: 'Write a haiku about rain',
    priority: 'normal',
    status: 'CREATED',
    pauseRequested: false,
    archivedAt: null,
    plan: null,
    currentExecutionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function step(overrides: Partial<MissionStep> = {}): MissionStep {
  return {
    stepId: STEP,
    executionId: EXEC_1,
    index: 0,
    kind: 'model.answer',
    title: 'Answer the request',
    required: true,
    status: 'PENDING',
    detail: null,
    route: null,
    error: null,
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

describe('mission store', () => {
  it('keeps a Mission, its executions, steps and history across reopening', async () => {
    let database = await open()
    const store = database.missions
    database.transactions.run(() => {
      store.insertMission(mission())
      store.insertExecution({
        executionId: EXEC_1,
        missionId: MISSION,
        attempt: 1,
        retryOf: null,
        status: 'RUNNING',
        startedAt: NOW,
        endedAt: null
      })
      store.insertStep(step())
      store.updateStep(STEP, { status: 'SUCCEEDED', startedAt: NOW, completedAt: LATER })
      store.insertTransition({
        transitionId: '01a0d82f-22b6-762b-b369-29675d970a14',
        missionId: MISSION,
        executionId: EXEC_1,
        from: 'RUNNING',
        to: 'CREATED',
        accepted: false,
        reason: 'RUNNING cannot change to CREATED',
        actor: 'user-interface',
        at: NOW
      })
      store.insertVerification({
        verificationId: '01a0d82f-22b6-762b-b369-29675d970a15',
        missionId: MISSION,
        executionId: EXEC_1,
        stepId: STEP,
        check: 'answer-present',
        passed: true,
        detail: 'The answer has 12 characters.',
        at: LATER
      })
      store.insertArtifact({
        artifactId: '01a0d82f-22b6-762b-b369-29675d970a16',
        missionId: MISSION,
        executionId: EXEC_1,
        stepId: STEP,
        kind: 'text',
        title: 'Answer',
        text: 'Rain on the roof',
        createdAt: LATER
      })
      store.updateMission(MISSION, {
        status: 'COMPLETED',
        currentExecutionId: EXEC_1,
        updatedAt: LATER
      })
    })
    database.close()
    opened.splice(0)

    database = await open()
    const again = database.missions
    expect(again.mission(MISSION)).toMatchObject({
      status: 'COMPLETED',
      currentExecutionId: EXEC_1
    })
    expect(again.steps(EXEC_1)).toEqual([
      step({ status: 'SUCCEEDED', startedAt: NOW, completedAt: LATER })
    ])
    expect(again.transitions(MISSION)[0]).toMatchObject({ accepted: false, to: 'CREATED' })
    expect(again.verifications(MISSION)[0]).toMatchObject({ passed: true })
    expect(again.artifacts(MISSION)[0]?.text).toBe('Rain on the roof')
  })

  it('links a retry to the attempt before it and keeps both', async () => {
    const database = await open()
    const store = database.missions
    store.insertMission(mission({ status: 'FAILED' }))
    store.insertExecution({
      executionId: EXEC_1,
      missionId: MISSION,
      attempt: 1,
      retryOf: null,
      status: 'FAILED',
      startedAt: NOW,
      endedAt: NOW
    })
    store.insertExecution({
      executionId: EXEC_2,
      missionId: MISSION,
      attempt: 2,
      retryOf: EXEC_1,
      status: 'RUNNING',
      startedAt: LATER,
      endedAt: null
    })
    expect(store.executions(MISSION).map((item) => [item.attempt, item.retryOf])).toEqual([
      [1, null],
      [2, EXEC_1]
    ])
    // The same attempt number twice, or a link to an execution that does not exist, is refused.
    expect(() => {
      store.insertExecution({
        executionId: '01a0d82f-22b6-762b-b369-29675d970a17',
        missionId: MISSION,
        attempt: 2,
        retryOf: null,
        status: 'RUNNING',
        startedAt: LATER,
        endedAt: null
      })
    }).toThrow(/UNIQUE/)
    expect(() => {
      store.insertExecution({
        executionId: '01a0d82f-22b6-762b-b369-29675d970a18',
        missionId: MISSION,
        attempt: 3,
        retryOf: '01a0d82f-22b6-762b-b369-29675d970aff',
        status: 'RUNNING',
        startedAt: LATER,
        endedAt: null
      })
    }).toThrow(/FOREIGN KEY/)
  })

  it('refuses to rewrite or erase history', async () => {
    const database = await open()
    const store = database.missions
    store.insertMission(mission())
    store.insertTransition({
      transitionId: '01a0d82f-22b6-762b-b369-29675d970a19',
      missionId: MISSION,
      executionId: null,
      from: 'CREATED',
      to: 'ANALYZING',
      accepted: true,
      reason: 'Started',
      actor: 'core',
      at: NOW
    })
    const db = raw(join(dir, 'jupiter.db'))
    try {
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mission_%'")
        .all()
        .map((row) => String(row.name))
        .sort()
      expect(triggers).toEqual(
        ['artifacts', 'errors', 'transitions', 'verifications']
          .flatMap((table) => [`mission_${table}_no_delete`, `mission_${table}_no_update`])
          .sort()
      )
      expect(() => {
        db.exec('DELETE FROM mission_transitions')
      }).toThrow(/append-only/)
      expect(() => {
        db.exec("UPDATE mission_transitions SET reason = 'x'")
      }).toThrow(/append-only/)
    } finally {
      db.close()
    }
  })

  it('lists newest first, hides archived Missions unless asked, and finds in-flight ones', async () => {
    const database = await open()
    const store = database.missions
    store.insertMission(mission({ status: 'RUNNING' }))
    store.insertMission(
      mission({
        missionId: '01a0d82f-22b6-762b-b369-29675d970a20',
        status: 'COMPLETED',
        archivedAt: LATER,
        updatedAt: LATER
      })
    )
    expect(
      store.listMissions({ includeArchived: false, limit: 10 }).map((m) => m.missionId)
    ).toEqual([MISSION])
    expect(store.listMissions({ includeArchived: true, limit: 10 })).toHaveLength(2)
    expect(store.inFlight().map((m) => m.missionId)).toEqual([MISSION])
  })
})
