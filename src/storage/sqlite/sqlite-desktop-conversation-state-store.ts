import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { JsonObject, RuntimeUserInput } from "@pico/protocol";
import { resolvePicoHome } from "../../paths/pico-paths.js";
import {
  FIRST_SEND_CLAIM_RETENTION_MS,
  MAX_FIRST_SEND_CLAIMS,
  MAX_IDEMPOTENCY_RECORDS,
  normalizeWorkspacePath,
  parseDesktopConversationStateFile,
  parseDesktopQueuedInputRecord,
  requireNonEmpty,
  type DesktopConversationStateFile,
  type DesktopConversationStateStoreLike,
  type DesktopFirstSendClaim,
  type DesktopIdempotencyRecord,
  type DesktopQueuedInput,
} from "../../daemon/desktop-conversation-state.js";
import { resolveWorkspaceSqliteStorageRoot, withWorkspaceSqliteLease } from "./workspace-scopes.js";
import type { OperationalDatabaseLease } from "./sqlite-database.js";
import { logger } from "../../observability/logger.js";

/**
 * desktop conversation state 的 SQLite 实现(ADR 28)。
 *
 * - 旧全局 JSON($PICO_HOME/desktop/conversation-state.json)按 workspacePath
 *   分片进各 workspace 库(control scope migration 2 的三张表);路由与既有
 *   workspace 存储一致:workspacePath → resolvePicoPaths → $PICO_HOME/workspaces/<id>/pico.sqlite。
 * - 每次 store 调用独立持有 lease(withWorkspaceSqliteLease),写路径单条
 *   BEGIN IMMEDIATE 事务,无半写窗口;并发由既有 lease/事务串行化,不加新锁。
 * - 一次性迁移:首次调用时读 legacy JSON(若存在且无 .migrated 标记),按
 *   storage root 分组,每个 workspace 库各自单事务导入;全部成功后原文件改名
 *   conversation-state.json.migrated(保留不删)。库内 control_metadata 标记
 *   防止重复导入(导入提交而改名失败的窗口下,重跑只补改名)。
 */

/** control_metadata 中记录"该库已完成 legacy JSON 导入"的键。 */
const LEGACY_IMPORT_MARKER_KEY = "desktopConversationStateLegacyImport";

export interface SqliteDesktopConversationStateStoreOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly picoHome?: string;
  /** 覆盖 legacy JSON 路径(默认 $PICO_HOME/desktop/conversation-state.json),测试用。 */
  readonly legacyJsonPath?: string;
  readonly now?: () => number;
  readonly generateId?: () => string;
}

export class SqliteDesktopConversationStateStore implements DesktopConversationStateStoreLike {
  readonly legacyJsonPath: string;
  private readonly picoHome: string;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private legacyMigrationAttempted = false;

