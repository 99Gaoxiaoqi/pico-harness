import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";

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

interface StorageOperationBase {
  schemaVersion: typeof STORAGE_OPERATION_VERSION;
  operationId: string;
  version: number;
  state: StorageOperationState;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  error?: StorageOperationError;
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
  | Omit<RewindStorageOperation, keyof StorageOperationBase | "kind"> & {
      kind: "rewind";
      sessionId: string;
      operationId?: string;
    }
  | Omit<ForkStorageOperation, keyof StorageOperationBase | "kind"> & {
      kind: "fork";
      sessionId: string;
      operationId?: string;
    };

export interface OperationJournalOptions {
  workDir: string;
  now?: () => Date;
}

export class StorageOperationJournal {
  readonly directory: string;
  private readonly now: () => Date;

  constructor(options: OperationJournalOptions) {
    this.directory = join(resolve(options.workDir), ".claw", "storage-operations");
    this.now = options.now ?? (() => new Date());
  }

  async create(input: NewStorageOperation): Promise<StorageOperation> {
    const operationId = input.operationId ?? randomUUID();
    if (!SAFE_OPERATION_ID.test(operationId)) throw new Error(`Invalid operation ID: ${operationId}`);
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
      throw new Error(`Invalid storage operation transition: ${current.state} -> ${input.nextState}`);
    }
    const next = {
      ...current,
      version: current.version + 1,
      state: input.nextState,
      updatedAt: this.now().toISOString(),
      ...(input.error ? { error: input.error } : {}),
    } satisfies StorageOperation;
    await this.write(next);
    return next;
  }

  async listUnfinished(): Promise<StorageOperation[]> {
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
        if (parsed && !isTerminal(parsed.state)) operations.push(parsed);
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

  private operationPath(operationId: string): string {
    if (!SAFE_OPERATION_ID.test(operationId)) throw new Error(`Invalid operation ID: ${operationId}`);
    return join(this.directory, `${operationId}.json`);
  }
}

export function isTerminalStorageOperation(state: StorageOperationState): boolean {
  return isTerminal(state);
}

function canTransition(from: StorageOperationState, to: StorageOperationState): boolean {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  if (to === "needs_attention" || to === "aborted") return true;
  switch (from) {
    case "prepared":
      return to === "workspace_applied" || to === "session_committed" || to === "sidecars_committed";
    case "workspace_applied":
      return to === "session_committed" || to === "sidecars_committed";
    case "session_committed":
      return to === "sidecars_committed";
    case "sidecars_committed":
      return to === "completed";
    case "completed":
    case "aborted":
    case "needs_attention":
      return false;
  }
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
    !isOperationError(value["error"])
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
