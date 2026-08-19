import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * attachments scope(ADR 24 §4.6,票 08):file-history + evidence 索引入库,
 * blob 本体留 FS(evidence `blobs/sha256/<xx>/<digest>`、file-history
 * `PICO_HOME/file-history/blobs/...` 目录结构均不变)。
 *
 * file-history 落点决策(方案 a):manifest 行进各 workspace 的 pico.sqlite。
 * sessionId 全局唯一且 session 归属单一 workspace,行随 workspace 库同生共死
 * ——workspace 根被删除时会话事实本身已失,rewind point 无独立消费者;blob 在
 * PICO_HOME 的孤儿化与旧 JSON manifest 纪元相同(无 GC 扫描,无回退路径)。
 *
 * 与 ADR §4.6 DDL 的差异:`file_history_snapshots` 主键是
 * `(session_id, ordinal)` 而非 `(session_id, before_session_seq)`——持久化
 * 关闭的 Session 每条 rewind point 的 beforeSessionSeq 恒为 0,快照数组语义
 * (有序、允许重复 seq)必须保持;rewind 查询走 `(session_id, before_session_seq)`
 * 普通索引。
 */

export const ATTACHMENTS_SCOPE_NAME = "attachments";

export const ATTACHMENTS_SCOPE: SqliteSchemaScope = {
  name: ATTACHMENTS_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE evidence_records (
        session_id TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        kind TEXT NOT NULL CHECK (kind IN ('tool-exchange','subagent-report')),
        archived_at TEXT NOT NULL,
        content_json TEXT NOT NULL,
        PRIMARY KEY (session_id, content_hash)
      );
      CREATE TABLE evidence_blobs (
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (digest)
      );
      CREATE TABLE file_history (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        snapshot_sequence INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE file_history_snapshots (
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        before_session_seq INTEGER NOT NULL,
        message_id TEXT NOT NULL, source_message_event_id TEXT NOT NULL,
        message_index INTEGER NOT NULL, user_prompt TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (session_id, ordinal)
      );
      CREATE INDEX file_history_snapshots_by_session_seq ON file_history_snapshots(session_id, before_session_seq);
      `,
    ],
  ]),
};
