import { join } from 'node:path'
import { SKILL_RUNTIME, type SkillDefinition, type SkillExecutionRecord } from '@jupiter/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JupiterDatabase } from '../src'
import { tempDirectory } from './support/helpers'

/** SET 6 tables on real SQLite files: Skill state survives reopening, and executions keep only shapes. */

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

const definition = (version = '1.0.0'): SkillDefinition => ({
  skillId: 'echo_text',
  name: 'Echo text',
  description: 'Returns its input.',
  version,
  category: 'text',
  provider: 'internal',
  compatibleRuntime: SKILL_RUNTIME,
  permissions: [],
  timeoutMs: 5_000,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } } }
})

const execution = (overrides: Partial<SkillExecutionRecord> = {}): SkillExecutionRecord => ({
  executionId: '01a0d82f-22b6-762b-b369-29675d970b01',
  skillId: 'echo_text',
  version: '1.0.0',
  missionId: null,
  actor: 'user-interface',
  status: 'RUNNING',
  permissionsGranted: [],
  inputSummary: { type: 'object', size: 1, fields: ['text'] },
  outputSummary: null,
  errorCode: null,
  idempotencyKey: null,
  startedAt: NOW,
  completedAt: null,
  ...overrides
})

describe('skill store', () => {
  it('keeps enabled state and health across re-registration and reopening', async () => {
    let database = await open()
    database.skills.upsertSkill(definition(), NOW)
    database.skills.setEnabled('echo_text', '1.0.0', false)
    database.skills.setHealth('echo_text', '1.0.0', {
      status: 'HEALTHY',
      detail: 'ok',
      checkedAt: LATER,
      durationMs: 12
    })
    database.close()
    opened.splice(0)

    database = await open()
    const again = database.skills.upsertSkill(definition(), LATER)
    expect(again).toMatchObject({
      enabled: false,
      health: { status: 'HEALTHY', checkedAt: LATER, durationMs: 12 },
      registeredAt: NOW,
      unregisteredAt: null
    })
    database.skills.upsertSkill(definition('1.10.0'), LATER)
    database.skills.upsertSkill(definition('1.2.0'), LATER)
    expect(database.skills.versions('echo_text').map((item) => item.definition.version)).toEqual([
      '1.10.0',
      '1.2.0',
      '1.0.0'
    ])
  })

  it('records executions, refuses a repeated idempotency key and unknown Skills', async () => {
    const database = await open()
    database.skills.upsertSkill(definition(), NOW)
    database.skills.insertExecution(execution({ idempotencyKey: 'k' }))
    expect(database.skills.running()).toHaveLength(1)
    database.skills.finishExecution(execution().executionId, {
      status: 'SUCCESS',
      outputSummary: { type: 'object', size: 1, fields: ['text'] },
      errorCode: null,
      completedAt: LATER
    })
    expect(database.skills.running()).toEqual([])
    expect(database.skills.executionByKey('echo_text', 'k')?.status).toBe('SUCCESS')
    expect(() => {
      database.skills.insertExecution(
        execution({ executionId: '01a0d82f-22b6-762b-b369-29675d970b02', idempotencyKey: 'k' })
      )
    }).toThrow(/UNIQUE/)
    expect(() => {
      database.skills.insertExecution(
        execution({ executionId: '01a0d82f-22b6-762b-b369-29675d970b03', skillId: 'ghost' })
      )
    }).toThrow(/FOREIGN KEY/)
    expect(database.skills.executions({ limit: 10 })).toHaveLength(1)
  })
})
