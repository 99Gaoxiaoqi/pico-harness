import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, RuntimeUserInput } from "@pico/protocol";
import { resolvePicoHome, resolvePicoPaths } from "./pico-paths.js";
import {
  FIRST_SEND_CLAIM_RETENTION_MS,
  MAX_FIRST_SEND_CLAIMS,
  MAX_IDEMPOTENCY_RECORDS,
  normalizeWorkspacePath,
  parseDesktopQueuedInputRecord,
  requireNonEmpty,
  type DesktopConversationStateStoreLike,
  type DesktopFirstSendClaim,
  type DesktopRewindClaim,
  type DesktopIdempotencyRecord,
  type DesktopQueuedInput,
} from "./desktop-conversation-state.js";
import { withWorkspaceSqliteLease, type OperationalDatabaseLease } from "@pico/storage";

/**
 * desktop conversation state 的 SQLite 实现(ADR 28)。每次 store 调用独立持有
 * workspace lease，写路径用 BEGIN IMMEDIATE 事务避免半写窗口。
 */

export interface SqliteDesktopConversationStateStoreOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly picoHome?: string;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

export class SqliteDesktopConversationStateStore implements DesktopConversationStateStoreLike {
  private readonly picoHome: string;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(options: SqliteDesktopConversationStateStoreOptions = {}) {
    this.picoHome = resolvePicoHome({
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.picoHome !== undefined ? { picoHome: options.picoHome } : {}),
    });
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => `queued_${randomUUID()}`);
  }

  async listWorkspaceQueued(workspacePath: string): Promise<DesktopQueuedInput[]> {
    const canonical = normalizeWorkspacePath(workspacePath);
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("read", () => {
        const rows = lease.database
          .prepare(
            `SELECT queue_id, workspace_path, session_id, input_json, created_at
             FROM (
               SELECT queue_id, workspace_path, session_id, input_json, created_at,
                      ROW_NUMBER() OVER (
                        PARTITION BY session_id ORDER BY queue_order ASC, queue_id ASC
                      ) AS session_position
               FROM desktop_input_queue
               WHERE workspace_path = ?
             )
             WHERE session_position = 1
             ORDER BY created_at ASC, queue_id ASC`,
          )
          .all(canonical) as unknown[];
        return rows.map((row) => queueRowToQueuedInput(row as Record<string, unknown>));
      }),
    );
  }

  async listQueued(workspacePath: string, sessionId: string): Promise<DesktopQueuedInput[]> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("read", () => {
        const rows = lease.database
          .prepare(
            `SELECT queue_id, workspace_path, session_id, input_json, created_at
             FROM desktop_input_queue
             WHERE workspace_path = ? AND session_id = ?
             ORDER BY queue_order ASC, queue_id ASC`,
          )
          .all(canonical, normalizedSessionId) as unknown[];
        return rows.map((row) => queueRowToQueuedInput(row as Record<string, unknown>));
      }),
    );
  }

  async enqueue(
    workspacePath: string,
    sessionId: string,
    input: RuntimeUserInput,
  ): Promise<DesktopQueuedInput> {
    const queued: DesktopQueuedInput = {
      queueId: this.generateId(),
      workspacePath: normalizeWorkspacePath(workspacePath),
      sessionId: requireNonEmpty(sessionId, "sessionId"),
      input,
      createdAt: this.now(),
    };
    this.withWorkspace(queued.workspacePath, (lease) =>
      lease.transaction("write", () => {
        const row = lease.database
          .prepare(
            `SELECT COALESCE(MAX(queue_order), -1) AS max_order
             FROM desktop_input_queue
             WHERE workspace_path = ? AND session_id = ?`,
          )
          .get(queued.workspacePath, queued.sessionId) as Record<string, unknown>;
        const queueOrder = requireRowNumber(row, "max_order") + 1;
        lease.database
          .prepare(
            `INSERT INTO desktop_input_queue
             (queue_id, workspace_path, session_id, input_json, created_at, queue_order)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            queued.queueId,
            queued.workspacePath,
            queued.sessionId,
            JSON.stringify(queued.input),
            queued.createdAt,
            queueOrder,
          );
      }),
    );
    return queued;
  }

  async removeQueued(workspacePath: string, queueId: string): Promise<void> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalized = requireNonEmpty(queueId, "queueId");
    this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(`DELETE FROM desktop_input_queue WHERE workspace_path = ? AND queue_id = ?`)
          .run(canonical, normalized);
      }),
    );
  }

  async updateQueued(
    workspacePath: string,
    sessionId: string,
    queueId: string,
    input: RuntimeUserInput,
  ): Promise<DesktopQueuedInput | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedQueueId = requireNonEmpty(queueId, "queueId");
    const canonicalInput = parseDesktopQueuedInputRecord(input);
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        const result = lease.database
          .prepare(
            `UPDATE desktop_input_queue SET input_json = ?
             WHERE workspace_path = ? AND session_id = ? AND queue_id = ?`,
          )
          .run(JSON.stringify(canonicalInput), canonical, normalizedSessionId, normalizedQueueId);
        if (Number(result.changes) === 0) return undefined;
        const row = lease.database
          .prepare(
            `SELECT queue_id, workspace_path, session_id, input_json, created_at
             FROM desktop_input_queue
             WHERE workspace_path = ? AND session_id = ? AND queue_id = ?`,
          )
          .get(canonical, normalizedSessionId, normalizedQueueId) as
          | Record<string, unknown>
          | undefined;
        return row ? queueRowToQueuedInput(row) : undefined;
      }),
    );
  }

  async removeQueuedForSession(
    workspacePath: string,
    sessionId: string,
    queueId: string,
  ): Promise<boolean> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedQueueId = requireNonEmpty(queueId, "queueId");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        const result = lease.database
          .prepare(
            `DELETE FROM desktop_input_queue
             WHERE workspace_path = ? AND session_id = ? AND queue_id = ?`,
          )
          .run(canonical, normalizedSessionId, normalizedQueueId);
        return Number(result.changes) > 0;
      }),
    );
  }

  async reorderQueued(
    workspacePath: string,
    sessionId: string,
    queueIds: readonly string[],
  ): Promise<DesktopQueuedInput[] | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedQueueIds = queueIds.map((queueId) => requireNonEmpty(queueId, "queueId"));
    if (new Set(normalizedQueueIds).size !== normalizedQueueIds.length) {
      throw new Error("queueIds must not contain duplicates");
    }
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        const currentRows = lease.database
          .prepare(
            `SELECT queue_id FROM desktop_input_queue
             WHERE workspace_path = ? AND session_id = ?
             ORDER BY queue_order ASC, queue_id ASC`,
          )
          .all(canonical, normalizedSessionId) as Array<Record<string, unknown>>;
        const currentIds = currentRows.map((row) => requireRowString(row, "queue_id"));
        if (
          currentIds.length !== normalizedQueueIds.length ||
          currentIds.some((queueId) => !normalizedQueueIds.includes(queueId))
        ) {
          return undefined;
        }
        const updateOrder = lease.database.prepare(
          `UPDATE desktop_input_queue SET queue_order = ?
           WHERE workspace_path = ? AND session_id = ? AND queue_id = ?`,
        );
        normalizedQueueIds.forEach((queueId, index) =>
          updateOrder.run(index, canonical, normalizedSessionId, queueId),
        );
        return selectQueuedInputs(lease.database, canonical, normalizedSessionId);
      }),
    );
  }

  async moveQueuedToNext(
    workspacePath: string,
    sessionId: string,
    queueId: string,
  ): Promise<DesktopQueuedInput[] | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedQueueId = requireNonEmpty(queueId, "queueId");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        const current = selectQueuedInputs(lease.database, canonical, normalizedSessionId);
        const index = current.findIndex((queued) => queued.queueId === normalizedQueueId);
        if (index < 0) return undefined;
        if (index === 0) return current;
        const reordered = [
          current[index]!,
          ...current.slice(0, index),
          ...current.slice(index + 1),
        ];
        const updateOrder = lease.database.prepare(
          `UPDATE desktop_input_queue SET queue_order = ?
           WHERE workspace_path = ? AND session_id = ? AND queue_id = ?`,
        );
        reordered.forEach((queued, order) =>
          updateOrder.run(order, canonical, normalizedSessionId, queued.queueId),
        );
        return selectQueuedInputs(lease.database, canonical, normalizedSessionId);
      }),
    );
  }

  async clearQueued(workspacePath: string, sessionId: string): Promise<void> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(`DELETE FROM desktop_input_queue WHERE workspace_path = ? AND session_id = ?`)
          .run(canonical, normalizedSessionId);
      }),
    );
  }

  async getIdempotent(
    workspacePath: string,
    key: string,
  ): Promise<Pick<DesktopIdempotencyRecord, "requestFingerprint" | "result"> | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalized = requireNonEmpty(key, "idempotencyKey");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("read", () => {
        const row = lease.database
          .prepare(
            `SELECT request_fingerprint, result_json FROM desktop_idempotency
             WHERE workspace_path = ? AND idempotency_key = ?`,
          )
          .get(canonical, normalized) as Record<string, unknown> | undefined;
        if (!row) return undefined;
        return {
          requestFingerprint: requireRowString(row, "request_fingerprint"),
          result: parseRowJsonObject(row, "result_json"),
        };
      }),
    );
  }

  async getFirstSendClaim(
    workspacePath: string,
    key: string,
  ): Promise<DesktopFirstSendClaim | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalized = requireNonEmpty(key, "idempotencyKey");
    return this.withWorkspace(canonical, (lease) => {
      const row = lease.transaction("read", () =>
        selectClaimRow(lease.database, canonical, normalized),
      );
      if (!row) return undefined;
      if (row.createdAt >= this.now() - FIRST_SEND_CLAIM_RETENTION_MS) {
        return row;
      }
      // 过期 claim:与 JSON 实现一致,读路径顺带清理后视为不存在。
      lease.transaction("write", () => pruneFirstSendClaims(lease.database, this.now()));
      return undefined;
    });
  }

  async claimFirstSend(
    workspacePath: string,
    key: string,
    sessionId: string,
    requestFingerprint: string,
  ): Promise<DesktopFirstSendClaim> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedKey = requireNonEmpty(key, "idempotencyKey");
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    const normalizedFingerprint = requireNonEmpty(requestFingerprint, "requestFingerprint");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        const now = this.now();
        pruneFirstSendClaims(lease.database, now);
        const existing = selectClaimRow(lease.database, canonical, normalizedKey);
        if (existing) return existing;
        const claim: DesktopFirstSendClaim = {
          workspacePath: canonical,
          key: normalizedKey,
          sessionId: normalizedSessionId,
          requestFingerprint: normalizedFingerprint,
          createdAt: now,
        };
        insertClaimRow(lease.database, claim);
        return claim;
      }),
    );
  }

  async getRewindClaim(
    workspacePath: string,
    key: string,
  ): Promise<DesktopRewindClaim | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedKey = requireNonEmpty(key, "idempotencyKey");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("read", () =>
        selectRewindClaimRow(lease.database, canonical, normalizedKey),
      ),
    );
  }

  async claimRewind(
    workspacePath: string,
    key: string,
    sourceSessionId: string,
    targetSessionId: string,
    operationId: string,
    requestFingerprint: string,
  ): Promise<DesktopRewindClaim> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedKey = requireNonEmpty(key, "idempotencyKey");
    const claim: DesktopRewindClaim = {
      workspacePath: canonical,
      key: normalizedKey,
      sourceSessionId: requireNonEmpty(sourceSessionId, "sourceSessionId"),
      targetSessionId: requireNonEmpty(targetSessionId, "targetSessionId"),
      operationId: requireNonEmpty(operationId, "operationId"),
      requestFingerprint: requireNonEmpty(requestFingerprint, "requestFingerprint"),
      createdAt: this.now(),
    };
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        const existing = selectRewindClaimRow(lease.database, canonical, normalizedKey);
        if (existing) return existing;
        lease.database
          .prepare(
            `INSERT INTO desktop_rewind_claims
             (workspace_path, idempotency_key, source_session_id, target_session_id,
              operation_id, request_fingerprint, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            claim.workspacePath,
            claim.key,
            claim.sourceSessionId,
            claim.targetSessionId,
            claim.operationId,
            claim.requestFingerprint,
            claim.createdAt,
          );
        return claim;
      }),
    );
  }

  async rememberIdempotent(
    workspacePath: string,
    key: string,
    requestFingerprint: string,
    result: JsonObject,
  ): Promise<void> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalized = requireNonEmpty(key, "idempotencyKey");
    this.withWorkspace(canonical, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `DELETE FROM desktop_first_send_claims
             WHERE workspace_path = ? AND idempotency_key = ?`,
          )
          .run(canonical, normalized);
        lease.database
          .prepare(
            `DELETE FROM desktop_rewind_claims
             WHERE workspace_path = ? AND idempotency_key = ?`,
          )
          .run(canonical, normalized);
        // 序列化失败(如 BigInt)发生在首条语句之后:整事务回滚,claim 不丢。
        const resultJson = JSON.stringify(result);
        lease.database
          .prepare(
            `INSERT INTO desktop_idempotency
             (workspace_path, idempotency_key, request_fingerprint, result_json, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(workspace_path, idempotency_key) DO UPDATE SET
               request_fingerprint = excluded.request_fingerprint,
               result_json = excluded.result_json,
               created_at = excluded.created_at`,
          )
          .run(
            canonical,
            normalized,
            requireNonEmpty(requestFingerprint, "requestFingerprint"),
            resultJson,
            this.now(),
          );
        pruneIdempotency(lease.database);
      }),
    );
  }

  private withWorkspace<T>(
    workspacePath: string,
    operation: (lease: OperationalDatabaseLease) => T,
  ): T {
    const storageRoot = resolvePicoPaths(workspacePath, { picoHome: this.picoHome }).workspace.root;
    return withWorkspaceSqliteLease(storageRoot, operation);
  }
}

