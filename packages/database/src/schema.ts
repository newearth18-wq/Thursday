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
  },
  {
    version: 4,
    name: '0004_missions',
    sql: `
      -- Missions (SET 4). A Mission's status changes only through Core's state
      -- machine; every requested change, accepted or not, is kept in
      -- mission_transitions. Transitions, errors, verification results and
      -- artifacts are append-only, so no attempt is ever erased.
      CREATE TABLE missions (
        mission_id            TEXT PRIMARY KEY NOT NULL,
        title                 TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        user_request          TEXT NOT NULL CHECK (length(user_request) BETWEEN 1 AND 8000),
        priority              TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
        status                TEXT NOT NULL CHECK (status IN ('CREATED', 'ANALYZING', 'PLANNING', 'WAITING_APPROVAL', 'WAITING_IDENTITY', 'READY', 'RUNNING', 'PAUSED', 'VERIFYING', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')),
        pause_requested       INTEGER NOT NULL CHECK (pause_requested IN (0, 1)),
        archived_at           TEXT,
        plan_json             TEXT CHECK (plan_json IS NULL OR json_valid(plan_json)),
        current_execution_id  TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      ) STRICT;

      CREATE INDEX missions_by_update ON missions (archived_at, updated_at);

      CREATE TABLE mission_executions (
        execution_id  TEXT PRIMARY KEY NOT NULL,
        mission_id    TEXT NOT NULL REFERENCES missions (mission_id),
        attempt       INTEGER NOT NULL CHECK (attempt > 0),
        retry_of      TEXT REFERENCES mission_executions (execution_id),
        status        TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')),
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        UNIQUE (mission_id, attempt)
      ) STRICT;

      CREATE TABLE mission_steps (
        step_id       TEXT PRIMARY KEY NOT NULL,
        execution_id  TEXT NOT NULL REFERENCES mission_executions (execution_id),
        idx           INTEGER NOT NULL CHECK (idx >= 0),
        kind          TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
        title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        required      INTEGER NOT NULL CHECK (required IN (0, 1)),
        status        TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')),
        detail        TEXT,
        route_json    TEXT CHECK (route_json IS NULL OR json_valid(route_json)),
        error_json    TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        started_at    TEXT,
        completed_at  TEXT,
        UNIQUE (execution_id, idx)
      ) STRICT;

      CREATE TABLE mission_transitions (
        transition_id  TEXT PRIMARY KEY NOT NULL,
        mission_id     TEXT NOT NULL REFERENCES missions (mission_id),
        execution_id   TEXT REFERENCES mission_executions (execution_id),
        from_status    TEXT NOT NULL,
        to_status      TEXT NOT NULL,
        accepted       INTEGER NOT NULL CHECK (accepted IN (0, 1)),
        reason         TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
        actor_type     TEXT NOT NULL,
        at             TEXT NOT NULL
      ) STRICT;

      CREATE INDEX mission_transitions_by_mission ON mission_transitions (mission_id, at);

      CREATE TABLE mission_errors (
        error_id      TEXT PRIMARY KEY NOT NULL,
        mission_id    TEXT NOT NULL REFERENCES missions (mission_id),
        execution_id  TEXT REFERENCES mission_executions (execution_id),
        step_id       TEXT REFERENCES mission_steps (step_id),
        error_json    TEXT NOT NULL CHECK (json_valid(error_json)),
        at            TEXT NOT NULL
      ) STRICT;

      CREATE TABLE mission_verifications (
        verification_id  TEXT PRIMARY KEY NOT NULL,
        mission_id       TEXT NOT NULL REFERENCES missions (mission_id),
        execution_id     TEXT NOT NULL REFERENCES mission_executions (execution_id),
        step_id          TEXT REFERENCES mission_steps (step_id),
        check_name       TEXT NOT NULL CHECK (length(check_name) BETWEEN 1 AND 64),
        passed           INTEGER NOT NULL CHECK (passed IN (0, 1)),
        detail           TEXT NOT NULL CHECK (length(detail) <= 500),
        at               TEXT NOT NULL
      ) STRICT;

      CREATE TABLE mission_artifacts (
        artifact_id   TEXT PRIMARY KEY NOT NULL,
        mission_id    TEXT NOT NULL REFERENCES missions (mission_id),
        execution_id  TEXT NOT NULL REFERENCES mission_executions (execution_id),
        step_id       TEXT NOT NULL REFERENCES mission_steps (step_id),
        kind          TEXT NOT NULL CHECK (kind IN ('text')),
        title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        text          TEXT NOT NULL CHECK (length(text) <= 200000),
        created_at    TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER mission_transitions_no_update BEFORE UPDATE ON mission_transitions
        BEGIN SELECT RAISE(ABORT, 'mission transitions are append-only'); END;
      CREATE TRIGGER mission_transitions_no_delete BEFORE DELETE ON mission_transitions
        BEGIN SELECT RAISE(ABORT, 'mission transitions are append-only'); END;
      CREATE TRIGGER mission_errors_no_update BEFORE UPDATE ON mission_errors
        BEGIN SELECT RAISE(ABORT, 'mission errors are append-only'); END;
      CREATE TRIGGER mission_errors_no_delete BEFORE DELETE ON mission_errors
        BEGIN SELECT RAISE(ABORT, 'mission errors are append-only'); END;
      CREATE TRIGGER mission_verifications_no_update BEFORE UPDATE ON mission_verifications
        BEGIN SELECT RAISE(ABORT, 'verification results are append-only'); END;
      CREATE TRIGGER mission_verifications_no_delete BEFORE DELETE ON mission_verifications
        BEGIN SELECT RAISE(ABORT, 'verification results are append-only'); END;
      CREATE TRIGGER mission_artifacts_no_update BEFORE UPDATE ON mission_artifacts
        BEGIN SELECT RAISE(ABORT, 'mission artifacts are append-only'); END;
      CREATE TRIGGER mission_artifacts_no_delete BEFORE DELETE ON mission_artifacts
        BEGIN SELECT RAISE(ABORT, 'mission artifacts are append-only'); END;
    `
  },
  {
    version: 5,
    name: '0005_plans_and_workflows',
    // Rebuilds mission_executions and mission_steps (their status lists and new
    // columns), which other tables reference: foreign keys are off for this
    // migration and checked before it commits.
    rebuildsTables: true,
    sql: `
      -- Plan revisions (SET 5). A re-plan adds a revision; none is changed or removed.
      CREATE TABLE mission_plans (
        plan_id           TEXT PRIMARY KEY NOT NULL,
        mission_id        TEXT NOT NULL REFERENCES missions (mission_id),
        revision          INTEGER NOT NULL CHECK (revision > 0),
        previous_plan_id  TEXT REFERENCES mission_plans (plan_id),
        source            TEXT NOT NULL CHECK (source IN ('model', 'template')),
        reason            TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
        plan_json         TEXT NOT NULL CHECK (json_valid(plan_json)),
        created_at        TEXT NOT NULL,
        UNIQUE (mission_id, revision)
      ) STRICT;

      -- Model output that did not pass as a plan, with the reasons.
      CREATE TABLE mission_plan_rejections (
        rejection_id  TEXT PRIMARY KEY NOT NULL,
        mission_id    TEXT NOT NULL REFERENCES missions (mission_id),
        issues_json   TEXT NOT NULL CHECK (json_valid(issues_json)),
        at            TEXT NOT NULL
      ) STRICT;

      ALTER TABLE missions ADD COLUMN current_plan_id TEXT REFERENCES mission_plans (plan_id);

      CREATE TABLE mission_executions_v5 (
        execution_id  TEXT PRIMARY KEY NOT NULL,
        mission_id    TEXT NOT NULL REFERENCES missions (mission_id),
        attempt       INTEGER NOT NULL CHECK (attempt > 0),
        retry_of      TEXT REFERENCES mission_executions (execution_id),
        plan_id       TEXT REFERENCES mission_plans (plan_id),
        status        TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'WAITING', 'COMPLETED', 'PARTIAL_SUCCESS', 'FAILED', 'CANCELLED')),
        started_at    TEXT NOT NULL,
        ended_at      TEXT,
        UNIQUE (mission_id, attempt)
      ) STRICT;
      INSERT INTO mission_executions_v5 (execution_id, mission_id, attempt, retry_of, plan_id, status, started_at, ended_at)
        SELECT execution_id, mission_id, attempt, retry_of, NULL, status, started_at, ended_at FROM mission_executions;
      DROP TABLE mission_executions;
      ALTER TABLE mission_executions_v5 RENAME TO mission_executions;

      -- Workflow steps: SET 4's SUCCEEDED is SET 5's COMPLETED; SET 4 steps ran one after another.
      CREATE TABLE mission_steps_v5 (
        step_id             TEXT PRIMARY KEY NOT NULL,
        execution_id        TEXT NOT NULL REFERENCES mission_executions (execution_id),
        idx                 INTEGER NOT NULL CHECK (idx >= 0),
        step_key            TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND 32),
        kind                TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
        title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        description         TEXT NOT NULL CHECK (length(description) <= 500),
        required            INTEGER NOT NULL CHECK (required IN (0, 1)),
        status              TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'SKIPPED', 'CANCELLED')),
        detail              TEXT,
        route_json          TEXT CHECK (route_json IS NULL OR json_valid(route_json)),
        error_json          TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
        dependencies_json   TEXT NOT NULL CHECK (json_valid(dependencies_json)),
        input_json          TEXT NOT NULL CHECK (json_valid(input_json)),
        condition_json      TEXT CHECK (condition_json IS NULL OR json_valid(condition_json)),
        verification_json   TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
        timeout_ms          INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
        max_attempts        INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
        backoff_ms          INTEGER NOT NULL CHECK (backoff_ms >= 0),
        backoff_multiplier  REAL NOT NULL CHECK (backoff_multiplier >= 1),
        attempts            INTEGER NOT NULL CHECK (attempts >= 0),
        waiting_for         TEXT CHECK (waiting_for IS NULL OR waiting_for IN ('approval', 'identity')),
        started_at          TEXT,
        completed_at        TEXT,
        UNIQUE (execution_id, idx),
        UNIQUE (execution_id, step_key)
      ) STRICT;
      INSERT INTO mission_steps_v5 (step_id, execution_id, idx, step_key, kind, title, description, required, status,
          detail, route_json, error_json, dependencies_json, input_json, condition_json, verification_json, timeout_ms,
          max_attempts, backoff_ms, backoff_multiplier, attempts, waiting_for, started_at, completed_at)
        SELECT step_id, execution_id, idx, 'step-' || (idx + 1), kind, title, '', required,
          CASE status WHEN 'SUCCEEDED' THEN 'COMPLETED' ELSE status END,
          detail, route_json, error_json,
          CASE WHEN idx = 0 THEN '[]' ELSE json_array('step-' || idx) END, '{}', NULL, NULL, NULL,
          1, 0, 1, CASE WHEN started_at IS NULL THEN 0 ELSE 1 END, NULL, started_at, completed_at
        FROM mission_steps;
      DROP TABLE mission_steps;
      ALTER TABLE mission_steps_v5 RENAME TO mission_steps;

      -- Every attempt at a step, retries and interruptions included.
      CREATE TABLE mission_step_attempts (
        step_id     TEXT NOT NULL REFERENCES mission_steps (step_id),
        attempt     INTEGER NOT NULL CHECK (attempt > 0),
        outcome     TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'timed-out', 'cancelled', 'interrupted')),
        error_code  TEXT,
        started_at  TEXT NOT NULL,
        ended_at    TEXT NOT NULL,
        PRIMARY KEY (step_id, attempt)
      ) STRICT, WITHOUT ROWID;

      CREATE TRIGGER mission_plans_no_update BEFORE UPDATE ON mission_plans
        BEGIN SELECT RAISE(ABORT, 'plan revisions are append-only'); END;
      CREATE TRIGGER mission_plans_no_delete BEFORE DELETE ON mission_plans
        BEGIN SELECT RAISE(ABORT, 'plan revisions are append-only'); END;
      CREATE TRIGGER mission_plan_rejections_no_update BEFORE UPDATE ON mission_plan_rejections
        BEGIN SELECT RAISE(ABORT, 'plan rejections are append-only'); END;
      CREATE TRIGGER mission_plan_rejections_no_delete BEFORE DELETE ON mission_plan_rejections
        BEGIN SELECT RAISE(ABORT, 'plan rejections are append-only'); END;
      CREATE TRIGGER mission_step_attempts_no_update BEFORE UPDATE ON mission_step_attempts
        BEGIN SELECT RAISE(ABORT, 'step attempts are append-only'); END;
      CREATE TRIGGER mission_step_attempts_no_delete BEFORE DELETE ON mission_step_attempts
        BEGIN SELECT RAISE(ABORT, 'step attempts are append-only'); END;
    `
  },
  {
    version: 6,
    name: '0006_skills',
    sql: `
      -- Skills (SET 6). The code of a Skill ships with Jupiter; this keeps what
      -- is decided about it (enabled, last health check) and its definition as
      -- registered. A Skill that is no longer registered keeps its row, marked.
      CREATE TABLE skills (
        skill_id            TEXT NOT NULL CHECK (length(skill_id) BETWEEN 3 AND 64),
        version             TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 20),
        definition_json     TEXT NOT NULL CHECK (json_valid(definition_json)),
        enabled             INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        health_status       TEXT NOT NULL CHECK (health_status IN ('HEALTHY', 'UNHEALTHY', 'UNKNOWN')),
        health_detail       TEXT NOT NULL CHECK (length(health_detail) <= 500),
        health_checked_at   TEXT,
        health_duration_ms  INTEGER CHECK (health_duration_ms IS NULL OR health_duration_ms >= 0),
        registered_at       TEXT NOT NULL,
        unregistered_at     TEXT,
        PRIMARY KEY (skill_id, version)
      ) STRICT;

      -- Every invocation. Input and output are kept only as shape and size
      -- (never content), so no secret typed into a Skill is stored.
      CREATE TABLE skill_executions (
        execution_id         TEXT PRIMARY KEY NOT NULL,
        skill_id             TEXT NOT NULL,
        version              TEXT NOT NULL,
        mission_id           TEXT,
        actor_type           TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'WAITING_APPROVAL', 'WAITING_IDENTITY')),
        permissions_json     TEXT NOT NULL CHECK (json_valid(permissions_json)),
        input_summary_json   TEXT NOT NULL CHECK (json_valid(input_summary_json)),
        output_summary_json  TEXT CHECK (output_summary_json IS NULL OR json_valid(output_summary_json)),
        error_code           TEXT,
        idempotency_key      TEXT,
        started_at           TEXT NOT NULL,
        completed_at         TEXT,
        FOREIGN KEY (skill_id, version) REFERENCES skills (skill_id, version)
      ) STRICT;

      CREATE INDEX skill_executions_by_skill ON skill_executions (skill_id, started_at);
      CREATE UNIQUE INDEX skill_executions_idempotency
        ON skill_executions (skill_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    `
  },
  {
    version: 7,
    name: '0007_permissions',
    sql: `
      -- The Permission Engine (SET 7). Requests are what Jupiter asked; grants
      -- are the answers that allow something; the audit trail keeps every
      -- evaluation and decision (redacted), and cannot be changed.
      CREATE TABLE permission_requests (
        request_id    TEXT PRIMARY KEY NOT NULL,
        capability    TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('PENDING', 'ALLOWED', 'DENIED', 'EXPIRED')),
        decision      TEXT CHECK (decision IS NULL OR decision IN ('ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW', 'DENY')),
        mission_id    TEXT,
        session_id    TEXT NOT NULL,
        request_json  TEXT NOT NULL CHECK (json_valid(request_json)),
        created_at    TEXT NOT NULL,
        decided_at    TEXT
      ) STRICT;

      CREATE INDEX permission_requests_by_status ON permission_requests (status, created_at);

      CREATE TABLE permission_grants (
        grant_id      TEXT PRIMARY KEY NOT NULL,
        capability    TEXT NOT NULL,
        subject_kind  TEXT NOT NULL,
        subject_id    TEXT NOT NULL,
        subject_name  TEXT NOT NULL,
        target        TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 500),
        mission_id    TEXT,
        kind          TEXT NOT NULL CHECK (kind IN ('ALLOW_ONCE', 'ALLOW_SESSION', 'ALWAYS_ALLOW')),
        session_id    TEXT,
        state         TEXT NOT NULL CHECK (state IN ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED')),
        created_by    TEXT NOT NULL,
        request_id    TEXT REFERENCES permission_requests (request_id),
        reason        TEXT NOT NULL CHECK (length(reason) <= 300),
        created_at    TEXT NOT NULL,
        expires_at    TEXT,
        used_at       TEXT,
        ended_at      TEXT,
        CHECK (kind <> 'ALLOW_SESSION' OR session_id IS NOT NULL)
      ) STRICT;

      CREATE INDEX permission_grants_by_subject
        ON permission_grants (capability, subject_kind, subject_id, state);

      CREATE TABLE permission_audit (
        entry_id      TEXT PRIMARY KEY NOT NULL,
        at            TEXT NOT NULL,
        entry_json    TEXT NOT NULL CHECK (json_valid(entry_json))
      ) STRICT;

      CREATE INDEX permission_audit_by_time ON permission_audit (at);

      CREATE TRIGGER permission_audit_no_update BEFORE UPDATE ON permission_audit
        BEGIN SELECT RAISE(ABORT, 'the permission audit trail is append-only'); END;
      CREATE TRIGGER permission_audit_no_delete BEFORE DELETE ON permission_audit
        BEGIN SELECT RAISE(ABORT, 'the permission audit trail is append-only'); END;
    `
  },
  {
    version: 8,
    name: '0008_computer_tasks',
    sql: `
      -- The Windows Computer Agent (SET 8). One row per task: its actions (type
      -- and application only, never typed text), each action's observed result,
      -- and its final status.
      CREATE TABLE computer_tasks (
        task_id       TEXT PRIMARY KEY NOT NULL,
        mission_id    TEXT,
        status        TEXT NOT NULL
                        CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_APPROVAL')),
        task_json     TEXT NOT NULL CHECK (json_valid(task_json)),
        created_at    TEXT NOT NULL,
        completed_at  TEXT
      ) STRICT;

      CREATE INDEX computer_tasks_by_time ON computer_tasks (created_at);
    `
  }
]
