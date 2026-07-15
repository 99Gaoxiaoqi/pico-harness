import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { OperationReferenceIndex } from "./operation-reference-index.js";
import { OwnerLease } from "./owner-lease.js";

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
    sourceMessageEventId?: string;
    messageIndex: number;
    /** TUI 崩溃恢复 handoff；旧 operation 可缺省。 */
    userPrompt?: string;
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
  /** 恢复 prepared 操作时不能猜测的目标会话交互模式。 */
  targetMode?: "default" | "plan" | "auto" | "yolo";
  stagingDirectory: string;
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

export class StorageOperationJournal {
  readonly directory: string;
  private readonly now: () => Date;
  private referenceIndex?: OperationReferenceIndex;

  constructor(options: OperationJournalOptions) {
    this.directory = resolvePicoPaths(resolve(options.workDir), {
      picoHome: options.picoHome,
    }).workspace.storageOperations;
    this.now = options.now ?? (() => new Date());
  }

  /** 把该 workspace journal 的 CAS roots 发布到共享 baseDir 的全局索引。 */
  attachReferenceIndex(baseDir: string): void {
    const next = new OperationReferenceIndex(baseDir);
    if (this.referenceIndex && this.referenceIndex.directory !== next.directory) {
      throw new Error("Storage operation journal is already attached to another reference index");
    }
    this.referenceIndex = next;
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
    if (hasCasBlobReferences(parsed) && !this.referenceIndex) {
      throw new Error(
        "CAS-bearing rewind operation must attach the shared operation reference index before creation",
      );
    }
    // 先发布全局 root：后续本地 journal 写入失败只会多保留 blob，
    // 不会留下已存在但 GC 无法看到的未完成 operation。
    await this.referenceIndex?.upsert(this.directory, parsed);
    await this.write(parsed);
    return parsed;
  }

