import type { DatabaseSync } from "node:sqlite";
import { withWorkspaceSqliteLease } from "./workspace-scopes.js";

/**
 * File History manifest 的 SQLite 行存取(票 08,ADR 24 §4.6 方案 a)。
 *
 * manifest v2(roots/trackedFiles/fileVersions + snapshots)拆进
 * `file_history`(低频 state_json)+ `file_history_snapshots`(每 rewind point
 * 一行,PK=(session_id, ordinal);before_session_seq 走普通索引——持久化关闭
 * 的会话允许多条快照共用同一 seq)。编码/校验仍由 safety/file-history.ts 的
 * manifest v2 解析器负责,本层只搬行,不含独家信息。
 *
 * 每个操作独立 prepare + 事务 + 归还 lease(见 withWorkspaceSqliteLease)。
 */

export interface FileHistorySnapshotRow {
  readonly ordinal: number;
  readonly beforeSessionSeq: number;
  readonly messageId: string;
  readonly sourceMessageEventId: string;
  readonly messageIndex: number;
  readonly userPrompt: string;
  readonly timestamp: string;
  readonly snapshotJson: string;
}

export interface FileHistoryManifestRow {
  readonly sessionId: string;
  readonly revision: number;
  readonly snapshotSequence: number;
  readonly stateJson: string;
  readonly updatedAt: string;
  readonly snapshots: readonly FileHistorySnapshotRow[];
}

/** 同事务 UPSERT 头行 + 快照行,并删除已不存在的 ordinal(整写变行更新)。 */
export function writeFileHistoryManifestRow(
  storageRoot: string,
  row: FileHistoryManifestRow,
): void {
  withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("write", () => writeManifestRowLocked(lease.database, row)),
  );
}

/**
 * 仅当头行不存在时写入整份 manifest(克隆发布的幂等栅栏)。
 * 返回 false 表示目标已存在,由调用方回读比对。
 */
export function insertFileHistoryManifestRowIfAbsent(
  storageRoot: string,
  row: FileHistoryManifestRow,
): boolean {
  return withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("write", () => {
      const header = lease.database
        .prepare("SELECT 1 AS present FROM file_history WHERE session_id = ?")
        .get(row.sessionId);
      if (header !== undefined) return false;
      writeManifestRowLocked(lease.database, row);
      return true;
    }),
  );
}

export function readFileHistoryManifestRow(
  storageRoot: string,
  sessionId: string,
): FileHistoryManifestRow | undefined {
  return withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("read", () => {
      const header = lease.database
        .prepare(
          `SELECT revision, snapshot_sequence, state_json, updated_at
           FROM file_history WHERE session_id = ?`,
        )
        .get(sessionId) as
        | {
            revision?: unknown;
            snapshot_sequence?: unknown;
            state_json?: unknown;
            updated_at?: unknown;
          }
        | undefined;
      if (header === undefined) return undefined;
      const snapshots = lease.database
        .prepare(
          `SELECT ordinal, before_session_seq, message_id, source_message_event_id,
                  message_index, user_prompt, timestamp, snapshot_json
           FROM file_history_snapshots WHERE session_id = ? ORDER BY ordinal`,
        )
        .all(sessionId) as Array<Record<string, unknown>>;
      return {
        sessionId,
        revision: numberOrThrow(header.revision, "file_history.revision"),
        snapshotSequence: numberOrThrow(header.snapshot_sequence, "file_history.snapshot_sequence"),
        stateJson: stringOrThrow(header.state_json, "file_history.state_json"),
        updatedAt: stringOrThrow(header.updated_at, "file_history.updated_at"),
        snapshots: snapshots.map((snapshot) => ({
          ordinal: numberOrThrow(snapshot["ordinal"], "file_history_snapshots.ordinal"),
          beforeSessionSeq: numberOrThrow(
            snapshot["before_session_seq"],
            "file_history_snapshots.before_session_seq",
          ),
          messageId: stringOrThrow(snapshot["message_id"], "file_history_snapshots.message_id"),
          sourceMessageEventId: stringOrThrow(
            snapshot["source_message_event_id"],
            "file_history_snapshots.source_message_event_id",
          ),
          messageIndex: numberOrThrow(
            snapshot["message_index"],
            "file_history_snapshots.message_index",
          ),
          userPrompt: stringOrThrow(snapshot["user_prompt"], "file_history_snapshots.user_prompt"),
          timestamp: stringOrThrow(snapshot["timestamp"], "file_history_snapshots.timestamp"),
          snapshotJson: stringOrThrow(
            snapshot["snapshot_json"],
            "file_history_snapshots.snapshot_json",
          ),
        })),
      } satisfies FileHistoryManifestRow;
    }),
  );
}

/** 仅用于已验证未发布 fork target 的 sidecar 补偿清理。 */
export function deleteFileHistoryManifestRow(storageRoot: string, sessionId: string): boolean {
  return withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("write", () => {
      lease.database
        .prepare("DELETE FROM file_history_snapshots WHERE session_id = ?")
        .run(sessionId);
      return (
        lease.database.prepare("DELETE FROM file_history WHERE session_id = ?").run(sessionId)
          .changes > 0
      );
    }),
  );
}

/** Doctor 扫描用:本 workspace 库内存在 manifest 行的 sessionId 全集。 */
export function listFileHistorySessionIds(storageRoot: string): string[] {
  return withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("read", () =>
      (
        lease.database
          .prepare("SELECT session_id FROM file_history ORDER BY session_id")
          .all() as Array<{ session_id: unknown }>
      )
        .map((row) => row.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    ),
  );
}

function writeManifestRowLocked(database: DatabaseSync, row: FileHistoryManifestRow): void {
  database
    .prepare(
      `INSERT INTO file_history (session_id, revision, snapshot_sequence, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         revision = excluded.revision,
         snapshot_sequence = excluded.snapshot_sequence,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    )
    .run(row.sessionId, row.revision, row.snapshotSequence, row.stateJson, row.updatedAt);
  const upsertSnapshot = database.prepare(
    `INSERT INTO file_history_snapshots
       (session_id, ordinal, before_session_seq, message_id, source_message_event_id,
        message_index, user_prompt, timestamp, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, ordinal) DO UPDATE SET
       before_session_seq = excluded.before_session_seq,
       message_id = excluded.message_id,
       source_message_event_id = excluded.source_message_event_id,
       message_index = excluded.message_index,
       user_prompt = excluded.user_prompt,
       timestamp = excluded.timestamp,
       snapshot_json = excluded.snapshot_json`,
  );
  for (const snapshot of row.snapshots) {
    upsertSnapshot.run(
      row.sessionId,
      snapshot.ordinal,
      snapshot.beforeSessionSeq,
      snapshot.messageId,
      snapshot.sourceMessageEventId,
      snapshot.messageIndex,
      snapshot.userPrompt,
      snapshot.timestamp,
      snapshot.snapshotJson,
    );
  }
  // 清理已被 MAX_SNAPSHOTS 移除/DiscardFrom 丢弃的 ordinal 行。
  database
    .prepare(
      `DELETE FROM file_history_snapshots
       WHERE session_id = ? AND ordinal >= ?`,
    )
    .run(row.sessionId, row.snapshots.length);
}

function numberOrThrow(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} is not a safe integer`);
  }
  return value;
}

function stringOrThrow(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  return value;
}
