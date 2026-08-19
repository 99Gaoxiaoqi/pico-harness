import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * scope `sessions`(ADR 24 §4.1):事件事实表 runtime_events + 会话表 sessions。
 *
 * runtime_events 信封列照 RuntimeEventBase 全量拆出;payload_json 存完整事件
 * 对象 canonical JSON(键排序 stringify),decode 走既有 decodeRuntimeEvent。
 * tool_call_id / provider_call_id / operation_id 是索引投影列,仅服务于点查
 * 与 plan/graph CAS,不含独家信息。event_seq 分配 = 写事务内
 * COALESCE(MAX(event_seq),0)+1(BEGIN IMMEDIATE 保证独占)。
 *
 * sessions 吸收旧 JSONL 纪元的 header + manifest 水位投影:
 * last_event_seq / last_tx_id / event_count / storage_bytes / last_event_at 由
 * append 事务维护;fork_parent_session_id 由 session.forked 事件同事务维护
 * (目标冲突 fail-closed)。archived_at / pinned_at 承接原 desktop session-state
 * (票 03 并入,epoch 毫秒)。
 *
 * migration 2(票 03,ADR 24 §4.1 + 决策 25 第 3 条):catalog 投影表与消息表。
 * - `session_catalog_projection`:maka 双轨——is_archived/is_pinned/
 *   fork_parent_session_id/activity_at 是 sessions 结构列,由 AFTER UPDATE 触发器
 *   维护;title/first/last preview/message_count/fold_json 由 append 事务应用层
 *   增量维护(复用 engine/session-summary.ts 折叠器,禁止另写口径)。行内持久化
 *   SessionSummaryFold(schemaVersion 2 口径)+ 水位副本(head_sequence/event_count/
 *   storage_bytes),失配即全量重建(可丢弃派生)。is_published 只是事件侧判定
 *   (!hasForkFacts || completedBootstrap)的物化;journal 侧部分读时补查。
 * - `session_messages`:message.committed / tool.result.recorded(visibility=model
 *   且非 partial)的同事务物化;payload_json 为投影 Message canonical JSON,
 *   可从事件全量重建,启动恢复直读本表。
 */

export const SESSIONS_SCOPE_NAME = "sessions";

export const SESSIONS_SCOPE: SqliteSchemaScope = {
  name: SESSIONS_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_tx_id TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        fork_parent_session_id TEXT,
        archived_at INTEGER,
        pinned_at INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runtime_events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        invocation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL CHECK (event_seq > 0),
        kind TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('model','transcript','internal')),
        partial INTEGER NOT NULL CHECK (partial IN (0,1)),
        tx_id TEXT NOT NULL,
        tool_call_id TEXT,
        provider_call_id TEXT,
        operation_id TEXT,
        payload_json TEXT NOT NULL,
        at TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE (session_id, event_seq)
      );

      CREATE INDEX runtime_events_by_run ON runtime_events(session_id, run_id, event_seq);
      CREATE INDEX runtime_events_by_kind ON runtime_events(session_id, kind, event_seq);
      CREATE INDEX runtime_events_by_tool_call ON runtime_events(tool_call_id) WHERE tool_call_id IS NOT NULL;
      CREATE INDEX runtime_events_by_operation ON runtime_events(session_id, operation_id) WHERE operation_id IS NOT NULL;
      `,
    ],
    [
      2,
      `
      ALTER TABLE sessions ADD COLUMN last_event_at TEXT;

      CREATE TABLE session_catalog_projection (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        work_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activity_at TEXT NOT NULL,
        title TEXT,
        first_message TEXT,
        last_message TEXT,
        last_message_preview TEXT CHECK (last_message_preview IS NULL OR length(last_message_preview) <= 96),
        message_count INTEGER NOT NULL DEFAULT 0,
        fork_parent_session_id TEXT,
        fork_event_id TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
        is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
        is_published INTEGER NOT NULL DEFAULT 0,
        head_sequence INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        storage_bytes INTEGER NOT NULL DEFAULT 0,
        fold_json TEXT NOT NULL
      );
      CREATE INDEX catalog_by_activity ON session_catalog_projection(activity_at DESC, session_id ASC);
      CREATE INDEX catalog_by_archived_activity ON session_catalog_projection(is_archived, activity_at DESC, session_id ASC);
      CREATE INDEX catalog_by_pinned_activity ON session_catalog_projection(is_pinned, is_archived, activity_at DESC, session_id ASC);

      CREATE TABLE session_messages (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
        message_ts TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX session_messages_by_message_id ON session_messages(session_id, message_id);
      CREATE INDEX session_messages_by_ts ON session_messages(session_id, message_ts, sequence);

      CREATE TRIGGER session_catalog_projection_after_update
      AFTER UPDATE OF archived_at, pinned_at, fork_parent_session_id, last_event_at, created_at ON sessions
      BEGIN
        UPDATE session_catalog_projection
        SET is_archived = NEW.archived_at IS NOT NULL,
            is_pinned = NEW.pinned_at IS NOT NULL,
            fork_parent_session_id = NEW.fork_parent_session_id,
            activity_at = COALESCE(NEW.last_event_at, NEW.created_at)
        WHERE session_id = OLD.session_id;
      END;
      `,
    ],
  ]),
};
