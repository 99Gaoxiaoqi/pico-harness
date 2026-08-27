import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { FileStorageIntegrityError } from "./local-file-storage.js";
import { withWorkspaceSqliteLease } from "./sqlite/workspace-scopes.js";

const STORAGE_OPERATION_VERSION = 1 as const;
const SAFE_OPERATION_ID = /^[A-Za-z0-9._-]+$/u;

export type StorageOperationState =
  | "prepared"
  | "workspace_applied"
  | "session_committed"
  | "sidecars_committed"
  | "completed"
  | "aborted"
  | "needs_attention";

export type StoredFileState =
  | { kind: "missing" }
  | { kind: "file"; blobSha256: string; sizeBytes: number; mode: number };

export interface StorageOperationError {
  phase: string;
  message: string;
  conflictingPaths?: string[];
}

export interface StorageOperationDisposition {
  readonly action: "retry" | "abort";
  readonly at: string;
  readonly fromVersion: number;
  readonly reason: string;
  readonly failure?: StorageOperationError;
}

export interface StorageOperationDispositionInput {
  readonly operationId: string;
  readonly expectedVersion: number;
  readonly reason: string;
}

interface StorageOperationBase {
  schemaVersion: typeof STORAGE_OPERATION_VERSION;
  operationId: string;
  version: number;
  state: StorageOperationState;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  error?: StorageOperationError;
  dispositions?: StorageOperationDisposition[];
}

export interface RewindStorageOperation extends StorageOperationBase {
  kind: "rewind";
  mode: "code" | "conversation" | "both";
  precondition: {
    sessionLastSeq: number;
    effectiveHistoryDigest: string;
    fileHistoryRevision: number;
  };
  target: {
    messageId: string;
    sourceMessageEventId: string;
    messageIndex: number;
    /** TUI 崩溃恢复 handoff 使用同一 canonical 用户输入。 */
    userPrompt: string;
    transcriptIndex?: number;
    interactionMode?: "default" | "plan" | "auto" | "yolo";
    prePlanMode?: "default" | "auto" | "yolo";
  };
  files: Array<{
    rootId: string;
    relativePath: string;
    before: StoredFileState;
    after: StoredFileState;
  }>;
}

export interface ForkStorageOperation extends StorageOperationBase {
  kind: "fork";
  sourceSessionId: string;
  sourceCursor: {
    logId: string;
    seq: number;
    epoch: number;
    eventId: string;
  };
  targetSessionId: string;
  /** @deprecated v1 journal compatibility; canonical writes use split axes below. */
  targetMode?: "default" | "plan" | "auto" | "yolo";
  /** 恢复 prepared 操作时不能猜测的目标协作与权限轴。 */
  targetCollaborationMode?: "agent" | "plan";
  targetPermissionMode?: "default" | "auto" | "yolo";
  /** Durable disposition: cleanup_only can never be retried forward. */
  recoveryPolicy?: "forward" | "cleanup_only";
  stagingDirectory: string;
  /** Immutable staging authority bound in SQLite before the operation becomes visible. */
  bundleManifest?: {
    manifestPath: string;
    stagedBundlePath: string;
    contentSha256: string;
    sizeBytes: number;
  };
}

export type StorageOperation = RewindStorageOperation | ForkStorageOperation;

export type NewStorageOperation =
  | (Omit<RewindStorageOperation, keyof StorageOperationBase | "kind"> & {
      kind: "rewind";
      sessionId: string;
      operationId?: string;
    })
  | (Omit<ForkStorageOperation, keyof StorageOperationBase | "kind"> & {
      kind: "fork";
      sessionId: string;
      operationId?: string;
    });

export interface OperationJournalOptions {
  workDir: string;
  picoHome?: string;
  now?: () => Date;
}

/**
 * fork/rewind Saga 的耐久 journal(票 08 起:workspace pico.sqlite 的
 * `storage_operations` 单表,ADR 24 §4.5)。
 *
 * 旧 `<storageRoot>/storage-operations/<operationId>.json` 每步整文件原子重写
 * → 单行 `operation_json` UPSERT;状态机(prepared→…→completed/aborted/
 * needs_attention)与 version CAS 在 BEGIN IMMEDIATE 写事务内逐条校验,跨进程
 * 互斥由 SQLite 单写者接管,`.disposition-leases` 目录锁随之退役。
 */
export class StorageOperationJournal {
  private readonly storageRoot: string;
  private readonly now: () => Date;