function insertClaimRow(database: DatabaseSync, claim: DesktopFirstSendClaim): void {
  database
    .prepare(
      `INSERT INTO desktop_first_send_claims
       (workspace_path, idempotency_key, session_id, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      claim.workspacePath,
      claim.key,
      claim.sessionId,
      claim.requestFingerprint,
      claim.createdAt,
    );
}

function selectClaimRow(
  database: DatabaseSync,
  workspacePath: string,
  key: string,
): DesktopFirstSendClaim | undefined {
  const row = database
    .prepare(
      `SELECT workspace_path, idempotency_key, session_id, request_fingerprint, created_at
       FROM desktop_first_send_claims
       WHERE workspace_path = ? AND idempotency_key = ?`,
    )
    .get(workspacePath, key) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    workspacePath: requireRowString(row, "workspace_path"),
    key: requireRowString(row, "idempotency_key"),
    sessionId: requireRowString(row, "session_id"),
    requestFingerprint: requireRowString(row, "request_fingerprint"),
    createdAt: requireRowNumber(row, "created_at"),
  };
}

function selectRewindClaimRow(
  database: DatabaseSync,
  workspacePath: string,
  key: string,
): DesktopRewindClaim | undefined {
  const row = database
    .prepare(
      `SELECT workspace_path, idempotency_key, source_session_id, target_session_id,
              operation_id, request_fingerprint, created_at
       FROM desktop_rewind_claims
       WHERE workspace_path = ? AND idempotency_key = ?`,
    )
    .get(workspacePath, key) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    workspacePath: requireRowString(row, "workspace_path"),
    key: requireRowString(row, "idempotency_key"),
    sourceSessionId: requireRowString(row, "source_session_id"),
    targetSessionId: requireRowString(row, "target_session_id"),
    operationId: requireRowString(row, "operation_id"),
    requestFingerprint: requireRowString(row, "request_fingerprint"),
    createdAt: requireRowNumber(row, "created_at"),
  };
}

function queueRowToQueuedInput(row: Record<string, unknown>): DesktopQueuedInput {
  const inputJson = requireRowString(row, "input_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new Error("Desktop conversation queue row contains an invalid input payload");
  }
  return {
    queueId: requireRowString(row, "queue_id"),
    workspacePath: requireRowString(row, "workspace_path"),
    sessionId: requireRowString(row, "session_id"),
    input: parseDesktopQueuedInputRecord(parsed),
    createdAt: requireRowNumber(row, "created_at"),
  };
}

function selectQueuedInputs(
  database: DatabaseSync,
  workspacePath: string,
  sessionId: string,
): DesktopQueuedInput[] {
  const rows = database
    .prepare(
      `SELECT queue_id, workspace_path, session_id, input_json, created_at
       FROM desktop_input_queue
       WHERE workspace_path = ? AND session_id = ?
       ORDER BY queue_order ASC, queue_id ASC`,
    )
    .all(workspacePath, sessionId) as unknown[];
  return rows.map((row) => queueRowToQueuedInput(row as Record<string, unknown>));
}

/** 与 JSON 实现 retainFirstSendClaims 等价:过期清理 + 每 workspace 保留最近 MAX 条。 */
function pruneFirstSendClaims(database: DatabaseSync, now: number): void {
  database
    .prepare(`DELETE FROM desktop_first_send_claims WHERE created_at < ?`)
    .run(now - FIRST_SEND_CLAIM_RETENTION_MS);
  database
    .prepare(
      `DELETE FROM desktop_first_send_claims WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid,
                  ROW_NUMBER() OVER (
                    PARTITION BY workspace_path
                    ORDER BY created_at DESC, idempotency_key ASC
                  ) AS rank
           FROM desktop_first_send_claims
         ) WHERE rank > ?
       )`,
    )
    .run(MAX_FIRST_SEND_CLAIMS);
}

/** 与 JSON 实现等价:每 workspace 保留最近 MAX_IDEMPOTENCY_RECORDS 条。 */
function pruneIdempotency(database: DatabaseSync): void {
  database
    .prepare(
      `DELETE FROM desktop_idempotency WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid,
                  ROW_NUMBER() OVER (
                    PARTITION BY workspace_path
                    ORDER BY created_at DESC, rowid DESC
                  ) AS rank
           FROM desktop_idempotency
         ) WHERE rank > ?
       )`,
    )
    .run(MAX_IDEMPOTENCY_RECORDS);
}

function requireRowString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || !value) {
    throw new Error(`Desktop conversation state row has an invalid ${field} column`);
  }
  return value;
}

function requireRowNumber(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Desktop conversation state row has an invalid ${field} column`);
  }
  return value;
}

function parseRowJsonObject(row: Record<string, unknown>, field: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireRowString(row, field));
  } catch {
    throw new Error(`Desktop conversation state row has an invalid ${field} column`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Desktop conversation state row has an invalid ${field} column`);
  }
  return parsed as JsonObject;
}