  constructor(options: SqliteDesktopConversationStateStoreOptions = {}) {
    this.picoHome = resolvePicoHome({ env: options.env, picoHome: options.picoHome });
    this.legacyJsonPath =
      options.legacyJsonPath ?? join(this.picoHome, "desktop", "conversation-state.json");
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => `queued_${randomUUID()}`);
  }

  async listQueued(workspacePath: string, sessionId: string): Promise<DesktopQueuedInput[]> {
    this.ensureLegacyMigration();
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedSessionId = requireNonEmpty(sessionId, "sessionId");
    return this.withWorkspace(canonical, (lease) =>
      lease.transaction("read", () => {
        const rows = lease.database
          .prepare(
            `SELECT queue_id, workspace_path, session_id, input_json, created_at
             FROM desktop_input_queue
             WHERE workspace_path = ? AND session_id = ?
             ORDER BY created_at ASC, queue_id ASC`,
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
    this.ensureLegacyMigration();
    const queued: DesktopQueuedInput = {
      queueId: this.generateId(),
      workspacePath: normalizeWorkspacePath(workspacePath),
      sessionId: requireNonEmpty(sessionId, "sessionId"),
      input,
      createdAt: this.now(),
    };
    this.withWorkspace(queued.workspacePath, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO desktop_input_queue
             (queue_id, workspace_path, session_id, input_json, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            queued.queueId,
            queued.workspacePath,
            queued.sessionId,
            JSON.stringify(queued.input),
            queued.createdAt,
          );
      }),
    );
    return queued;
  }

  async removeQueued(workspacePath: string, queueId: string): Promise<void> {
    this.ensureLegacyMigration();
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

  async clearQueued(workspacePath: string, sessionId: string): Promise<void> {
    this.ensureLegacyMigration();
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
    this.ensureLegacyMigration();
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
    this.ensureLegacyMigration();
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
    this.ensureLegacyMigration();
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

  async rememberIdempotent(
    workspacePath: string,
    key: string,
    requestFingerprint: string,
    result: JsonObject,
  ): Promise<void> {
    this.ensureLegacyMigration();
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
    const storageRoot = resolveWorkspaceSqliteStorageRoot({
      workDir: workspacePath,
      picoHome: this.picoHome,
    });
    return withWorkspaceSqliteLease(storageRoot, operation);
  }

  private ensureLegacyMigration(): void {
    if (this.legacyMigrationAttempted) return;
    this.legacyMigrationAttempted = true;
    migrateLegacyDesktopConversationStateSync({
      picoHome: this.picoHome,
      legacyJsonPath: this.legacyJsonPath,
    });
  }
}

interface LegacyWorkspaceImport {
  readonly storageRoot: string;
  readonly queuedInputs: DesktopQueuedInput[];
  readonly idempotency: DesktopIdempotencyRecord[];
  readonly firstSendClaims: DesktopFirstSendClaim[];
}

/**
 * 一次性迁移(ADR 28 决策 3)。进程内幂等:任一步失败即中止且不改名,
 * 下次打开重试;已导入的库凭 control_metadata 标记跳过。
 *
 * 失败分类(对抗审查 Finding 6,防 poison-pill):解析阶段失败(JSON 语法/形状)
 * 与导入阶段约束冲突(源数据内重复键)是永久损坏——重试永不可能成功,原本会
 * 让"每次进程重启后的首个会话操作"必抛。此类失败记 error 日志后将原文件
 * 改名 .failed 隔离(数据保留不删)并放行,store 以空态起步;其余失败(IO/锁)
 * 视为瞬态,保留原 JSON 维持重试语义。多分片场景下永久失败隔离时,已提交的
 * 分片保留其导入,未提交分片以空态起步(日志中说明)。
 */
export function migrateLegacyDesktopConversationStateSync(options: {
  readonly picoHome?: string;
  readonly legacyJsonPath: string;
}): void {
  const legacyPath = options.legacyJsonPath;
  const markerPath = `${legacyPath}.migrated`;
  if (existsSync(markerPath)) return;
  if (!existsSync(legacyPath)) return;
  // 读取阶段不在 try 内:IO 错误(锁/权限/瞬态)原样上抛维持重试(ADR 28;
  // 对抗审查 F1——readFileSync 进 try 会把 EBUSY/EPERM 误判为永久损坏)。
  const raw = readFileSync(legacyPath, "utf8");
  let state: DesktopConversationStateFile;
  try {
    state = parseDesktopConversationStateFile(JSON.parse(raw), legacyPath);
  } catch (error) {
    if (!isPermanentParseFailure(error)) throw error;
    isolatePermanentlyFailedLegacyJson(legacyPath, error, "legacy JSON 解析失败(语法/形状损坏)");
    return;
  }

  const groups = new Map<string, LegacyWorkspaceImport>();
  const groupFor = (workspacePath: string): LegacyWorkspaceImport => {
    // JSON 内 workspacePath 是值字段:按现有 workspace 路由规则映射到分片库,导入时过滤。
    const storageRoot = resolveWorkspaceSqliteStorageRoot({
      workDir: workspacePath,
      picoHome: options.picoHome,
    });
    let group = groups.get(storageRoot);
    if (!group) {
      group = { storageRoot, queuedInputs: [], idempotency: [], firstSendClaims: [] };
      groups.set(storageRoot, group);
    }
    return group;
  };
  for (const queued of state.queuedInputs) groupFor(queued.workspacePath).queuedInputs.push(queued);
  for (const record of state.idempotency) groupFor(record.workspacePath).idempotency.push(record);
  for (const claim of state.firstSendClaims) {
    groupFor(claim.workspacePath).firstSendClaims.push(claim);
  }

  try {
    for (const group of groups.values()) {
      withWorkspaceSqliteLease(group.storageRoot, (lease) => {
        lease.transaction("write", () => {
          // 库内已有导入标记则不再导入(防双导入);标记先写,行导入失败连同标记一起回滚。
          if (readControlMetadata(lease.database, LEGACY_IMPORT_MARKER_KEY) !== undefined) return;
          writeControlMetadata(lease.database, LEGACY_IMPORT_MARKER_KEY, {
            legacyVersion: state.version,
            importedAt: new Date().toISOString(),
          });
          for (const queued of group.queuedInputs) insertQueueRow(lease.database, queued);
          for (const record of group.idempotency) insertIdempotencyRow(lease.database, record);
          for (const claim of group.firstSendClaims) insertClaimRow(lease.database, claim);
        });
      });
    }
  } catch (error) {
    if (isPermanentImportFailure(error)) {
      isolatePermanentlyFailedLegacyJson(legacyPath, error, "导入约束冲突(源数据内重复键)");
      return;
    }
    throw error;
  }
  if (!existsSync(markerPath)) renameSync(legacyPath, markerPath);
}

/**
 * 永久失败隔离:error 日志 + 改名 .failed(数据保留),让后续操作以空态起步。
 * 注意多分片场景:此前已提交的分片保留导入,未提交分片空态起步。
 * .failed 已存在时不覆盖(Windows renameSync 会静默替换):带毫秒时间戳后缀
 * 保留历次隔离副本(对抗审查 F4)。
 */
function isolatePermanentlyFailedLegacyJson(
  legacyPath: string,
  error: unknown,
  reason: string,
): void {
  logger.error(
    { err: error, legacyPath, reason },
    "[ConversationState] legacy JSON 永久损坏,已隔离为 .failed 并跳过迁移(已提交分片保留)",
  );
  const failedPath = existsSync(`${legacyPath}.failed`)
    ? `${legacyPath}.${Date.now()}.failed`
    : `${legacyPath}.failed`;
  renameSync(legacyPath, failedPath);
}

/**
 * 解析阶段的永久失败:JSON 语法错(SyntaxError)或形状校验错("Desktop conversation*"
 * 前缀的显式校验消息);其余(带 code 的 IO 错误等)按瞬态处理 rethrow 维持重试。
 */
function isPermanentParseFailure(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  return String((error as { message?: unknown } | null)?.message ?? "").startsWith(
    "Desktop conversation",
  );
}

/** 导入阶段的永久失败:约束冲突=源数据自身重复,重试不可救;其余(IO/锁)按瞬态重试。 */
function isPermanentImportFailure(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed|CHECK constraint failed/u.test(
    message,
  );
}

function insertQueueRow(database: DatabaseSync, queued: DesktopQueuedInput): void {
  database
    .prepare(
      `INSERT INTO desktop_input_queue
       (queue_id, workspace_path, session_id, input_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      queued.queueId,
      queued.workspacePath,
      queued.sessionId,
      JSON.stringify(queued.input),
      queued.createdAt,
    );
}

function insertIdempotencyRow(database: DatabaseSync, record: DesktopIdempotencyRecord): void {
  database
    .prepare(
      `INSERT INTO desktop_idempotency
       (workspace_path, idempotency_key, request_fingerprint, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      record.workspacePath,
      record.key,
      record.requestFingerprint,
      JSON.stringify(record.result),
      record.createdAt,
    );
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

function readControlMetadata(database: DatabaseSync, key: string): unknown {
  const row = database.prepare(`SELECT value_json FROM control_metadata WHERE key = ?`).get(key) as
    | { value_json?: unknown }
    | undefined;
  if (row === undefined) return undefined;
  try {
    return JSON.parse(requireRowString(row, "value_json"));
  } catch {
    throw new Error(`control_metadata.${key} contains an invalid JSON value`);
  }
}

function writeControlMetadata(database: DatabaseSync, key: string, value: JsonObject): void {
  database
    .prepare(
      `INSERT INTO control_metadata (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
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