  constructor(options: OperationJournalOptions) {
    this.storageRoot = resolvePicoPaths(options.workDir, {
      ...(options.picoHome !== undefined ? { picoHome: options.picoHome } : {}),
    }).workspace.root;
    this.now = options.now ?? (() => new Date());
  }

  async create(input: NewStorageOperation): Promise<StorageOperation> {
    const operationId = input.operationId ?? randomUUID();
    if (!SAFE_OPERATION_ID.test(operationId))
      throw new Error(`Invalid operation ID: ${operationId}`);
    const now = this.now().toISOString();
    const operation = {
      ...input,
      schemaVersion: STORAGE_OPERATION_VERSION,
      operationId,
      version: 1,
      state: "prepared",
      createdAt: now,
      updatedAt: now,
    } as StorageOperation;
    const parsed = parseStorageOperation(operation);
    if (!parsed) throw new Error("Invalid storage operation");
    await this.write(parsed, "insert");
    return parsed;
  }

  async get(operationId: string): Promise<StorageOperation | undefined> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("read", () => readOperationLocked(lease.database, operationId)),
    );
  }

  async advance(input: {
    operationId: string;
    expectedVersion: number;
    nextState: StorageOperationState;
    error?: StorageOperationError;
    recoveryPolicy?: ForkStorageOperation["recoveryPolicy"];
  }): Promise<StorageOperation> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("write", () => {
        const current = requireOperationLocked(lease.database, input.operationId);
        assertVersionMatch(current, input.expectedVersion);
        if (!canTransition(current.state, input.nextState)) {
          throw new Error(
            `Invalid storage operation transition: ${current.state} -> ${input.nextState}`,
          );
        }
        const next = {
          ...current,
          version: current.version + 1,
          state: input.nextState,
          updatedAt: this.now().toISOString(),
          ...(input.error ? { error: input.error } : {}),
          ...(current.kind === "fork" && input.recoveryPolicy
            ? { recoveryPolicy: input.recoveryPolicy }
            : {}),
        } satisfies StorageOperation;
        updateOperationLocked(lease.database, next);
        return next;
      }),
    );
  }

  /** Irreversibly seal an uncertain Fork so every disposition is cleanup-only. */
  async sealForkCleanupOnly(
    operationId: string,
    expectedVersion: number,
  ): Promise<ForkStorageOperation> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("write", () => {
        const current = requireOperationLocked(lease.database, operationId);
        assertVersionMatch(current, expectedVersion);
        if (current.kind !== "fork")
          throw new Error(`Storage operation is not a fork: ${operationId}`);
        if (current.state === "completed" || current.state === "aborted") {
          throw new Error(`Fork operation ${operationId} is already ${current.state}`);
        }
        if (current.recoveryPolicy === "cleanup_only") return current;
        const next: ForkStorageOperation = {
          ...current,
          recoveryPolicy: "cleanup_only",
          version: current.version + 1,
          updatedAt: this.now().toISOString(),
        };
        updateOperationLocked(lease.database, next);
        return next;
      }),
    );
  }

  /** 人工 retry 只能恢复到 journal 记录的失败 phase，不能由调用方猜测。 */
  async retryNeedsAttention(input: StorageOperationDispositionInput): Promise<StorageOperation> {
    return this.applyDisposition(input, (current, at) => {
      const failedPhase = current.error?.phase;
      if (!failedPhase || !isRetryableOperationState(failedPhase)) {
        throw new Error(
          `Storage operation ${current.operationId} has no safe recorded phase to retry`,
        );
      }
      const next = structuredClone(current);
      next.version += 1;
      next.state = failedPhase;
      next.updatedAt = at;
      next.dispositions = [
        ...(current.dispositions ?? []),
        createDisposition("retry", current, input.reason, at),
      ];
      delete next.error;
      return next;
    });
  }

  /** 人工 abort 是不可逆终态。 */
  async abortNeedsAttention(input: StorageOperationDispositionInput): Promise<StorageOperation> {
    return this.applyDisposition(input, (current, at) => {
      const next = structuredClone(current);
      next.version += 1;
      next.state = "aborted";
      next.updatedAt = at;
      next.dispositions = [
        ...(current.dispositions ?? []),
        createDisposition("abort", current, input.reason, at),
      ];
      return next;
    });
  }

  async listUnfinished(): Promise<StorageOperation[]> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("read", () =>
        listOperationsLocked(
          lease.database.prepare(
            `SELECT operation_json FROM storage_operations
             WHERE state NOT IN ('completed','aborted','needs_attention')`,
          ),
        ),
      ),
    );
  }

  async listNeedsAttention(): Promise<StorageOperation[]> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("read", () =>
        listOperationsLocked(
          lease.database.prepare(
            "SELECT operation_json FROM storage_operations WHERE state = 'needs_attention'",
          ),
        ),
      ),
    );
  }

  /**
   * Doctor / TUI handoff 使用的全量只读视图。行内 operation_json 无法解析视作
   * 库被外部改写:fail-closed 抛错而不是像 JSONL 纪元那样静默跳过(行只能由
   * 本 journal 在校验后写入,畸形行不存在自然路径)。
   */
  async list(): Promise<StorageOperation[]> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("read", () =>
        listOperationsLocked(
          lease.database.prepare(
            "SELECT operation_json FROM storage_operations ORDER BY created_at, operation_id",
          ),
        ),
      ),
    );
  }

  /**
   * session-resolver fork 发布判定(session-resolver.ts indexForkTargetOperations
   * 的单查询化):kind='fork' 且非 aborted 的目标会话 → hasCompleted 聚合。
   */
  async listForkTargets(): Promise<Map<string, { hasCompleted: boolean }>> {
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("read", () => {
        const rows = lease.database
          .prepare(
            `SELECT target_session_id, state FROM storage_operations
             WHERE kind = 'fork' AND state <> 'aborted' AND target_session_id IS NOT NULL`,
          )
          .all() as Array<{ target_session_id: unknown; state: unknown }>;
        const targets = new Map<string, { hasCompleted: boolean }>();
        for (const row of rows) {
          if (typeof row.target_session_id !== "string") continue;
          const existing = targets.get(row.target_session_id);
          targets.set(row.target_session_id, {
            hasCompleted: existing?.hasCompleted === true || row.state === "completed",
          });
        }
        return targets;
      }),
    );
  }

  private async applyDisposition(
    input: StorageOperationDispositionInput,
    build: (current: StorageOperation, at: string) => StorageOperation,
  ): Promise<StorageOperation> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 2_000) {
      throw new Error("Storage operation disposition reason must contain 1-2000 characters");
    }
    if (!SAFE_OPERATION_ID.test(input.operationId)) {
      throw new Error(`Invalid operation ID: ${input.operationId}`);
    }
    return withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("write", () => {
        const current = requireOperationLocked(lease.database, input.operationId);
        assertVersionMatch(current, input.expectedVersion);
        if (current.state !== "needs_attention") {
          throw new Error(
            `Storage operation ${current.operationId} is ${current.state}, not needs_attention`,
          );
        }
        const next = build(current, this.now().toISOString());
        updateOperationLocked(lease.database, next);
        return next;
      }),
    );
  }

  private write(operation: StorageOperation, mode: "insert" | "update"): Promise<void> {
    return Promise.resolve(
      withWorkspaceSqliteLease(this.storageRoot, (lease) =>
        lease.transaction("write", () => {
          if (mode === "insert") {
            insertOperationLocked(lease.database, operation);
          } else {
            updateOperationLocked(lease.database, operation);
          }
        }),
      ),
    );
  }
}

