import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * EventLog retention 的持久化 blob GC outbox。会话删除与 intent 入库在
 * 同一个 SQLite 写事务内完成；文件系统消费者在事务外删除 blob，
 * 再回写 completed/failed，避免 commit 后进程崩溃丢失回收任务。
 */

export const RETENTION_SCOPE_NAME = "retention";

export const RETENTION_SCOPE: SqliteSchemaScope = {
  name: RETENTION_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE retention_gc_intents (
        intent_id TEXT PRIMARY KEY,
        blob_kind TEXT NOT NULL CHECK (blob_kind IN ('evidence','file_history','runtime_asset')),
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending','failed','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE UNIQUE INDEX retention_gc_intents_open_blob
        ON retention_gc_intents(blob_kind, digest) WHERE completed_at IS NULL;
      CREATE INDEX retention_gc_intents_pending
        ON retention_gc_intents(status, updated_at) WHERE completed_at IS NULL;
      `,
    ],
  ]),
};
