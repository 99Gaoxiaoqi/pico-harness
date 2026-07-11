import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "../observability/logger.js";
import {
  TaskRegistry,
  type RestoreTasksOptions,
  type RestoreTasksResult,
  type TaskSnapshot,
  type TaskStatus,
  type TaskType,
} from "./task-registry.js";

const TASK_STORE_VERSION = 1;

interface TaskStoreFile {
  version: typeof TASK_STORE_VERSION;
  tasks: TaskSnapshot[];
}

export type TaskStoreDiagnosticCode =
  | "read_failed"
  | "invalid_file"
  | "invalid_task"
  | "duplicate_task_id"
  | "write_failed";

export interface TaskStoreDiagnostic {
  code: TaskStoreDiagnosticCode;
  message: string;
  taskId?: string;
  cause?: unknown;
}

export interface TaskStoreLoadResult extends RestoreTasksResult {
  diagnostics: TaskStoreDiagnostic[];
}

export interface TaskStoreOptions {
  filePath: string;
  restore?: RestoreTasksOptions;
}

/**
 * Durable TaskRegistry snapshot storage.
 *
 * All filesystem failures are recorded as diagnostics and deliberately kept
 * out of the agent control flow. Registry state always remains usable in
 * memory, even when the durable file is missing, malformed, or unwritable.
 */
export class TaskStore {
  private readonly filePath: string;
  private readonly restoreOptions: RestoreTasksOptions;
  private readonly diagnosticLog: TaskStoreDiagnostic[] = [];
  private unsubscribe?: () => void;
  private boundRegistry?: TaskRegistry;
  private temporaryFileSequence = 0;

  constructor(options: TaskStoreOptions | string) {
    this.filePath = typeof options === "string" ? options : options.filePath;
    this.restoreOptions = typeof options === "string" ? {} : (options.restore ?? {});
  }

  get diagnostics(): readonly TaskStoreDiagnostic[] {
    return this.diagnosticLog.map((diagnostic) => ({ ...diagnostic }));
  }

  /** Load a valid subset and restore it into the supplied registry. */
  loadInto(registry: TaskRegistry): TaskStoreLoadResult {
    const diagnosticsBefore = this.diagnosticLog.length;
    const snapshots = this.readSnapshots();
    const restored = registry.restore(snapshots, this.restoreOptions);

    for (const taskId of restored.duplicateTaskIds) {
      this.record({
        code: "duplicate_task_id",
        message: `忽略重复任务 ID: ${taskId}`,
        taskId,
      });
    }

    return {
      ...restored,
      diagnostics: this.diagnosticLog
        .slice(diagnosticsBefore)
        .map((diagnostic) => ({ ...diagnostic })),
    };
  }

  /** Subscribe to registry changes and atomically persist every new snapshot. */
  bind(registry: TaskRegistry): void {
    if (this.boundRegistry === registry && this.unsubscribe) return;
    this.close();
    this.boundRegistry = registry;
    this.unsubscribe = registry.subscribe(() => {
      this.persist(registry.list());
    });
    this.persist(registry.list());
  }

  /** Flush the latest state and stop observing the registry. */
  close(): void {
    const registry = this.boundRegistry;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.boundRegistry = undefined;
    if (registry) this.persist(registry.list());
  }

  private readSnapshots(): TaskSnapshot[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") return [];
      this.record({
        code: "read_failed",
        message: `读取任务状态失败: ${errorMessage(error)}`,
        cause: error,
      });
      return [];
    }

    if (
      !isRecord(parsed) ||
      parsed.version !== TASK_STORE_VERSION ||
      !Array.isArray(parsed.tasks)
    ) {
      this.record({
        code: "invalid_file",
        message: `任务状态文件格式无效（期望 version=${TASK_STORE_VERSION}）`,
      });
      return [];
    }

    const snapshots: TaskSnapshot[] = [];
    const seen = new Set<string>();
    for (const candidate of parsed.tasks) {
      const snapshot = parseTaskSnapshot(candidate);
      if (!snapshot) {
        this.record({ code: "invalid_task", message: "忽略格式无效的任务快照" });
        continue;
      }
      if (seen.has(snapshot.taskId)) {
        this.record({
          code: "duplicate_task_id",
          message: `忽略重复任务 ID: ${snapshot.taskId}`,
          taskId: snapshot.taskId,
        });
        continue;
      }
      seen.add(snapshot.taskId);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  private persist(tasks: readonly TaskSnapshot[]): void {
    const directory = dirname(this.filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${this.temporaryFileSequence++}.tmp`,
    );
    const file: TaskStoreFile = {
      version: TASK_STORE_VERSION,
      tasks: tasks.map((task) => structuredClone(task)),
    };

    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file might not have been created.
      }
      this.record({
        code: "write_failed",
        message: `持久化任务状态失败: ${errorMessage(error)}`,
        cause: error,
      });
    }
  }

  private record(diagnostic: TaskStoreDiagnostic): void {
    this.diagnosticLog.push(diagnostic);
    logger.warn(
      { code: diagnostic.code, taskId: diagnostic.taskId, error: diagnostic.cause },
      diagnostic.message,
    );
  }
}

const TASK_TYPES = new Set<TaskType>([
  "local_bash",
  "local_agent",
  "remote_agent",
  "local_workflow",
  "monitor_mcp",
]);
const TASK_STATUSES = new Set<TaskStatus>(["pending", "running", "completed", "failed", "killed"]);

function parseTaskSnapshot(value: unknown): TaskSnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value.taskId !== "string" || value.taskId.length === 0) return null;
  if (typeof value.type !== "string" || !TASK_TYPES.has(value.type as TaskType)) return null;
  if (typeof value.status !== "string" || !TASK_STATUSES.has(value.status as TaskStatus))
    return null;
  if (typeof value.description !== "string") return null;
  if (!isFiniteNumber(value.startTime)) return null;
  if (!isNonNegativeInteger(value.outputOffset)) return null;
  if (typeof value.notified !== "boolean") return null;
  if (value.endTime !== undefined && !isFiniteNumber(value.endTime)) return null;
  if (value.toolUseId !== undefined && typeof value.toolUseId !== "string") return null;
  if (value.outputFile !== undefined && typeof value.outputFile !== "string") return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  if (value.data !== undefined && !isRecord(value.data)) return null;

  return structuredClone(value) as unknown as TaskSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function getErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