  async get(operationId: string): Promise<StorageOperation | undefined> {
    const path = this.operationPath(operationId);
    try {
      const parsed = parseStorageOperation(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (!parsed) throw new Error(`Invalid storage operation journal: ${path}`);
      return parsed;
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async advance(input: {
    operationId: string;
    expectedVersion: number;
    nextState: StorageOperationState;
    error?: StorageOperationError;
  }): Promise<StorageOperation> {
    const current = await this.get(input.operationId);
    if (!current) throw new Error(`Storage operation not found: ${input.operationId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(
        `Storage operation version conflict: expected ${input.expectedVersion}, actual ${current.version}`,
      );
    }
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
    } satisfies StorageOperation;
    await this.write(next);
    // 状态推进时先落本地权威 journal，再更新全局索引。
    // 崩溃或写入失败会使索引更保守，不会过早回收。
    await this.referenceIndex?.upsert(this.directory, next);
    return next;
  }

  /** 人工 retry 只能恢复到 journal 记录的失败 phase，不能由调用方猜测。 */
  async retryNeedsAttention(input: StorageOperationDispositionInput): Promise<StorageOperation> {
    return this.withDispositionLease(input.operationId, async () => {
      const current = await this.getDispositionCandidate(input);
      const failedPhase = current.error?.phase;
      if (!failedPhase || !isRetryableOperationState(failedPhase)) {
        throw new Error(
          `Storage operation ${current.operationId} has no safe recorded phase to retry`,
        );
      }
      const next = structuredClone(current);
      next.version += 1;
      next.state = failedPhase;
      next.updatedAt = this.now().toISOString();
      next.dispositions = [
        ...(current.dispositions ?? []),
        createDisposition("retry", current, input.reason, next.updatedAt),
      ];
      delete next.error;
      await this.write(next);
      await this.referenceIndex?.upsert(this.directory, next);
      return next;
    });
  }

  /** 人工 abort 是不可逆终态；写入后全局 operation root 随状态一并释放。 */
  async abortNeedsAttention(input: StorageOperationDispositionInput): Promise<StorageOperation> {
    return this.withDispositionLease(input.operationId, async () => {
      const current = await this.getDispositionCandidate(input);
      const next = structuredClone(current);
      next.version += 1;
      next.state = "aborted";
      next.updatedAt = this.now().toISOString();
      next.dispositions = [
        ...(current.dispositions ?? []),
        createDisposition("abort", current, input.reason, next.updatedAt),
      ];
      await this.write(next);
      await this.referenceIndex?.upsert(this.directory, next);
      return next;
    });
  }

  async listUnfinished(): Promise<StorageOperation[]> {
    return (await this.list()).filter((operation) => !isTerminal(operation.state));
  }

  async listNeedsAttention(): Promise<StorageOperation[]> {
    return (await this.list()).filter((operation) => operation.state === "needs_attention");
  }

  /** Doctor / TUI handoff 使用的全量只读视图；损坏记录由 Doctor 单独报告。 */
  async list(): Promise<StorageOperation[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return [];
      throw error;
    }

    const operations: StorageOperation[] = [];
    for (const name of names.toSorted()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = parseStorageOperation(
          JSON.parse(await readFile(join(this.directory, name), "utf8")) as unknown,
        );
        if (parsed) operations.push(parsed);
      } catch {
        // Doctor reports malformed journals separately. Normal startup cannot guess their intent.
      }
    }
    return operations.toSorted(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
    );
  }

  private async write(operation: StorageOperation): Promise<void> {
    await writeJsonAtomic(this.operationPath(operation.operationId), operation);
  }

  private async getDispositionCandidate(
    input: StorageOperationDispositionInput,
  ): Promise<StorageOperation> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 2_000) {
      throw new Error("Storage operation disposition reason must contain 1-2000 characters");
    }
    const current = await this.get(input.operationId);
    if (!current) throw new Error(`Storage operation not found: ${input.operationId}`);
    if (current.version !== input.expectedVersion) {
      throw new Error(
        `Storage operation version conflict: expected ${input.expectedVersion}, actual ${current.version}`,
      );
    }
    if (current.state !== "needs_attention") {
      throw new Error(
        `Storage operation ${current.operationId} is ${current.state}, not needs_attention`,
      );
    }
    return current;
  }

  private async withDispositionLease<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    if (!SAFE_OPERATION_ID.test(operationId)) {
      throw new Error(`Invalid operation ID: ${operationId}`);
    }
    const operationDigest = createHash("sha256").update(operationId).digest("hex");
    const lease = await OwnerLease.acquire({
      leaseDirectory: join(this.directory, ".disposition-leases", operationDigest),
      ownerId: `operation-disposition:${operationId}:${process.pid}`,
    });
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }

  private operationPath(operationId: string): string {
    if (!SAFE_OPERATION_ID.test(operationId))
      throw new Error(`Invalid operation ID: ${operationId}`);
    return join(this.directory, `${operationId}.json`);
  }
}

function hasCasBlobReferences(operation: StorageOperation): boolean {
  return (
    operation.kind === "rewind" &&
    operation.files.some((file) => file.before.kind === "file" || file.after.kind === "file")
  );
}

export function isTerminalStorageOperation(state: StorageOperationState): boolean {
  return isTerminal(state);
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
    !isOptionalString(target["sourceMessageEventId"]) ||
    !isNonNegativeInteger(target["messageIndex"]) ||
    !isOptionalString(target["userPrompt"]) ||
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
  if (
    typeof value["sourceSessionId"] !== "string" ||
    typeof value["targetSessionId"] !== "string" ||
    (value["targetMode"] !== undefined &&
      value["targetMode"] !== "default" &&
      value["targetMode"] !== "yolo" &&
      value["targetMode"] !== "auto" &&
      value["targetMode"] !== "plan") ||
    typeof value["stagingDirectory"] !== "string" ||
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

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
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

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
