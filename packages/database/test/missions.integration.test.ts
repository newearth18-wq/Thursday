import { join } from 'node:path'
import type { MissionStep, Plan } from '@jupiter/contracts'
import type { ExecutionRecord, MissionRecord } from '@jupiter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase, JUPITER_MIGRATIONS, type Migration } from '../src'
import { raw, tempDirectory } from './support/helpers'

/**
 * SET 4–5 tables on real SQLite files: Missions survive reopening, executions
 * keep their attempts and links, plan revisions and step attempts are kept,
 * history (transitions, errors, verification results, artifacts, plans,
 * rejections, attempts) cannot be rewritten or erased, and a SET 4 database
 * upgrades without losing a row.
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

async function open(migrations?: readonly Migration[]): Promise<JupiterDatabase> {
  const { database } = await JupiterDatabase.open({
    path: join(dir, 'jupiter.db'),
    backupDirectory: join(dir, 'backups'),
    ...(migrations ? { migrations } : {})
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
const PLAN_1 = '01a0d82f-22b6-762b-b369-29675d970a21'
const PLAN_2 = '01a0d82f-22b6-762b-b369-29675d970a22'

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
    currentPlanId: null,
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
    key: 'answer',
    kind: 'model.generate',
    title: 'Answer the request',
    description: 'The chat model answers.',
    dependencies: [],
    required: true,
    status: 'PENDING',
    detail: null,
    route: null,
    error: null,
    attempts: 0,
    maxAttempts: 2,
    timeoutMs: 60_000,
    waitingFor: null,
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: EXEC_1,
    missionId: MISSION,
    attempt: 1,
    retryOf: null,
    planId: null,
    status: 'RUNNING',
    startedAt: NOW,
    endedAt: null,
    ...overrides
  }
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: PLAN_1,
    missionId: MISSION,
    revision: 1,
    previousPlanId: null,
    source: 'model',
    reason: 'First plan',
    createdAt: NOW,
    goal: 'Write a haiku about rain',
    assumptions: ['A haiku has three lines'],
    rationale: 'One model step, then a check.',
    steps: [
      {
        id: 'answer',
        title: 'Answer the request',
        description: 'The chat model answers.',
        skillId: 'model.generate',
        dependencies: [],
        input: { prompt: 'Write a haiku about rain' },
        condition: null,
        timeoutMs: 60_000,
        retryPolicy: { maxAttempts: 2, backoffMs: 500, multiplier: 2 },
        verification: { check: 'non-empty' },
        required: true
      }
    ],
    requiredSkills: ['model.generate'],
    requiredPermissions: [],
    expectedArtifacts: [{ step: 'answer', description: 'The haiku' }],
    verificationPlan: {
      checks: [{ step: 'answer', check: 'non-empty', description: 'There is an answer' }]
    },
    ...overrides
  }
}

describe('mission store', () => {
  it('keeps a Mission, its executions, steps and history across reopening', async () => {
    let database = await open()
    const store = database.missions
    database.transactions.run(() => {
      store.insertMission(mission())
      store.insertExecution(execution())
      store.insertStep(step())
      store.updateStep(STEP, {
        status: 'COMPLETED',
        attempts: 1,
        startedAt: NOW,
        completedAt: LATER
      })
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
      step({ status: 'COMPLETED', attempts: 1, startedAt: NOW, completedAt: LATER })
    ])
    expect(again.transitions(MISSION)[0]).toMatchObject({ accepted: false, to: 'CREATED' })
    expect(again.verifications(MISSION)[0]).toMatchObject({ passed: true })
    expect(again.artifacts(MISSION)[0]?.text).toBe('Rain on the roof')
  })

  it('links a retry to the attempt before it and keeps both', async () => {
    const database = await open()
    const store = database.missions
    store.insertMission(mission({ status: 'FAILED' }))
    store.insertExecution(execution({ status: 'FAILED', endedAt: NOW }))
    store.insertExecution(
      execution({ executionId: EXEC_2, attempt: 2, retryOf: EXEC_1, startedAt: LATER })
    )
    expect(store.executions(MISSION).map((item) => [item.attempt, item.retryOf])).toEqual([
      [1, null],
      [2, EXEC_1]
    ])
    // The same attempt number twice, or a link to an execution that does not exist, is refused.
    expect(() => {
      store.insertExecution(
        execution({
          executionId: '01a0d82f-22b6-762b-b369-29675d970a17',
          attempt: 2,
          startedAt: LATER
        })
      )
    }).toThrow(/UNIQUE/)
    expect(() => {
      store.insertExecution(
        execution({
          executionId: '01a0d82f-22b6-762b-b369-29675d970a18',
          attempt: 3,
          retryOf: '01a0d82f-22b6-762b-b369-29675d970aff',
          startedAt: LATER
        })
      )
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
        [
          'artifacts',
          'errors',
          'transitions',
          'verifications',
          'plans',
          'plan_rejections',
          'step_attempts'
        ]
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

  it('keeps every plan revision and every step attempt, and refuses to change them', async () => {
    const database = await open()
    const store = database.missions
    database.transactions.run(() => {
      store.insertMission(mission({ status: 'RUNNING' }))
      store.insertPlan(plan())
      store.insertPlan(
        plan({
          planId: PLAN_2,
          revision: 2,
          previousPlanId: PLAN_1,
          reason: 'Re-planned after step "answer" failed',
          createdAt: LATER
        })
      )
      store.updateMission(MISSION, { currentPlanId: PLAN_2, updatedAt: LATER })
      store.insertExecution(execution({ planId: PLAN_2 }))
      store.insertStep(step(), plan().steps[0])
      store.insertAttempt({
        stepId: STEP,
        attempt: 1,
        outcome: 'timed-out',
        errorCode: 'STEP_TIMEOUT',
        startedAt: NOW,
        endedAt: LATER
      })
      store.insertAttempt({
        stepId: STEP,
        attempt: 2,
        outcome: 'completed',
        errorCode: null,
        startedAt: LATER,
        endedAt: LATER
      })
      store.insertPlanRejection({
        rejectionId: '01a0d82f-22b6-762b-b369-29675d970a23',
        missionId: MISSION,
        issues: [{ code: 'cycle', message: 'Steps a and b depend on each other.', step: 'a' }],
        at: NOW
      })
    })
    expect(store.plans(MISSION).map((item) => [item.revision, item.previousPlanId])).toEqual([
      [1, null],
      [2, PLAN_1]
    ])
    expect(store.plan(PLAN_2)).toEqual(
      plan({
        planId: PLAN_2,
        revision: 2,
        previousPlanId: PLAN_1,
        reason: 'Re-planned after step "answer" failed',
        createdAt: LATER
      })
    )
    expect(store.mission(MISSION)?.currentPlanId).toBe(PLAN_2)
    expect(store.executions(MISSION)[0]?.planId).toBe(PLAN_2)
    expect(store.attempts(EXEC_1).map((item) => item.outcome)).toEqual(['timed-out', 'completed'])
    expect(store.planRejections(MISSION)[0]?.issues[0]?.code).toBe('cycle')
    // The same revision twice, or the same attempt number twice, is refused.
    expect(() => {
      store.insertPlan(plan({ planId: '01a0d82f-22b6-762b-b369-29675d970a24', revision: 2 }))
    }).toThrow(/UNIQUE/)
    expect(() => {
      store.insertAttempt({
        stepId: STEP,
        attempt: 2,
        outcome: 'failed',
        errorCode: 'X',
        startedAt: LATER,
        endedAt: LATER
      })
    }).toThrow(/UNIQUE|PRIMARY/)
    const db = raw(join(dir, 'jupiter.db'))
    try {
      for (const sql of [
        'DELETE FROM mission_plans',
        "UPDATE mission_plans SET reason = 'x'",
        'DELETE FROM mission_step_attempts',
        "UPDATE mission_step_attempts SET outcome = 'failed'",
        'DELETE FROM mission_plan_rejections'
      ]) {
        expect(() => {
          db.exec(sql)
        }).toThrow(/append-only/)
      }
    } finally {
      db.close()
    }
  })

  it('upgrades a SET 4 database to SET 5 without losing a row or a reference', async () => {
    const path = join(dir, 'jupiter.db')
    const v4 = await open(JUPITER_MIGRATIONS.slice(0, 4))
    v4.close()
    opened.splice(0)
    const db = raw(path)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(`
        INSERT INTO missions VALUES ('${MISSION}', 'Old', 'Old request', 'normal', 'COMPLETED', 0, NULL,
          '{"source":"template","templateId":"answer","summary":"s","steps":[{"kind":"model.answer","title":"Answer","required":true}]}',
          '${EXEC_2}', '${NOW}', '${LATER}');
        INSERT INTO mission_executions VALUES ('${EXEC_1}', '${MISSION}', 1, NULL, 'FAILED', '${NOW}', '${NOW}');
        INSERT INTO mission_executions VALUES ('${EXEC_2}', '${MISSION}', 2, '${EXEC_1}', 'COMPLETED', '${NOW}', '${LATER}');
        INSERT INTO mission_steps VALUES ('${STEP}', '${EXEC_2}', 0, 'model.answer', 'Answer', 1, 'SUCCEEDED', NULL, NULL, NULL, '${NOW}', '${LATER}');
        INSERT INTO mission_steps VALUES ('01a0d82f-22b6-762b-b369-29675d970a30', '${EXEC_2}', 1, 'verify.answer', 'Check', 1, 'SUCCEEDED', NULL, NULL, NULL, '${LATER}', '${LATER}');
        INSERT INTO mission_verifications VALUES ('01a0d82f-22b6-762b-b369-29675d970a31', '${MISSION}', '${EXEC_2}', '01a0d82f-22b6-762b-b369-29675d970a30', 'answer-present', 1, 'ok', '${LATER}');
        INSERT INTO mission_artifacts VALUES ('01a0d82f-22b6-762b-b369-29675d970a32', '${MISSION}', '${EXEC_2}', '${STEP}', 'text', 'Answer', 'Rain', '${LATER}');
      `)
    } finally {
      db.close()
    }

    const database = await open()
    const store = database.missions
    expect(store.mission(MISSION)).toMatchObject({ status: 'COMPLETED', currentPlanId: null })
    expect(
      store.executions(MISSION).map((item) => [item.status, item.retryOf, item.planId])
    ).toEqual([
      ['FAILED', null, null],
      ['COMPLETED', EXEC_1, null]
    ])
    expect(store.steps(EXEC_2).map((item) => [item.key, item.status, item.dependencies])).toEqual([
      ['step-1', 'COMPLETED', []],
      ['step-2', 'COMPLETED', ['step-1']]
    ])
    expect(store.verifications(MISSION)).toHaveLength(1)
    expect(store.artifacts(MISSION)[0]?.text).toBe('Rain')
    const check = raw(path)
    try {
      expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(check.prepare('PRAGMA foreign_keys').get()).toBeDefined()
    } finally {
      check.close()
    }
    // Foreign keys are enforced again after the rebuild.
    expect(() => {
      store.insertStep(
        step({
          stepId: '01a0d82f-22b6-762b-b369-29675d970a33',
          executionId: '01a0d82f-22b6-762b-b369-29675d970aff'
        })
      )
    }).toThrow(/FOREIGN KEY/)
  })
})
