import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { TaskRegistry } from "../tasks/task-registry.js";

export type DelegationResultStatus = "completed" | "partial" | "error" | "timed_out" | "cancelled";

export type DelegationBatchStatus = Exclude<DelegationResultStatus, "cancelled"> | "cancelled";

export interface DelegationResult {
  taskIndex: number;
  status: DelegationResultStatus;
  summary?: string;
  /** 子任务探索期间被外部化的大型工具输出磁盘路径(均在 workDir 内,主 Agent 可 read_file 回查) */
  artifacts?: string[];
  error?: string;
  durationMs: number;
}

export interface DelegationBatchResult {
  /** 迁移期可选；运行时聚合器负责在所有新结果上填充。 */
  status?: DelegationBatchStatus;
  results: DelegationResult[];
  totalDurationMs: number;
  /** 为了遵守工具返回总预算而省略的 artifact 路径数。 */
  omittedArtifacts?: number;
  /** 极端大批次下为了遵守总预算而省略的结果数。 */
  omittedResults?: number;
}

export type DelegationCompletionPolicy = "required" | "optional" | "detached";

export type DelegationRecordStatus = "running" | DelegationBatchStatus;
export type DelegationTaskStatus =
  | "queued"
  | "running"
  | "done"
  | "partial"
  | "error"
  | "timed_out"
  | "cancelled";

export interface DelegationManagerOptions {
  maxConcurrentChildren?: number;
  maxAsyncChildren?: number;
  maxOutputSummaryChars?: number;
  taskRegistry?: TaskRegistry;
  onCompletion?: (completion: DelegationCompletionEnvelope) => void;
}

export interface DelegationCompletionEnvelope {
  completionSeq: number;
  completionPolicy: DelegationCompletionPolicy;
  status: Exclude<DelegationRecordStatus, "running">;
  outputSummary: string;
  error?: string;
}

export function formatDelegationCompletions(
  completions: readonly DelegationCompletionEnvelope[],
): string {
  const lines = completions.map((completion, index) => {
    const detail = completion.outputSummary || completion.error || "子代理未返回摘要";
    return `${index + 1}. ${completion.status}: ${detail}`;
  });
  return [
    "[SUBAGENT COMPLETION] 以下子代理已经收口。请吸收这些结果后继续推进；不要向用户暴露内部任务 ID。",
    ...lines,
  ].join("\n");
}

export interface DelegationTaskRuntimeInput {
  description?: string;
  toolUseId?: string;
  outputFile?: string;
}

export interface DelegationResumeInfo {
  kind: "delegate_task";
  taskId: string;
  delegationId: string;
  statusTool: "delegate_status";
  statusArgs: { delegation_id: string };
  canSendMessage: boolean;
}

export interface DelegationTaskSnapshot {
  taskId: string;
  delegationId: string;
  status: DelegationRecordStatus;
  completionPolicy: DelegationCompletionPolicy;
  taskStatus: DelegationTaskStatus;
  statusSnapshot: {
    status: DelegationTaskStatus;
    mappedFrom: DelegationRecordStatus;
    allowedStatuses: DelegationTaskStatus[];
  };
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  outputSummary: string;
  resume: DelegationResumeInfo;
  result?: DelegationBatchResult;
  error?: string;
}

interface DelegationRecord {
  id: string;
  taskId: string;
  status: DelegationRecordStatus;
  completionPolicy: DelegationCompletionPolicy;
  completionSeq?: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: DelegationBatchResult;
  error?: string;
  controller: AbortController;
  promise: Promise<void>;
}

export class DelegationManager {
  private readonly records = new Map<string, DelegationRecord>();
  private nextId = 1;
  private disposed = false;
  private disposePromise?: Promise<void>;

  readonly maxConcurrentChildren: number;
  private readonly maxAsyncChildren: number;
  private readonly maxOutputSummaryChars: number;
  private readonly onCompletion?: DelegationManagerOptions["onCompletion"];
  private nextCompletionSeq = 1;
  readonly taskRegistry?: TaskRegistry;

  constructor(options: DelegationManagerOptions = {}) {
    this.maxConcurrentChildren = options.maxConcurrentChildren ?? 3;
    this.maxAsyncChildren = options.maxAsyncChildren ?? 3;
    this.maxOutputSummaryChars = options.maxOutputSummaryChars ?? 2_000;
    this.taskRegistry = options.taskRegistry;
    this.onCompletion = options.onCompletion;
  }

