import { createHash } from "node:crypto";
import type {
  RecoverableTaskAdapterIdentity,
  TaskRunEventEntry,
  TaskRunProjection,
} from "./task-run-contract.js";

/**
 * TaskRun 存储的共享契约(票 09,JSONL 纪元退役)。
 *
 * 选项/结果/快照类型、错误类与输入哈希在 JSONL 与 SQLite 两代 store 间保持同名
 * 同形;旧实现(src/tasks/task-run-store.ts)删除后,契约落位于此,
 * SqliteTaskRunStore 与全部消费方从这里导入,消费者签名零漂移。
 */

export interface TaskRunStoreOptions {
  /** Canonical Pico workspace state root holding pico.sqlite. */
  readonly storageRoot: string;
  readonly now?: () => Date;
}

export interface InitializeTaskRunOptions {
  readonly taskRunId: string;
  readonly workDir: string;
  /** Optional assertion; the persisted header always uses the Store's verified root identity. */
  readonly storageRootId?: string;
  readonly adapter: RecoverableTaskAdapterIdentity;
  readonly maxAttempts: number;
  readonly now?: () => Date;
}

export interface AppendTaskRunBatchOptions {
  /** Stable caller-supplied transaction identity for crash-safe request replay. */
  readonly transactionId?: string;
  /** Optional compare-and-swap boundary checked in the same write transaction. */
  readonly expectedRevision?: number;
  readonly now?: () => Date;
}

export interface TaskRunAppendResult {
  readonly inserted: boolean;
  readonly entry: TaskRunEventEntry;
  readonly revision: number;
  readonly transactionId: string;
}

export interface TaskRunSnapshot {
  readonly projection: TaskRunProjection;
  readonly events: readonly TaskRunEventEntry[];
}

export interface TaskRunStoreInspection {
  readonly projections: readonly TaskRunProjection[];
  readonly staleManifestPaths: readonly string[];
  readonly storageRootMismatches: readonly TaskRunStorageRootMismatch[];
}

export interface TaskRunStorageRootMismatch {
  readonly taskRunId: string;
  /** SQLite 纪元指向 pico.sqlite(事实所在处);字段名保留以避免消费方漂移。 */
  readonly ledgerPath: string;
  readonly taskRunStorageRootId: string;
  readonly currentStorageRootId: string;
}

export class TaskRunStoreIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskRunStoreIntegrityError";
  }
}

export class TaskRunStoreRevisionConflictError extends TaskRunStoreIntegrityError {
  constructor(readonly projection: TaskRunProjection) {
    super(`TaskRun ${projection.header.taskRunId} revision changed to ${projection.revision}`);
    this.name = "TaskRunStoreRevisionConflictError";
  }
}

export function hashTaskRunInput(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** 逐字节照抄旧实现的 canonical 编码——inputHash 已持久化在 task_runs 行,算法不可漂移。 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TaskRunStoreIntegrityError("TaskRun JSON contains a non-finite number");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TaskRunStoreIntegrityError("TaskRun JSON contains a non-plain object");
      }
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    }
    default:
      throw new TaskRunStoreIntegrityError(
        `TaskRun JSON contains unsupported ${typeof value} data`,
      );
  }
}
