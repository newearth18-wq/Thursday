import type { DatabaseSync } from 'node:sqlite'
import {
  SkillDefinition,
  SkillExecutionRecord,
  SkillHealth,
  ValueSummary
} from '@jupiter/contracts'
import type { SkillStateRecord, SkillStore } from '@jupiter/core'
import { integer, json, nullableInteger, nullableText, text } from '../rows'

type Row = Record<string, unknown>

const UNKNOWN_HEALTH = { status: 'UNKNOWN', detail: 'Not checked yet.' } as const

/** Skills and their executions (SET 6). Rows are validated against the contract when read. */
export class SqliteSkillStore implements SkillStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertSkill(input: SkillDefinition, at: string): SkillStateRecord {
    const definition = SkillDefinition.parse(input)
    this.db
      .prepare(
        `INSERT INTO skills (skill_id, version, definition_json, enabled, health_status, health_detail,
           health_checked_at, health_duration_ms, registered_at, unregistered_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, ?, NULL)
         ON CONFLICT (skill_id, version) DO UPDATE SET
           definition_json = excluded.definition_json, unregistered_at = NULL`
      )
      .run(
        definition.skillId,
        definition.version,
        JSON.stringify(definition),
        UNKNOWN_HEALTH.status,
        UNKNOWN_HEALTH.detail,
        at
      )
    const stored = this.skill(definition.skillId, definition.version)
    if (!stored) throw new Error(`Skill ${definition.skillId} was not stored`)
    return stored
  }

  skill(skillId: string, version: string): SkillStateRecord | null {
    const row = this.db
      .prepare('SELECT * FROM skills WHERE skill_id = ? AND version = ?')
      .get(skillId, version)
    return row ? toSkill(row) : null
  }

  versions(skillId: string): SkillStateRecord[] {
    return this.db
      .prepare('SELECT * FROM skills WHERE skill_id = ? LIMIT 50')
      .all(skillId)
      .map(toSkill)
      .sort((a, b) => compareVersions(b.definition.version, a.definition.version))
  }

  setEnabled(skillId: string, version: string, enabled: boolean): void {
    const result = this.db
      .prepare('UPDATE skills SET enabled = ? WHERE skill_id = ? AND version = ?')
      .run(enabled ? 1 : 0, skillId, version)
    if (Number(result.changes) !== 1) throw new Error(`No skill ${skillId}@${version}`)
  }

  setHealth(skillId: string, version: string, input: SkillHealth): void {
    const health = SkillHealth.parse(input)
    this.db
      .prepare(
        `UPDATE skills SET health_status = ?, health_detail = ?, health_checked_at = ?,
           health_duration_ms = ? WHERE skill_id = ? AND version = ?`
      )
      .run(health.status, health.detail, health.checkedAt, health.durationMs, skillId, version)
  }

  markUnregistered(skillId: string, version: string, at: string): void {
    this.db
      .prepare('UPDATE skills SET unregistered_at = ? WHERE skill_id = ? AND version = ?')
      .run(at, skillId, version)
  }

  insertExecution(input: SkillExecutionRecord): void {
    const record = SkillExecutionRecord.parse(input)
    this.db
      .prepare(
        `INSERT INTO skill_executions (execution_id, skill_id, version, mission_id, actor_type, status,
           permissions_json, input_summary_json, output_summary_json, error_code, idempotency_key,
           started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.executionId,
        record.skillId,
        record.version,
        record.missionId,
        record.actor,
        record.status,
        JSON.stringify(record.permissionsGranted),
        JSON.stringify(record.inputSummary),
        record.outputSummary ? JSON.stringify(record.outputSummary) : null,
        record.errorCode,
        record.idempotencyKey,
        record.startedAt,
        record.completedAt
      )
  }

  finishExecution(
    executionId: string,
    changes: Pick<SkillExecutionRecord, 'status' | 'outputSummary' | 'errorCode' | 'completedAt'>
  ): void {
    const current = this.execution(executionId)
    if (!current) throw new Error(`No skill execution ${executionId}`)
    const next = SkillExecutionRecord.parse({ ...current, ...changes })
    this.db
      .prepare(
        `UPDATE skill_executions SET status = ?, output_summary_json = ?, error_code = ?, completed_at = ?
         WHERE execution_id = ?`
      )
      .run(
        next.status,
        next.outputSummary ? JSON.stringify(next.outputSummary) : null,
        next.errorCode,
        next.completedAt,
        executionId
      )
  }

  execution(executionId: string): SkillExecutionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM skill_executions WHERE execution_id = ?')
      .get(executionId)
    return row ? toExecution(row) : null
  }

  executionByKey(skillId: string, idempotencyKey: string): SkillExecutionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM skill_executions WHERE skill_id = ? AND idempotency_key = ?')
      .get(skillId, idempotencyKey)
    return row ? toExecution(row) : null
  }

  executions(options: { skillId?: string | undefined; limit: number }): SkillExecutionRecord[] {
    const rows =
      options.skillId === undefined
        ? this.db
            .prepare(
              'SELECT * FROM skill_executions ORDER BY started_at DESC, execution_id DESC LIMIT ?'
            )
            .all(options.limit)
        : this.db
            .prepare(
              `SELECT * FROM skill_executions WHERE skill_id = ?
               ORDER BY started_at DESC, execution_id DESC LIMIT ?`
            )
            .all(options.skillId, options.limit)
    return rows.map(toExecution)
  }

  running(): SkillExecutionRecord[] {
    return this.db
      .prepare("SELECT * FROM skill_executions WHERE status = 'RUNNING' ORDER BY started_at")
      .all()
      .map(toExecution)
  }
}

/** Numeric comparison of `major.minor.patch`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function toSkill(row: Row): SkillStateRecord {
  return {
    definition: SkillDefinition.parse(json(row, 'definition_json')),
    enabled: integer(row, 'enabled') === 1,
    health: SkillHealth.parse({
      status: text(row, 'health_status'),
      detail: text(row, 'health_detail'),
      checkedAt: nullableText(row, 'health_checked_at'),
      durationMs: nullableInteger(row, 'health_duration_ms')
    }),
    registeredAt: text(row, 'registered_at'),
    unregisteredAt: nullableText(row, 'unregistered_at')
  }
}

function toExecution(row: Row): SkillExecutionRecord {
  const output = nullableText(row, 'output_summary_json')
  return SkillExecutionRecord.parse({
    executionId: text(row, 'execution_id'),
    skillId: text(row, 'skill_id'),
    version: text(row, 'version'),
    missionId: nullableText(row, 'mission_id'),
    actor: text(row, 'actor_type'),
    status: text(row, 'status'),
    permissionsGranted: json(row, 'permissions_json'),
    inputSummary: ValueSummary.parse(json(row, 'input_summary_json')),
    outputSummary: output === null ? null : ValueSummary.parse(JSON.parse(output)),
    errorCode: nullableText(row, 'error_code'),
    idempotencyKey: nullableText(row, 'idempotency_key'),
    startedAt: text(row, 'started_at'),
    completedAt: nullableText(row, 'completed_at')
  })
}