  dispatch(
    runner: (signal: AbortSignal) => Promise<DelegationBatchResult>,
    taskInput: DelegationTaskRuntimeInput & {
      completionPolicy?: DelegationCompletionPolicy;
    } = {},
  ): {
    status: string;
    delegationId?: string;
    taskId?: string;
    snapshot?: DelegationTaskSnapshot;
    error?: string;
  } {
    if (this.disposed) {
      return { status: "rejected", error: "委派运行时已关闭" };
    }
    if (this.activeCount >= this.maxAsyncChildren) {
      return {
        status: "rejected",
        error: `后台委派数量已达上限 ${this.maxAsyncChildren}`,
      };
    }

    const now = Date.now();
    const completionPolicy = taskInput.completionPolicy ?? "required";
    const id = `delegation-${now}-${this.nextId}`;
    this.nextId++;
    const task = this.taskRegistry?.create("local_agent", {
      description: taskInput.description ?? "delegate_task",
      toolUseId: taskInput.toolUseId,
      outputFile: taskInput.outputFile,
      data: { delegationId: id, completionPolicy },
    });
    if (task) {
      this.taskRegistry?.start(task.taskId);
    }

    const controller = new AbortController();
    const record: DelegationRecord = {
      id,
      taskId: task?.taskId ?? id,
      status: "running",
      completionPolicy,
      startedAt: now,
      updatedAt: now,
      controller,
      promise: Promise.resolve(),
    };

    record.promise = Promise.resolve()
      .then(() => runner(controller.signal))
      .then((result) => {
        controller.signal.throwIfAborted();
        record.status = "completed";
        record.result = result;
        record.completedAt = Date.now();
        record.updatedAt = record.completedAt;
        this.taskRegistry?.complete(record.taskId, {
          data: { delegationId: id, completionPolicy, result },
        });
        this.publishCompletion(record);
      })
      .catch((err: unknown) => {
        record.status = controller.signal.aborted ? "cancelled" : "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        record.updatedAt = record.completedAt;
        if (record.status === "cancelled") {
          this.taskRegistry?.kill(record.taskId, record.error, {
            data: { delegationId: id, completionPolicy },
          });
        } else {
          this.taskRegistry?.fail(record.taskId, record.error, {
            data: { delegationId: id, completionPolicy },
          });
        }
        this.publishCompletion(record);
      });

    this.records.set(id, record);
    return {
      status: "dispatched",
      delegationId: id,
      taskId: record.taskId,
      snapshot: this.toSnapshot(record),
    };
  }

  snapshot(id: string): DelegationTaskSnapshot | { status: "not_found"; error: string } {
    const record = this.records.get(id);
    if (!record) {
      return { status: "not_found", error: `找不到委派任务: ${id}` };
    }

    return this.toSnapshot(record);
  }

  async wait(id: string): Promise<void> {
    await this.records.get(id)?.promise;
  }

  /** 禁止新委派，取消并等待所有已派发子任务真正收口。 */
  dispose(reason = "delegation runtime disposed"): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const running = [...this.records.values()].filter((record) => record.status === "running");
    for (const record of running) {
      record.controller.abort(new DOMException(reason, "AbortError"));
    }
    this.disposePromise = Promise.allSettled(running.map((record) => record.promise)).then(
      () => undefined,
    );
    return this.disposePromise;
  }

  private get activeCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "running") {
        count++;
      }
    }
    return count;
  }

  private toSnapshot(record: DelegationRecord): DelegationTaskSnapshot {
    const taskStatus = mapTaskStatus(record.status);
    return {
      taskId: record.taskId,
      delegationId: record.id,
      status: record.status,
      completionPolicy: record.completionPolicy,
      taskStatus,
      statusSnapshot: {
        status: taskStatus,
        mappedFrom: record.status,
        allowedStatuses: ["queued", "running", "done", "error", "cancelled"],
      },
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      outputSummary: this.outputSummary(record),
      resume: {
        kind: "delegate_task",
        taskId: record.taskId,
        delegationId: record.id,
        statusTool: "delegate_status",
        statusArgs: { delegation_id: record.id },
        canSendMessage: record.status !== "running",
      },
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  private outputSummary(record: DelegationRecord): string {
    if (record.result) {
      const lines = record.result.results.map((result) => {
        if (result.status === "completed") {
          return `task ${result.taskIndex} completed: ${result.summary ?? ""}`;
        }
        return `task ${result.taskIndex} error: ${result.error ?? ""}`;
      });
      return truncateSummary(lines.join("\n"), this.maxOutputSummaryChars);
    }
    if (record.error) {
      return truncateSummary(`error: ${record.error}`, this.maxOutputSummaryChars);
    }
    return "";
  }

  private publishCompletion(record: DelegationRecord): void {
    record.completionSeq ??= this.nextCompletionSeq++;
    if (record.completionPolicy === "detached") return;
    try {
      this.onCompletion?.(this.toCompletionEnvelope(record));
    } catch (error) {
      // 完成通知是 best-effort，监听端异常不能反向污染子代理的终态。
      void error;
    }
  }

  private toCompletionEnvelope(record: DelegationRecord): DelegationCompletionEnvelope {
    if (record.status === "running" || record.completionSeq === undefined) {
      throw new Error("Delegation completion is not settled");
    }
    return {
      completionSeq: record.completionSeq,
      completionPolicy: record.completionPolicy,
      status: record.status,
      outputSummary: this.outputSummary(record),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }
}

function mapTaskStatus(status: DelegationRecordStatus): DelegationTaskStatus {
  if (status === "completed") return "done";
  if (status === "error") return "error";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function truncateSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return marker.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - marker.length) + marker;
}

export class DelegateStatusTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly manager: DelegationManager) {}

  name(): string {
    return "delegate_status";
  }

  definition(): ToolDefinition {
    return {
      name: "delegate_status",
      description:
        "兼容性诊断工具：仅查询旧调用已经持有 delegation_id 的委派状态。新委派会自动交付结果，不要主动调用。",
      inputSchema: {
        type: "object",
        properties: {
          delegation_id: {
            type: "string",
            description: "delegate_task 返回的 delegationId。",
          },
        },
        required: ["delegation_id"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let delegationId: string;
    try {
      const input = JSON.parse(args) as { delegation_id?: string; delegationId?: string };
      delegationId = input.delegation_id ?? input.delegationId ?? "";
    } catch {
      throw new Error("解析 delegate_status 参数失败:需 JSON 格式 {delegation_id: string}");
    }

    if (!delegationId) {
      return JSON.stringify({ status: "error", error: "缺少 delegation_id 参数" });
    }

    return JSON.stringify(this.manager.snapshot(delegationId));
  }
}
