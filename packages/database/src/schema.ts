import type { Migration } from './migrations'

/**
 * Jupiter's database schema, as an append-only list of migrations.
 *
 * NEVER edit a migration that has shipped: its checksum is recorded in every
 * database it touched, and a changed migration makes those databases refuse
 * to open. Add a new migration instead. Later SETs add their domain tables
 * here (Missions in SET 4, and so on).
 *
 * Events and audit records are append-only: triggers reject UPDATE and DELETE,
 * so history can only be removed by an explicit, reviewed migration.
 */
export const JUPITER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '0001_settings_and_events',
    sql: `
      CREATE TABLE settings (
        key         TEXT PRIMARY KEY NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
        value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at  TEXT NOT NULL,
        updated_by  TEXT NOT NULL CHECK (json_valid(updated_by))
      ) STRICT;

      CREATE TABLE event_streams (
        stream_kind    TEXT NOT NULL,
        stream_id      TEXT NOT NULL,
        last_sequence  INTEGER NOT NULL CHECK (last_sequence >= 1),
        created_at     TEXT NOT NULL,
        PRIMARY KEY (stream_kind, stream_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE events (
        global_sequence  INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id         TEXT NOT NULL UNIQUE,
        schema_version   INTEGER NOT NULL,
        type             TEXT NOT NULL,
        stream_kind      TEXT NOT NULL,
        stream_id        TEXT NOT NULL,
        stream_sequence  INTEGER NOT NULL CHECK (stream_sequence >= 1),
        occurred_at      TEXT NOT NULL,
        recorded_at      TEXT NOT NULL,
        correlation_id   TEXT NOT NULL,
        causation_id     TEXT,
        actor_json       TEXT NOT NULL CHECK (json_valid(actor_json)),
        mission_id       TEXT,
        execution_id     TEXT,
        payload_json     TEXT NOT NULL CHECK (json_valid(payload_json)),
        UNIQUE (stream_kind, stream_id, stream_sequence),
        FOREIGN KEY (stream_kind, stream_id) REFERENCES event_streams (stream_kind, stream_id) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX events_by_type ON events (type, global_sequence);
      CREATE INDEX events_by_mission ON events (mission_id, global_sequence) WHERE mission_id IS NOT NULL;

      CREATE TRIGGER events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `
  },
  {
    version: 2,
    name: '0002_audit_and_service_health',
    sql: `
      CREATE TABLE audit_log (
        sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id        TEXT NOT NULL UNIQUE,
        event_type      TEXT NOT NULL,
        actor_json      TEXT NOT NULL CHECK (json_valid(actor_json)),
        capability      TEXT,
        target          TEXT,
        decision        TEXT NOT NULL CHECK (decision IN ('ALLOWED', 'DENIED', 'REJECTED')),
        risk_level      TEXT NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        mission_id      TEXT,
        execution_id    TEXT,
        timestamp       TEXT NOT NULL,
        metadata_json   TEXT NOT NULL CHECK (json_valid(metadata_json)),
        correlation_id  TEXT NOT NULL,
        outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'))
      ) STRICT;

      CREATE INDEX audit_by_capability ON audit_log (capability, sequence);

      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'the audit log is append-only'); END;

      CREATE TABLE service_health (
        service_id         TEXT PRIMARY KEY NOT NULL,
        process            TEXT NOT NULL CHECK (process IN ('host', 'core')),
        status             TEXT NOT NULL,
        version            TEXT,
        last_check         TEXT,
        latency_ms         REAL,
        capabilities_json  TEXT NOT NULL CHECK (json_valid(capabilities_json)),
        error_json         TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        critical           INTEGER NOT NULL CHECK (critical IN (0, 1)),
        retryable          INTEGER NOT NULL CHECK (retryable IN (0, 1)),
        planned_set        INTEGER,
        updated_at         TEXT NOT NULL
      ) STRICT;
    `
  }
]
