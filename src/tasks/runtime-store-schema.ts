import type Database from "better-sqlite3";
import {
  CRON_RUN_STATUSES,
  DAEMON_RUN_STATUSES,
  JOB_COMPLETION_POLICIES,
  JOB_EXECUTION_CLASSES,
  JOB_STATUSES,
  MERGE_REQUEST_STATUSES,
  PROVIDER_CALL_PURPOSES,
  PROVIDER_CALL_STATUSES,
  RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
  RUNTIME_SCHEMA_VERSION,
} from "./runtime-types.js";

/** Owns the runtime.sqlite schema version and applies all migrations atomically. */
export function migrateRuntimeStoreSchema(db: Database.Database, now: () => number): void {
  const migrate = db.transaction(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    );
    normalizeDesktopPreviewMigration(db);
    const migrationRow = db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    const current = Number(migrationRow.version);
    if (current > RUNTIME_SCHEMA_VERSION) {
      throw new Error(
        `runtime.sqlite schema ${current} 新于当前支持版本 ${RUNTIME_SCHEMA_VERSION}`,
      );
    }
    if (current === RUNTIME_SCHEMA_VERSION) {
      const migration = db
        .prepare("SELECT name FROM schema_migrations WHERE version = ?")
        .get(RUNTIME_SCHEMA_VERSION) as { name: string } | undefined;
      if (migration?.name !== RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME) {
        throw new Error(
          `runtime.sqlite schema ${RUNTIME_SCHEMA_VERSION} migration ${migration?.name ?? "缺失"} 不受支持`,
        );
      }
    }
    applyMigration(db, now, current, 1, "runtime_control_plane", SCHEMA_V1);
    applyMigration(db, now, current, 2, "merge_not_needed_status", SCHEMA_V2);
    applyMigration(db, now, current, 3, "cron_job_run_ledger", SCHEMA_V3);
    applyMigration(db, now, current, 4, "cron_provider_credential_ref", SCHEMA_V4);
    applyMigration(db, now, current, 5, "provider_call_hook_purpose", SCHEMA_V5);
    applyMigration(db, now, current, 6, "daemon_run_projection_and_idempotency", SCHEMA_V6);
    applyMigration(db, now, current, 7, RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME, SCHEMA_V7);
    ensureCronJobDisplayNameColumn(db);
    ensureCronJobModelRouteColumn(db);
  });
  migrate();
}

function applyMigration(
  db: Database.Database,
  now: () => number,
  current: number,
  version: number,
  name: string,
  schema: string,
): void {
  if (current >= version) return;
  db.exec(schema);
  db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
    version,
    name,
    now(),
  );
}

function normalizeDesktopPreviewMigration(db: Database.Database): void {
  const previewMigration = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 6")
    .get() as { version: number; name: string } | undefined;
  const futureMigration = db
    .prepare("SELECT version FROM schema_migrations WHERE version > 6 ORDER BY version LIMIT 1")
    .get() as { version: number } | undefined;
  if (
    futureMigration ||
    previewMigration?.name !== "cron_job_display_name" ||
    !hasCronJobDisplayNameColumn(db)
  ) {
    return;
  }
  db.prepare("DELETE FROM schema_migrations WHERE version = 6 AND name = ?").run(
    "cron_job_display_name",
  );
}

function ensureCronJobDisplayNameColumn(db: Database.Database): void {
  if (hasCronJobDisplayNameColumn(db)) return;
  db.exec("ALTER TABLE cron_jobs ADD COLUMN name TEXT");
}

function ensureCronJobModelRouteColumn(db: Database.Database): void {
  if (hasCronJobModelRouteColumn(db)) return;
  db.exec("ALTER TABLE cron_jobs ADD COLUMN model_route_id TEXT");
}

function hasCronJobDisplayNameColumn(db: Database.Database): boolean {
  return (db.pragma("table_info(cron_jobs)") as Array<{ name: string }>).some(
    (column) => column.name === "name",
  );
}

function hasCronJobModelRouteColumn(db: Database.Database): boolean {
  return (db.pragma("table_info(cron_jobs)") as Array<{ name: string }>).some(
    (column) => column.name === "model_route_id",
  );
}

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

