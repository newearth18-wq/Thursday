import type { DatabaseSync } from 'node:sqlite'
import { AuditEvent } from '@jupiter/contracts'
import type { AuditStore } from '@jupiter/core'
import { integer, json, nullableText, text } from '../rows'

export class SqliteAuditStore implements AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  append(entry: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (
           audit_id, event_type, actor_json, capability, target, decision, risk_level, mission_id, execution_id,
           timestamp, metadata_json, correlation_id, outcome
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.auditId,
        entry.eventType,
        JSON.stringify(entry.actor),
        entry.capability,
        entry.target,
        entry.decision,
        entry.riskLevel,
        entry.missionId,
        entry.executionId,
        entry.timestamp,
        JSON.stringify(entry.metadataRedacted),
        entry.correlationId,
        entry.outcome
      )
  }

  recent(limit: number): AuditEvent[] {
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY sequence DESC LIMIT ?')
      .all(limit)
      .map((row) =>
        AuditEvent.parse({
          auditId: text(row, 'audit_id'),
          eventType: text(row, 'event_type'),
          actor: json(row, 'actor_json'),
          capability: nullableText(row, 'capability'),
          target: nullableText(row, 'target'),
          decision: text(row, 'decision'),
          riskLevel: text(row, 'risk_level'),
          missionId: nullableText(row, 'mission_id'),
          executionId: nullableText(row, 'execution_id'),
          timestamp: text(row, 'timestamp'),
          metadataRedacted: json(row, 'metadata_json'),
          correlationId: text(row, 'correlation_id'),
          outcome: nullableText(row, 'outcome')
        })
      )
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM audit_log').get()
    return row ? integer(row, 'n') : 0
  }
}
