import type { DatabaseSync } from 'node:sqlite'
import { ServiceHealth } from '@jupiter/contracts'
import type { ServiceHealthStore } from '@jupiter/core'
import { integer, json, nullableNumber, nullableText, text } from '../rows'

/** Latest known health of every service; the history lives in `service.status_changed` events. */
export class SqliteServiceHealthStore implements ServiceHealthStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(health: ServiceHealth, process: 'host' | 'core', at: string): void {
    this.db
      .prepare(
        `INSERT INTO service_health (
           service_id, process, status, version, last_check, latency_ms, capabilities_json, error_json,
           critical, retryable, planned_set, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (service_id) DO UPDATE SET
           process = excluded.process, status = excluded.status, version = excluded.version,
           last_check = excluded.last_check, latency_ms = excluded.latency_ms,
           capabilities_json = excluded.capabilities_json, error_json = excluded.error_json,
           critical = excluded.critical, retryable = excluded.retryable, planned_set = excluded.planned_set,
           updated_at = excluded.updated_at`
      )
      .run(
        health.serviceId,
        process,
        health.status,
        health.version,
        health.lastCheck,
        health.latency,
        JSON.stringify(health.capabilities),
        health.sanitizedError ? JSON.stringify(health.sanitizedError) : null,
        health.critical ? 1 : 0,
        health.retryable ? 1 : 0,
        health.plannedSet,
        at
      )
  }

  list(): (ServiceHealth & { process: 'host' | 'core' })[] {
    return this.db
      .prepare('SELECT * FROM service_health ORDER BY service_id')
      .all()
      .map((row) => {
        const errorJson = nullableText(row, 'error_json')
        const health = ServiceHealth.parse({
          serviceId: text(row, 'service_id'),
          status: text(row, 'status'),
          version: nullableText(row, 'version'),
          lastCheck: nullableText(row, 'last_check'),
          latency: nullableNumber(row, 'latency_ms'),
          capabilities: json(row, 'capabilities_json'),
          sanitizedError: errorJson === null ? null : (JSON.parse(errorJson) as unknown),
          critical: integer(row, 'critical') === 1,
          retryable: integer(row, 'retryable') === 1,
          plannedSet: nullableNumber(row, 'planned_set')
        })
        return {
          ...health,
          process: text(row, 'process') === 'host' ? ('host' as const) : ('core' as const)
        }
      })
  }
}