const SCHEMA_V1 = `
  CREATE TABLE runtime_leases (
    resource_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0)
  );

  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(JOB_STATUSES)})),
    execution_class TEXT NOT NULL CHECK (execution_class IN (${sqlValues(JOB_EXECUTION_CLASSES)})),
    completion_policy TEXT NOT NULL CHECK (completion_policy IN (${sqlValues(JOB_COMPLETION_POLICIES)})),
    description TEXT NOT NULL,
    owner_session_id TEXT,
    child_session_id TEXT,
    tool_use_id TEXT,
    output_path TEXT,
    data_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    terminal_at INTEGER,
    error TEXT
  );
  CREATE INDEX jobs_status_created_idx ON jobs(status, created_at);
  CREATE INDEX jobs_session_created_idx ON jobs(owner_session_id, created_at);

  CREATE TABLE job_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    status TEXT NOT NULL CHECK (status IN (${sqlValues(JOB_STATUSES)})),
    owner_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
    output_path TEXT,
    output_offset INTEGER NOT NULL CHECK (output_offset >= 0),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    result_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    UNIQUE(job_id, attempt_number)
  );
  CREATE INDEX job_attempts_job_idx ON job_attempts(job_id, attempt_number);

  CREATE TABLE job_commands (
    command_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('cancel', 'message')),
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX job_commands_pending_idx ON job_commands(job_id, delivered_at, created_at);

  CREATE TABLE completion_outbox (
    completion_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE CASCADE,
    policy TEXT NOT NULL CHECK (policy IN (${sqlValues(JOB_COMPLETION_POLICIES)})),
    status TEXT NOT NULL CHECK (status IN ('succeeded','partial','failed','timed_out','cancelled','interrupted')),
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE(attempt_id)
  );
  CREATE INDEX completion_outbox_pending_idx ON completion_outbox(delivered_at, created_at);

  CREATE TABLE merge_requests (
    merge_request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    source_branch TEXT NOT NULL,
    source_worktree TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    target_worktree TEXT NOT NULL,
    source_head TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(MERGE_REQUEST_STATUSES)})),
    error TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX merge_requests_job_idx ON merge_requests(job_id, created_at);

  CREATE TABLE provider_calls (
    call_id TEXT PRIMARY KEY,
    session_id TEXT,
    conversation_id TEXT,
    goal_id TEXT,
    job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (${sqlValues(PROVIDER_CALL_PURPOSES)})),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(PROVIDER_CALL_STATUSES)})),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost REAL NOT NULL CHECK (cost >= 0),
    reported_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX provider_calls_session_idx ON provider_calls(session_id, created_at);
  CREATE INDEX provider_calls_goal_idx ON provider_calls(goal_id, created_at);
  CREATE INDEX provider_calls_job_idx ON provider_calls(job_id, created_at);

  CREATE TABLE usage_baselines (
    baseline_id TEXT PRIMARY KEY,
    session_id TEXT,
    goal_id TEXT,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost REAL NOT NULL CHECK (cost >= 0),
    imported_at INTEGER NOT NULL,
    source_json TEXT
  );
`;

const SCHEMA_V2 = `
  ALTER TABLE merge_requests RENAME TO merge_requests_v1;
  CREATE TABLE merge_requests (
    merge_request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    source_branch TEXT NOT NULL,
    source_worktree TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    target_worktree TEXT NOT NULL,
    source_head TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(MERGE_REQUEST_STATUSES)})),
    error TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO merge_requests (
    merge_request_id, job_id, attempt_id, source_branch, source_worktree,
    target_branch, target_worktree, source_head, status, error, version, created_at, updated_at
  )
  SELECT
    merge_request_id, job_id, attempt_id, source_branch, source_worktree,
    target_branch, target_worktree, source_head, status, error, version, created_at, updated_at
  FROM merge_requests_v1;
  DROP TABLE merge_requests_v1;
  CREATE INDEX merge_requests_job_idx ON merge_requests(job_id, created_at);
`;

const SCHEMA_V3 = `
  CREATE TABLE cron_jobs (
    cron_job_id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    schedule TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    policy_snapshot_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX cron_jobs_workspace_enabled_idx ON cron_jobs(workspace_path, enabled, created_at);

  CREATE TABLE cron_runs (
    cron_run_id TEXT PRIMARY KEY,
    cron_job_id TEXT NOT NULL REFERENCES cron_jobs(cron_job_id) ON DELETE CASCADE,
    workspace_path TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(CRON_RUN_STATUSES)})),
    owner_id TEXT,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    reason TEXT,
    result_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    UNIQUE(cron_job_id, scheduled_for)
  );
  CREATE INDEX cron_runs_job_scheduled_idx ON cron_runs(cron_job_id, scheduled_for DESC);
  CREATE INDEX cron_runs_workspace_status_idx ON cron_runs(workspace_path, status, scheduled_for);

  CREATE TABLE runtime_events (
    event_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    cron_job_id TEXT REFERENCES cron_jobs(cron_job_id) ON DELETE SET NULL,
    cron_run_id TEXT REFERENCES cron_runs(cron_run_id) ON DELETE SET NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX runtime_events_workspace_cursor_idx ON runtime_events(workspace_path, created_at, event_id);
`;