export function isTerminalStorageOperation(state: StorageOperationState): boolean {
  return isTerminal(state);
}

function insertOperationLocked(database: DatabaseSync, operation: StorageOperation): void {
  database
    .prepare(
      `INSERT INTO storage_operations
         (operation_id, kind, version, state, session_id, target_session_id,
          operation_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      operation.operationId,
      operation.kind,
      operation.version,
      operation.state,
      operation.sessionId,
      operation.kind === "fork" ? operation.targetSessionId : null,
      canonicalJson(operation),
      operation.createdAt,
      operation.updatedAt,
    );
}

function updateOperationLocked(database: DatabaseSync, operation: StorageOperation): void {
  database
    .prepare(
      `UPDATE storage_operations
       SET kind = ?, version = ?, state = ?, session_id = ?, target_session_id = ?,
           operation_json = ?, updated_at = ?
       WHERE operation_id = ?`,
    )
    .run(
      operation.kind,
      operation.version,
      operation.state,
      operation.sessionId,
      operation.kind === "fork" ? operation.targetSessionId : null,
      canonicalJson(operation),
      operation.updatedAt,
      operation.operationId,
    );
}

function readOperationLocked(
  database: DatabaseSync,
  operationId: string,
): StorageOperation | undefined {
  if (!SAFE_OPERATION_ID.test(operationId)) {
    throw new Error(`Invalid operation ID: ${operationId}`);
  }
  const row = database
    .prepare("SELECT operation_json FROM storage_operations WHERE operation_id = ?")
    .get(operationId) as { operation_json?: unknown } | undefined;
  if (row === undefined) return undefined;
  return parseOperationRow(row.operation_json, operationId);
}

function requireOperationLocked(database: DatabaseSync, operationId: string): StorageOperation {
  const current = readOperationLocked(database, operationId);
  if (!current) throw new Error(`Storage operation not found: ${operationId}`);
  return current;
}

function listOperationsLocked(statement: { all(): unknown[] }): StorageOperation[] {
  const rows = statement.all() as Array<{ operation_json?: unknown }>;
  return rows.map((row, index) => parseOperationRow(row.operation_json, `row #${index + 1}`));
}

function parseOperationRow(value: unknown, identity: string): StorageOperation {
  const parsed = parseStorageOperation(
    typeof value === "string" ? (JSON.parse(value) as unknown) : undefined,
  );
  if (!parsed) {
    throw new FileStorageIntegrityError(`Storage operation journal row is malformed: ${identity}`);
  }
  return parsed;
}

function assertVersionMatch(current: StorageOperation, expectedVersion: number): void {
  if (current.version !== expectedVersion) {
    throw new Error(
      `Storage operation version conflict: expected ${expectedVersion}, actual ${current.version}`,
    );
  }
}

function canonicalJson(operation: StorageOperation): string {
  return JSON.stringify(operation);
}

function canTransition(from: StorageOperationState, to: StorageOperationState): boolean {
  if (from === "completed" || from === "aborted" || from === "needs_attention") return false;
  if (from === to) return true;
  if (to === "needs_attention" || to === "aborted") return true;
  switch (from) {
    case "prepared":
      return (
        to === "workspace_applied" || to === "session_committed" || to === "sidecars_committed"
      );
    case "workspace_applied":
      return to === "session_committed" || to === "sidecars_committed";
    case "session_committed":
      return to === "sidecars_committed";
    case "sidecars_committed":
      return to === "completed";
  }
}

function isRetryableOperationState(
  value: string,
): value is Exclude<StorageOperationState, "completed" | "aborted" | "needs_attention"> {
  return (
    value === "prepared" ||
    value === "workspace_applied" ||
    value === "session_committed" ||
    value === "sidecars_committed"
  );
}

function createDisposition(
  action: StorageOperationDisposition["action"],
  operation: StorageOperation,
  reason: string,
  at: string,
): StorageOperationDisposition {
  return {
    action,
    at,
    fromVersion: operation.version,
    reason: reason.trim(),
    ...(operation.error ? { failure: structuredClone(operation.error) } : {}),
  };
}

function isTerminal(state: StorageOperationState): boolean {
  return state === "completed" || state === "aborted" || state === "needs_attention";
}

function parseStorageOperation(value: unknown): StorageOperation | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== STORAGE_OPERATION_VERSION) return undefined;
  if (
    typeof value["operationId"] !== "string" ||
    !SAFE_OPERATION_ID.test(value["operationId"]) ||
    !isPositiveInteger(value["version"]) ||
    !isOperationState(value["state"]) ||
    typeof value["sessionId"] !== "string" ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    !isOperationError(value["error"]) ||
    !isOperationDispositions(value["dispositions"])
  ) {
    return undefined;
  }
  if (value["kind"] === "rewind") return parseRewindOperation(value);
  if (value["kind"] === "fork") return parseForkOperation(value);
  return undefined;
}

