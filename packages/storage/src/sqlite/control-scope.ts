import type { SqliteSchemaScope } from "./sqlite-schema.js";
// Durable DDL scope owned by Storage.

/**
 * control scope(ADR 24 §4.3):RuntimeStore 三件套(state.json + daemon-events.jsonl +
 * usage-ledger.jsonl)→ 结构化表。旧"三文件联动原子性"由单 BEGIN IMMEDIATE 多表写取代;
 * revision / lastTransactionId / nextRuntimeEventSequence 住在 control_metadata。
 *
 * 与 ADR §4.3 DDL 的唯一差异:jobs 增加 `type` 列 —— JobRecord.type 是事实字段且
 * 参与中断补偿语义(interruptedCompletionPayload),ADR 清单遗漏了它,不补则记录无法
 * 完整往返。其余列与索引照抄 ADR,含部分索引与 CHECK。
 */

export const CONTROL_SCOPE_NAME = "control";

export const CONTROL_SCOPE: SqliteSchemaScope = {
  name: CONTROL_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE control_metadata (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      -- rows: revision / lastTransactionId / nextRuntimeEventSequence

      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','timed_out','cancelled','interrupted')),
        execution_class TEXT NOT NULL CHECK (execution_class IN ('host_bound','recoverable')),
        completion_policy TEXT NOT NULL CHECK (completion_policy IN ('required','optional','detached')),
        description TEXT NOT NULL,
        owner_session_id TEXT, child_session_id TEXT, tool_use_id TEXT, output_path TEXT,
        data_json TEXT, version INTEGER NOT NULL, lease_epoch INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        terminal_at INTEGER, error TEXT
      );
      CREATE INDEX jobs_by_status ON jobs(status, updated_at);

      CREATE TABLE job_attempts (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL, status TEXT NOT NULL, owner_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL, output_path TEXT, output_offset INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
        error TEXT, result_json TEXT, version INTEGER NOT NULL,
        UNIQUE (job_id, attempt_number)
      );

      CREATE TABLE runtime_leases (
        resource_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, version INTEGER NOT NULL
      );
      CREATE INDEX runtime_leases_by_expiry ON runtime_leases(expires_at);

      CREATE TABLE cron_jobs (
        cron_job_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, name TEXT NOT NULL,
        schedule TEXT NOT NULL, time_zone TEXT NOT NULL, prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL, policy_snapshot_json TEXT NOT NULL,
        credential_ref TEXT NOT NULL, model_route_id TEXT NOT NULL,
        version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE cron_runs (
        cron_run_id TEXT PRIMARY KEY,
        cron_job_id TEXT NOT NULL REFERENCES cron_jobs(cron_job_id) ON DELETE CASCADE,
        workspace_path TEXT NOT NULL, scheduled_for INTEGER NOT NULL,
        status TEXT NOT NULL, owner_id TEXT, lease_epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        reason TEXT, result_json TEXT, version INTEGER NOT NULL
      );
      CREATE INDEX cron_runs_by_job ON cron_runs(cron_job_id, scheduled_for DESC);

      CREATE TABLE daemon_commands (
        idempotency_key TEXT PRIMARY KEY, command_type TEXT NOT NULL,
        request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','completed')),
        result_json TEXT, resource_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE daemon_runs (
        run_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, session_id TEXT, checkpoint_id TEXT,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','pause_requested','paused','cancelling','succeeded','failed','cancelled')),
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
        error TEXT, result_json TEXT, version INTEGER NOT NULL
      );
      CREATE TABLE job_commands (
        command_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('cancel','message')),
        payload_json TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER
      );
      CREATE TABLE completion_outbox (
        completion_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT,
        policy TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT,
        created_at INTEGER NOT NULL, delivered_at INTEGER
      );
      CREATE INDEX completion_outbox_undelivered ON completion_outbox(created_at) WHERE delivered_at IS NULL;
      CREATE TABLE merge_requests (
        merge_request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_id TEXT,
        source_branch TEXT NOT NULL, source_worktree TEXT NOT NULL,
        target_branch TEXT NOT NULL, target_worktree TEXT NOT NULL, source_head TEXT,
        status TEXT NOT NULL, error TEXT, version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );

      -- 事实账本(原 daemon-events.jsonl)
      CREATE TABLE daemon_events (
        event_id TEXT PRIMARY KEY, tx_id TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE,
        topic TEXT NOT NULL, workspace_path TEXT, cron_job_id TEXT, cron_run_id TEXT,
        payload_json TEXT, created_at INTEGER NOT NULL
      );
      -- 事实账本(原 usage-ledger.jsonl)
      CREATE TABLE usage_provider_calls (
        call_id TEXT PRIMARY KEY, tx_id TEXT NOT NULL, session_id TEXT, conversation_id TEXT,
        goal_id TEXT, job_id TEXT, attempt_id TEXT,
        purpose TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, route TEXT,
        status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled')),
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        cost REAL NOT NULL, reported_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX usage_calls_by_session ON usage_provider_calls(session_id, created_at DESC);
      CREATE INDEX usage_calls_by_created ON usage_provider_calls(created_at DESC);
      CREATE TABLE usage_baselines (
        baseline_id TEXT PRIMARY KEY, session_id TEXT, goal_id TEXT,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        cost REAL NOT NULL, imported_at INTEGER NOT NULL, source_json TEXT
      );
      `,
    ],
    [
      2,
      `
      -- desktop conversation state(ADR 28):原 $PICO_HOME/desktop/conversation-state.json
      -- 三类状态收编。库按 workspace 分片,但 workspace_path 仍作为列保留:
      -- 同一分片内路径大小写变体各自成行,与旧 JSON 匹配语义一致。
      CREATE TABLE desktop_idempotency (
        workspace_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_path, idempotency_key)
      );
      CREATE INDEX desktop_idempotency_by_recency
        ON desktop_idempotency(created_at DESC);

      CREATE TABLE desktop_input_queue (
        queue_id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX desktop_input_queue_by_session
        ON desktop_input_queue(workspace_path, session_id, created_at, queue_id);

      CREATE TABLE desktop_first_send_claims (
        workspace_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_path, idempotency_key)
      );
      CREATE INDEX desktop_first_send_claims_by_recency
        ON desktop_first_send_claims(created_at DESC);
      `,
    ],
    [
      3,
      `
      CREATE TABLE desktop_rewind_claims (
        workspace_path TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_path, idempotency_key),
        UNIQUE (workspace_path, operation_id)
      );
      CREATE INDEX desktop_rewind_claims_by_target
        ON desktop_rewind_claims(target_session_id, created_at DESC);
      `,
    ],
    [
      4,
      `
      CREATE INDEX runtime_events_usage_started ON runtime_events(
        session_id, run_id, json_extract(payload_json, '$.data.providerCallId'), event_seq DESC
      ) WHERE kind = 'model.call.started';
      CREATE TABLE usage_accounting_versions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE usage_accounting_calls (provider_call_id TEXT PRIMARY KEY, source TEXT NOT NULL, coverage TEXT NOT NULL);
      CREATE TABLE usage_attempt_owners (owner_id TEXT PRIMARY KEY, process_id INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE usage_attempt_revisions (physical_attempt_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_hash TEXT NOT NULL, PRIMARY KEY(physical_attempt_id, revision));
      CREATE TABLE usage_deleted_sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE usage_physical_attempts (
        physical_attempt_id TEXT PRIMARY KEY, provider_call_id TEXT NOT NULL,
        session_id TEXT, goal_id TEXT, job_id TEXT, run_id TEXT,
        owner_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0), status TEXT NOT NULL CHECK(status IN ('prepared','observed','succeeded','failed','cancelled','interrupted')),
        created_at TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
      );
      CREATE INDEX usage_physical_by_call ON usage_physical_attempts(provider_call_id);
      CREATE INDEX usage_physical_by_session ON usage_physical_attempts(session_id, created_at);
      CREATE INDEX usage_physical_by_run ON usage_physical_attempts(run_id, created_at);
      CREATE TRIGGER usage_session_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM usage_accounting_versions WHERE session_id = OLD.session_id;
        INSERT OR IGNORE INTO usage_deleted_sessions(session_id) VALUES (OLD.session_id);
        UPDATE usage_physical_attempts SET session_id = NULL, run_id = NULL,
          record_json = json_remove(record_json, '$.sessionId', '$.conversationId', '$.runId', '$.turnId')
          WHERE session_id = OLD.session_id;
        UPDATE usage_provider_calls SET session_id = NULL, conversation_id = NULL WHERE session_id = OLD.session_id;
        UPDATE usage_baselines SET session_id = NULL WHERE session_id = OLD.session_id;
      END;
    `,
    ],
    [
      5,
      `
      CREATE INDEX IF NOT EXISTS runtime_events_usage_started ON runtime_events(
        session_id, run_id, json_extract(payload_json, '$.data.providerCallId'), event_seq DESC
      ) WHERE kind = 'model.call.started';
      CREATE TABLE usage_baseline_adjustments (
        baseline_id TEXT PRIMARY KEY, version INTEGER NOT NULL,
        input_tokens REAL NOT NULL, output_tokens REAL NOT NULL,
        cache_read_tokens REAL NOT NULL, cache_write_tokens REAL NOT NULL, cost REAL NOT NULL
      );
      CREATE TRIGGER usage_baseline_adjustment_version AFTER INSERT ON usage_baseline_adjustments BEGIN
        INSERT INTO usage_accounting_versions(session_id, revision)
          SELECT session_id, 1 FROM usage_baselines WHERE baseline_id = NEW.baseline_id AND session_id IS NOT NULL
          ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
      END;
      CREATE VIEW usage_effective_baselines AS SELECT
        b.baseline_id, b.session_id, b.goal_id,
        MAX(0, b.input_tokens - COALESCE(a.input_tokens, 0)) AS input_tokens,
        MAX(0, b.output_tokens - COALESCE(a.output_tokens, 0)) AS output_tokens,
        MAX(0, b.cache_read_tokens - COALESCE(a.cache_read_tokens, 0)) AS cache_read_tokens,
        MAX(0, b.cache_write_tokens - COALESCE(a.cache_write_tokens, 0)) AS cache_write_tokens,
        MAX(0, b.cost - COALESCE(a.cost, 0)) AS cost,
        b.imported_at, b.source_json, a.version AS reconciliation_version
      FROM usage_baselines b LEFT JOIN usage_baseline_adjustments a ON a.baseline_id = b.baseline_id;
    `,
    ],
    [
      6,
      `
      DROP TRIGGER IF EXISTS usage_baseline_reconcile;
      DROP TRIGGER usage_baseline_adjustment_version;
      DROP VIEW usage_effective_baselines;
      DROP TABLE usage_baseline_adjustments;
      DROP TRIGGER usage_session_deleted;
      DROP TABLE usage_baselines;
      DELETE FROM usage_physical_attempts
        WHERE COALESCE(json_extract(record_json, '$.accountingSource'), '') != 'physical';
      DELETE FROM usage_attempt_revisions WHERE physical_attempt_id NOT IN
        (SELECT physical_attempt_id FROM usage_physical_attempts);
      DELETE FROM usage_accounting_calls WHERE source != 'physical' OR provider_call_id NOT IN
        (SELECT provider_call_id FROM usage_physical_attempts);
      DELETE FROM usage_provider_calls WHERE call_id NOT IN
        (SELECT provider_call_id FROM usage_physical_attempts);
      CREATE TEMP TABLE native_usage_affected_sessions AS
        SELECT DISTINCT session_id FROM runtime_events WHERE kind IN ('model.call.started', 'model.call.settled')
        AND NOT EXISTS (SELECT 1 FROM usage_physical_attempts p
          WHERE p.provider_call_id = json_extract(runtime_events.payload_json, '$.data.providerCallId')
            AND p.session_id = runtime_events.session_id AND p.run_id = runtime_events.run_id);
      DELETE FROM runtime_events WHERE kind IN ('model.call.started', 'model.call.settled')
        AND NOT EXISTS (SELECT 1 FROM usage_physical_attempts p
          WHERE p.provider_call_id = json_extract(runtime_events.payload_json, '$.data.providerCallId')
            AND p.session_id = runtime_events.session_id AND p.run_id = runtime_events.run_id);
      UPDATE sessions SET
        last_event_seq = (SELECT COALESCE(MAX(event_seq), 0) FROM runtime_events e WHERE e.session_id = sessions.session_id),
        event_count = (SELECT COUNT(*) FROM runtime_events e WHERE e.session_id = sessions.session_id),
        storage_bytes = (SELECT COALESCE(SUM(length(payload_json)), 0) FROM runtime_events e WHERE e.session_id = sessions.session_id)
        WHERE session_id IN (SELECT session_id FROM native_usage_affected_sessions);
      UPDATE session_catalog_projection SET
        head_sequence = (SELECT last_event_seq FROM sessions s WHERE s.session_id = session_catalog_projection.session_id),
        event_count = (SELECT event_count FROM sessions s WHERE s.session_id = session_catalog_projection.session_id),
        storage_bytes = (SELECT storage_bytes FROM sessions s WHERE s.session_id = session_catalog_projection.session_id),
        fold_json = json_set(fold_json, '$.headSequence', (SELECT last_event_seq FROM sessions s WHERE s.session_id = session_catalog_projection.session_id))
        WHERE session_id IN (SELECT session_id FROM native_usage_affected_sessions);
      UPDATE runtime_transcript_projection_state SET
        history_epoch = lower(hex(randomblob(16))),
        through_sequence = (SELECT last_event_seq FROM sessions s WHERE s.session_id = runtime_transcript_projection_state.session_id),
        change_floor_sequence = (SELECT last_event_seq FROM sessions s WHERE s.session_id = runtime_transcript_projection_state.session_id)
        WHERE session_id IN (SELECT session_id FROM native_usage_affected_sessions);
      DELETE FROM runtime_transcript_changes WHERE session_id IN (SELECT session_id FROM native_usage_affected_sessions);
      DROP TABLE native_usage_affected_sessions;
      UPDATE usage_accounting_versions SET revision = revision + 1;
      UPDATE control_metadata SET value_json = CAST(CAST(value_json AS INTEGER) + 1 AS TEXT)
        WHERE key = 'revision';
      CREATE TRIGGER usage_session_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM usage_accounting_versions WHERE session_id = OLD.session_id;
        INSERT OR IGNORE INTO usage_deleted_sessions(session_id) VALUES (OLD.session_id);
        UPDATE usage_physical_attempts SET session_id = NULL, run_id = NULL,
          record_json = json_remove(record_json, '$.sessionId', '$.conversationId', '$.runId', '$.turnId')
          WHERE session_id = OLD.session_id;
        UPDATE usage_provider_calls SET session_id = NULL, conversation_id = NULL WHERE session_id = OLD.session_id;
      END;
    `,
    ],
  ]),
};