const SCHEMA_V4 = `
  ALTER TABLE cron_jobs ADD COLUMN credential_ref TEXT;
`;

/** SQLite 无法原地修改 CHECK，使用事务内表替换扩展 provider purpose。 */
const SCHEMA_V5 = `
  DROP INDEX IF EXISTS provider_calls_session_idx;
  DROP INDEX IF EXISTS provider_calls_goal_idx;
  DROP INDEX IF EXISTS provider_calls_job_idx;
  ALTER TABLE provider_calls RENAME TO provider_calls_v4;
  CREATE TABLE provider_calls (
    call_id TEXT PRIMARY KEY,
    session_id TEXT,
    conversation_id TEXT,
    goal_id TEXT,
    job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (${sqlValues(PROVIDER_CALL_PURPOSES)})),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(PROVIDER_CALL_STATUSES)})),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost REAL NOT NULL CHECK (cost >= 0),
    reported_json TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO provider_calls (
    call_id, session_id, conversation_id, goal_id, job_id, attempt_id, purpose,
    provider, model, route, status, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, cost, reported_json, created_at
  )
  SELECT
    call_id, session_id, conversation_id, goal_id, job_id, attempt_id, purpose,
    provider, model, route, status, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, cost, reported_json, created_at
  FROM provider_calls_v4;
  DROP TABLE provider_calls_v4;
  CREATE INDEX provider_calls_session_idx ON provider_calls(session_id, created_at);
  CREATE INDEX provider_calls_goal_idx ON provider_calls(goal_id, created_at);
  CREATE INDEX provider_calls_job_idx ON provider_calls(job_id, created_at);
`;

const SCHEMA_V6 = `
  CREATE TABLE IF NOT EXISTS daemon_runs (
    run_id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    session_id TEXT,
    checkpoint_id TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(DAEMON_RUN_STATUSES)})),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    result_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0)
  );
  CREATE INDEX IF NOT EXISTS daemon_runs_workspace_started_idx
    ON daemon_runs(workspace_path, started_at, run_id);
  CREATE INDEX IF NOT EXISTS daemon_runs_workspace_session_idx
    ON daemon_runs(workspace_path, session_id, started_at);

  CREATE TABLE IF NOT EXISTS daemon_commands (
    command_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
    result_json TEXT,
    resource_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(command_type, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS daemon_commands_resource_idx
    ON daemon_commands(command_type, resource_id);
`;

/**
 * Memory review is a distinct provider purpose. Queue authority remains in workspace
 * memory.sqlite.memory_jobs; runtime.sqlite stores cost/audit semantics only.
 */
const SCHEMA_V7 = `
  DROP INDEX IF EXISTS provider_calls_session_idx;
  DROP INDEX IF EXISTS provider_calls_goal_idx;
  DROP INDEX IF EXISTS provider_calls_job_idx;
  ALTER TABLE provider_calls RENAME TO provider_calls_v6;
  CREATE TABLE provider_calls (
    call_id TEXT PRIMARY KEY,
    session_id TEXT,
    conversation_id TEXT,
    goal_id TEXT,
    job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (${sqlValues(PROVIDER_CALL_PURPOSES)})),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(PROVIDER_CALL_STATUSES)})),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost REAL NOT NULL CHECK (cost >= 0),
    reported_json TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO provider_calls (
    call_id, session_id, conversation_id, goal_id, job_id, attempt_id, purpose,
    provider, model, route, status, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, cost, reported_json, created_at
  )
  SELECT
    call_id, session_id, conversation_id, goal_id, job_id, attempt_id, purpose,
    provider, model, route, status, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, cost, reported_json, created_at
  FROM provider_calls_v6;
  DROP TABLE provider_calls_v6;
  CREATE INDEX provider_calls_session_idx ON provider_calls(session_id, created_at);
  CREATE INDEX provider_calls_goal_idx ON provider_calls(goal_id, created_at);
  CREATE INDEX provider_calls_job_idx ON provider_calls(job_id, created_at);
`;