function parseRewindOperation(value: Record<string, unknown>): RewindStorageOperation | undefined {
  const precondition = value["precondition"];
  const target = value["target"];
  const files = value["files"];
  if (
    !isRewindMode(value["mode"]) ||
    !isRecord(precondition) ||
    !isNonNegativeInteger(precondition["sessionLastSeq"]) ||
    typeof precondition["effectiveHistoryDigest"] !== "string" ||
    !isNonNegativeInteger(precondition["fileHistoryRevision"]) ||
    !isRecord(target) ||
    typeof target["messageId"] !== "string" ||
    target["messageId"].length === 0 ||
    typeof target["sourceMessageEventId"] !== "string" ||
    target["sourceMessageEventId"] !== `user-message:${target["messageId"]}` ||
    !isNonNegativeInteger(target["messageIndex"]) ||
    typeof target["userPrompt"] !== "string" ||
    target["userPrompt"].length === 0 ||
    !isOptionalNonNegativeInteger(target["transcriptIndex"]) ||
    !isOptionalInteractionMode(target["interactionMode"]) ||
    !isOptionalPrePlanMode(target["prePlanMode"]) ||
    (target["prePlanMode"] !== undefined && target["interactionMode"] !== "plan") ||
    !Array.isArray(files) ||
    !files.every(isStoredFileTransition)
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as RewindStorageOperation;
}

function parseForkOperation(value: Record<string, unknown>): ForkStorageOperation | undefined {
  const cursor = value["sourceCursor"];
  const bundleManifest = value["bundleManifest"];
  if (
    typeof value["sourceSessionId"] !== "string" ||
    typeof value["targetSessionId"] !== "string" ||
    (value["targetMode"] !== undefined &&
      value["targetMode"] !== "default" &&
      value["targetMode"] !== "yolo" &&
      value["targetMode"] !== "auto" &&
      value["targetMode"] !== "plan") ||
    (value["targetCollaborationMode"] !== undefined &&
      value["targetCollaborationMode"] !== "agent" &&
      value["targetCollaborationMode"] !== "plan") ||
    (value["targetPermissionMode"] !== undefined &&
      value["targetPermissionMode"] !== "default" &&
      value["targetPermissionMode"] !== "auto" &&
      value["targetPermissionMode"] !== "yolo") ||
    (value["targetCollaborationMode"] === undefined) !==
      (value["targetPermissionMode"] === undefined) ||
    (value["targetMode"] !== undefined && value["targetCollaborationMode"] !== undefined) ||
    (value["recoveryPolicy"] !== undefined &&
      value["recoveryPolicy"] !== "forward" &&
      value["recoveryPolicy"] !== "cleanup_only") ||
    typeof value["stagingDirectory"] !== "string" ||
    !isOptionalForkBundleManifest(bundleManifest) ||
    !isRecord(cursor) ||
    typeof cursor["logId"] !== "string" ||
    !isNonNegativeInteger(cursor["seq"]) ||
    !isNonNegativeInteger(cursor["epoch"]) ||
    typeof cursor["eventId"] !== "string"
  ) {
    return undefined;
  }
  return structuredClone(value) as unknown as ForkStorageOperation;
}

function isOptionalForkBundleManifest(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value["manifestPath"] === "string" &&
    typeof value["stagedBundlePath"] === "string" &&
    typeof value["contentSha256"] === "string" &&
    /^[0-9a-f]{64}$/u.test(value["contentSha256"]) &&
    isNonNegativeInteger(value["sizeBytes"])
  );
}

