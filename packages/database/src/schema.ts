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
  },
  {
    version: 3,
    name: '0003_ai_providers_and_chat',
    sql: `
      -- AI providers the person configured. API keys are NOT stored here: the
      -- host keeps them in the operating system's secure storage under
      -- credential_id; this table only knows that a key exists and its
      -- non-secret fingerprint.
      CREATE TABLE ai_providers (
        provider_id              TEXT PRIMARY KEY NOT NULL,
        adapter_id               TEXT NOT NULL CHECK (length(adapter_id) BETWEEN 2 AND 40),
        display_name             TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
        base_url                 TEXT NOT NULL CHECK (length(base_url) BETWEEN 8 AND 512),
        enabled                  INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        check_state              TEXT NOT NULL CHECK (check_state IN ('not-checked', 'ready', 'failed')),
        error_json               TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        checked_at               TEXT,
        credential_id            TEXT UNIQUE,
        credential_fingerprint   TEXT CHECK (credential_fingerprint IS NULL OR length(credential_fingerprint) = 8),
        credential_saved_at      TEXT,
        credential_validation    TEXT NOT NULL CHECK (credential_validation IN ('not-validated', 'valid', 'rejected', 'unknown')),
        credential_validated_at  TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      ) STRICT;

      CREATE TABLE ai_models (
        provider_id             TEXT NOT NULL REFERENCES ai_providers (provider_id) ON DELETE CASCADE,
        model_id                TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 160),
        display_name            TEXT,
        capabilities_json       TEXT NOT NULL CHECK (json_valid(capabilities_json)),
        capability_source       TEXT NOT NULL CHECK (capability_source IN ('provider', 'user', 'none')),
        enabled                 INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        discovered              INTEGER NOT NULL CHECK (discovered IN (0, 1)),
        context_window          INTEGER,
        input_cost_per_million  REAL,
        output_cost_per_million REAL,
        observed_latency_ms     REAL,
        updated_at              TEXT NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE chat_conversations (
        conversation_id  TEXT PRIMARY KEY NOT NULL,
        title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        routing_mode     TEXT CHECK (routing_mode IS NULL OR routing_mode IN ('AUTO', 'CLOUD', 'HYBRID', 'LOCAL_ONLY')),
        routing_model    TEXT CHECK (routing_model IS NULL OR length(routing_model) <= 200),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      ) STRICT;

      CREATE TABLE chat_messages (
        message_id       TEXT PRIMARY KEY NOT NULL,
        conversation_id  TEXT NOT NULL REFERENCES chat_conversations (conversation_id) ON DELETE CASCADE,
        seq              INTEGER NOT NULL CHECK (seq > 0),
        role             TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        status           TEXT NOT NULL CHECK (status IN ('streaming', 'complete', 'cancelled', 'failed')),
        parts_json       TEXT NOT NULL CHECK (json_valid(parts_json)),
        route_json       TEXT CHECK (route_json IS NULL OR json_valid(route_json)),
        usage_json       TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
        finish_reason    TEXT,
        error_json       TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        superseded_by    TEXT,
        edited_from      TEXT,
        created_at       TEXT NOT NULL,
        completed_at     TEXT,
        UNIQUE (conversation_id, seq)
      ) STRICT;

      CREATE INDEX chat_messages_streaming ON chat_messages (status) WHERE status = 'streaming';
    `
  }
]
