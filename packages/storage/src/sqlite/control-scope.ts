import type { SqliteSchemaScope } from "./sqlite-schema.js";

export const CONTROL_SCOPE_NAME = "control";

// New databases install the current structure directly. Existing databases only
// run the remaining structural cleanup; obsolete ledgers are never read.
export const CONTROL_SCOPE: SqliteSchemaScope = {
  name: CONTROL_SCOPE_NAME,
  baseline: {
    version: 8,
    sql: `
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

      CREATE TABLE usage_accounting_versions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
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

      CREATE INDEX usage_latest_context_repair ON usage_physical_attempts(
        session_id, json_extract(record_json,'$.completedAt') DESC, physical_attempt_id DESC
      ) WHERE status='succeeded' AND json_extract(record_json,'$.purpose')='main'
        AND json_extract(record_json,'$.contextFacts.version')=1;

      CREATE TABLE session_latest_context (
        session_id TEXT PRIMARY KEY,
        physical_attempt_id TEXT NOT NULL REFERENCES usage_physical_attempts(physical_attempt_id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      );
      CREATE TRIGGER usage_session_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM usage_accounting_versions WHERE session_id = OLD.session_id;
        DELETE FROM session_latest_context WHERE session_id = OLD.session_id;
        INSERT OR IGNORE INTO usage_deleted_sessions(session_id) VALUES (OLD.session_id);
        UPDATE usage_physical_attempts SET session_id = NULL, run_id = NULL,
          record_json = json_remove(record_json, '$.sessionId', '$.conversationId', '$.runId', '$.turnId')
          WHERE session_id = OLD.session_id;
      END;
    `,
  },
  migrations: new Map<number, string>([
    [
      8,
      `
      CREATE TEMP TABLE context_upgrade_requires_empty_history (
        empty INTEGER CHECK(empty = 1)
      );
      INSERT INTO context_upgrade_requires_empty_history VALUES (
        (SELECT COUNT(*) = 0 FROM sessions) AND
        (SELECT COUNT(*) = 0 FROM usage_physical_attempts)
      );
      DROP TABLE context_upgrade_requires_empty_history;

      CREATE INDEX usage_latest_context_repair ON usage_physical_attempts(
        session_id, json_extract(record_json,'$.completedAt') DESC, physical_attempt_id DESC
      ) WHERE status='succeeded' AND json_extract(record_json,'$.purpose')='main'
        AND json_extract(record_json,'$.contextFacts.version')=1;

      CREATE TABLE session_latest_context (
        session_id TEXT PRIMARY KEY,
        physical_attempt_id TEXT NOT NULL REFERENCES usage_physical_attempts(physical_attempt_id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      );

      DROP TRIGGER usage_session_deleted;
      CREATE TRIGGER usage_session_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM usage_accounting_versions WHERE session_id = OLD.session_id;
        DELETE FROM session_latest_context WHERE session_id = OLD.session_id;
        INSERT OR IGNORE INTO usage_deleted_sessions(session_id) VALUES (OLD.session_id);
        UPDATE usage_physical_attempts SET session_id = NULL, run_id = NULL,
          record_json = json_remove(record_json, '$.sessionId', '$.conversationId', '$.runId', '$.turnId')
          WHERE session_id = OLD.session_id;
      END;
    `,
    ],
  ]),
};
