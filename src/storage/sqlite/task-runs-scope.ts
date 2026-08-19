import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * task_runs scope(ADR 24 §4.2):TaskRun/Attempt 事实账本。
 *
 * `task_runs` 行 = 原 task.jsonl header(task_run_id、work_dir、storage_root_id、
 * adapter_ 三列、input_hash、max_attempts、created_at)+ 水位(last_event_seq、
 * last_tx_id)+ revision(expectedRevision CAS)+ status 投影列(可由事件重放重建)。
 * `task_run_events` = 事件事实本体:payload_json 存完整 canonical JSON 对象,
 * kind/tx_id/committed_at 拆列做索引;task-runs/ 目录与 manifest.json 退役。
 */
export const TASK_RUNS_SCOPE_NAME = "task_runs";

export const TASK_RUNS_SCOPE: SqliteSchemaScope = {
  name: TASK_RUNS_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE task_runs (
        task_run_id TEXT PRIMARY KEY,
        work_dir TEXT NOT NULL,
        storage_root_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_version INTEGER NOT NULL,
        adapter_input_json TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_tx_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE task_run_events (
        event_id TEXT PRIMARY KEY,
        task_run_id TEXT NOT NULL REFERENCES task_runs(task_run_id) ON DELETE CASCADE,
        event_seq INTEGER NOT NULL CHECK (event_seq > 0),
        kind TEXT NOT NULL,
        tx_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE (task_run_id, event_seq)
      );
      CREATE INDEX task_run_events_by_kind ON task_run_events(task_run_id, kind, event_seq);
      `,
    ],
  ]),
};
