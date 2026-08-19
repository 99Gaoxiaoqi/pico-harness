import type { SqliteSchemaScope } from "./sqlite-schema.js";

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
        credential_ref TEXT, model_route_id TEXT,
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
  ]),
};