function isStoredFileTransition(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value["rootId"] !== "string" ||
    typeof value["relativePath"] !== "string"
  ) {
    return false;
  }
  return isStoredFileState(value["before"]) && isStoredFileState(value["after"]);
}

function isStoredFileState(value: unknown): value is StoredFileState {
  if (!isRecord(value)) return false;
  if (value["kind"] === "missing") return true;
  return (
    value["kind"] === "file" &&
    typeof value["blobSha256"] === "string" &&
    /^[a-f0-9]{64}$/u.test(value["blobSha256"]) &&
    isNonNegativeInteger(value["sizeBytes"]) &&
    isNonNegativeInteger(value["mode"])
  );
}

function isOperationError(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value["phase"] === "string" &&
    typeof value["message"] === "string" &&
    (value["conflictingPaths"] === undefined ||
      (Array.isArray(value["conflictingPaths"]) &&
        value["conflictingPaths"].every((path) => typeof path === "string")))
  );
}

function isOperationDispositions(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every(isOperationDisposition);
}

function isOperationDisposition(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value["action"] === "retry" || value["action"] === "abort") &&
    typeof value["at"] === "string" &&
    isPositiveInteger(value["fromVersion"]) &&
    typeof value["reason"] === "string" &&
    value["reason"].length > 0 &&
    value["reason"].length <= 2_000 &&
    isOperationError(value["failure"])
  );
}

function isOperationState(value: unknown): value is StorageOperationState {
  return (
    value === "prepared" ||
    value === "workspace_applied" ||
    value === "session_committed" ||
    value === "sidecars_committed" ||
    value === "completed" ||
    value === "aborted" ||
    value === "needs_attention"
  );
}

function isRewindMode(value: unknown): value is RewindStorageOperation["mode"] {
  return value === "code" || value === "conversation" || value === "both";
}

function isOptionalInteractionMode(value: unknown): boolean {
  return (
    value === undefined ||
    value === "default" ||
    value === "plan" ||
    value === "auto" ||
    value === "yolo"
  );
}

function isOptionalPrePlanMode(value: unknown): boolean {
  return value === undefined || value === "default" || value === "auto" || value === "yolo";
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
