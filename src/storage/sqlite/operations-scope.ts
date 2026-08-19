import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * operations scope(ADR 24 §4.5,票 08):fork/rewind Saga journal 单表化。
 *
 * 旧 `<storageRoot>/storage-operations/<operationId>.json` 整文件重写 →
 * `storage_operations` 单行 UPSERT;`operation_json` 保留完整操作记录(含
 * dispositions/error,canonical JSON),拆出的 kind/version/state/session_id/
 * target_session_id 是状态机 CAS 与未完成扫描的索引投影。状态机
 * (prepared→…→completed/aborted/needs_attention,CAS version)语义由
 * StorageOperationJournal 在写事务内逐条保持。
 */

export const OPERATIONS_SCOPE_NAME = "operations";

export const OPERATIONS_SCOPE: SqliteSchemaScope = {
  name: OPERATIONS_SCOPE_NAME,
  migrations: new Map<number, string>([
    [
      1,
      `
      CREATE TABLE storage_operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('rewind','fork')),
        version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared','workspace_applied','session_committed','sidecars_committed','completed','aborted','needs_attention')),
        session_id TEXT NOT NULL, target_session_id TEXT,
        operation_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX storage_operations_unfinished ON storage_operations(updated_at) WHERE state NOT IN ('completed','aborted');
      `,
    ],
  ]),
};
