import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { TaskRegistry } from "../tasks/task-registry.js";
import { SUBAGENT_OUTPUT_BUDGET } from "./subagent-budget.js";

export type DelegationResultStatus = "completed" | "partial" | "error" | "timed_out" | "cancelled";

export type DelegationBatchStatus = DelegationResultStatus;

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
  /** 只由聚合器根据 children 终态生成，调用方不能用 resolved 代替成功。 */
  status: DelegationBatchStatus;
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
  /** Runtime completion_outbox 与 Session event 共用的稳定幂等键。 */
  completionId: string;
  jobId: string;
  ownerSessionId?: string;
  completionSeq: number;
  /** 本次 completion 精确对应的 TUI 活动；只用于宿主生命周期关联。 */
  activityIds: readonly string[];
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
  const statuses = new Set(completions.map((completion) => completion.status));
  const guidance = [
    ...(statuses.has("completed") || statuses.has("partial")
      ? ["对 completed/partial：吸收已保留结果并统一总结，不重复执行已有范围。"]
      : []),
    ...(statuses.has("error") || statuses.has("timed_out") || statuses.has("cancelled")
      ? [
          "对 error/timed_out/cancelled：优先缩小失败范围，最多重新委派一次；不要重做已完成范围，也不要改为大范围自行阅读项目。",
        ]
      : []),
  ];
  return [
    "[SUBAGENT COMPLETION] 以下子代理已经收口。请吸收这些结果后继续推进；不要向用户暴露内部任务 ID。",
    ...guidance,
    ...lines,
  ].join("\n");
}

export interface DelegationTaskRuntimeInput {
  description?: string;
  toolUseId?: string;
  outputFile?: string;
  activityIds?: readonly string[];
  ownerSessionId?: string;
  childSessionId?: string;
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
  ownerSessionId?: string;
  activityIds: readonly string[];
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
    this.maxOutputSummaryChars =
      options.maxOutputSummaryChars ?? SUBAGENT_OUTPUT_BUDGET.batch.hardMax;
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
      data: {
        delegationId: id,
        completionPolicy,
        activityIds: [...(taskInput.activityIds ?? [])],
        ...(taskInput.ownerSessionId ? { ownerSessionId: taskInput.ownerSessionId } : {}),
        ...(taskInput.childSessionId ? { childSessionId: taskInput.childSessionId } : {}),
      },
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
      ...(taskInput.ownerSessionId ? { ownerSessionId: taskInput.ownerSessionId } : {}),
      activityIds: Object.freeze([...(taskInput.activityIds ?? [])]),
      startedAt: now,
      updatedAt: now,
      controller,
      promise: Promise.resolve(),
    };

    record.promise = Promise.resolve()
      .then(() => runner(controller.signal))
      .then((result) => {
        const legacyResultWithoutStatus = result.status === undefined;
        const normalizedResult = normalizeDelegationBatchResult(result);
        if (
          controller.signal.aborted &&
          normalizedResult.status !== "partial" &&
          normalizedResult.status !== "cancelled" &&
          normalizedResult.status !== "timed_out"
        ) {
          throw controller.signal.reason ?? new DOMException("delegation aborted", "AbortError");
        }
        record.status = normalizedResult.status;
        record.result = normalizedResult;
        record.error = batchFailureMessage(normalizedResult);
        record.completedAt = Date.now();
        record.updatedAt = record.completedAt;
        record.completionSeq ??= this.nextCompletionSeq++;
        this.settleTaskRegistry(record, legacyResultWithoutStatus ? result : normalizedResult);
        this.publishCompletion(record);
      })
      .catch((err: unknown) => {
        record.status = delegationStatusFromError(err, controller.signal);
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        record.updatedAt = record.completedAt;
        record.completionSeq ??= this.nextCompletionSeq++;
        this.settleTaskRegistry(record);
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
        allowedStatuses: [
          "queued",
          "running",
          "done",
          "partial",
          "error",
          "timed_out",
          "cancelled",
        ],
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
      const orderedResults = record.result.results.toSorted(
        (left, right) =>
          delegationCompletionPriority(left) - delegationCompletionPriority(right) ||
          left.taskIndex - right.taskIndex,
      );
      const hasChildFailureDetail = orderedResults.some((result) => result.error?.trim());
      const lines = [
        ...(record.error && !hasChildFailureDetail
          ? [`batch ${record.status}: ${record.error}`]
          : []),
        ...orderedResults.map(formatDelegationCompletionResult),
        ...(record.result.omittedResults
          ? [`omittedResults: ${record.result.omittedResults}`]
          : []),
        ...(record.result.omittedArtifacts
          ? [`omittedArtifacts: ${record.result.omittedArtifacts}`]
          : []),
      ];
      return truncateSummary(lines.join("\n"), this.maxOutputSummaryChars);
    }
    if (record.error) {
      return truncateSummary(`error: ${record.error}`, this.maxOutputSummaryChars);
    }
    return "";
  }

  private publishCompletion(record: DelegationRecord): void {
    if (record.completionPolicy === "detached" && record.status === "completed") return;
    record.completionSeq ??= this.nextCompletionSeq++;
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
      completionId: `completion:${record.taskId}:1`,
      jobId: record.taskId,
      ...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId } : {}),
      completionSeq: record.completionSeq,
      activityIds: record.activityIds,
      completionPolicy: record.completionPolicy,
      status: record.status,
      outputSummary: this.outputSummary(record),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  private settleTaskRegistry(
    record: DelegationRecord,
    registryResult: DelegationBatchResult | undefined = record.result,
  ): void {
    if (!this.taskRegistry || record.status === "running") return;
    const data = {
      delegationId: record.id,
      completionPolicy: record.completionPolicy,
      aggregateStatus: record.status,
      completionId: `completion:${record.taskId}:1`,
      ...(record.completionSeq !== undefined ? { completionSeq: record.completionSeq } : {}),
      activityIds: [...record.activityIds],
      outputSummary: this.outputSummary(record),
      ...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId } : {}),
      ...(record.completionPolicy === "required" ||
      (record.completionPolicy === "detached" && record.status === "completed")
        ? { internalCompletion: true }
        : {}),
      ...(registryResult !== undefined ? { result: registryResult } : {}),
    };
    if (record.status === "completed") {
      this.taskRegistry.complete(record.taskId, { data });
      return;
    }
    if (record.status === "cancelled") {
      this.taskRegistry.kill(record.taskId, record.error ?? "delegation cancelled", { data });
      return;
    }
    this.taskRegistry.fail(record.taskId, record.error ?? `delegation ended as ${record.status}`, {
      data,
    });
  }
}

function mapTaskStatus(status: DelegationRecordStatus): DelegationTaskStatus {
  if (status === "completed") return "done";
  if (status === "partial") return "partial";
  if (status === "error") return "error";
  if (status === "timed_out") return "timed_out";
  if (status === "cancelled") return "cancelled";
  return "running";
}

/**
 * 批次状态只由 children 决定。只要保留了部分有效结果就返回 partial；
 * 全失败时按 error > timed_out > cancelled 的可处理优先级收口。
 */
export function aggregateDelegationStatus(
  results: readonly DelegationResult[],
): DelegationBatchStatus {
  if (results.length === 0) return "error";
  if (results.every((result) => result.status === "completed")) return "completed";
  if (results.some((result) => result.status === "completed" || result.status === "partial")) {
    return "partial";
  }
  if (results.some((result) => result.status === "error")) return "error";
  if (results.some((result) => result.status === "timed_out")) return "timed_out";
  return "cancelled";
}

export function normalizeDelegationBatchResult(
  result: Omit<DelegationBatchResult, "status"> & { status?: DelegationBatchStatus },
): DelegationBatchResult {
  const preservedOmittedStatus =
    result.results.length === 0 && (result.omittedResults ?? 0) > 0 && result.status !== undefined
      ? result.status
      : undefined;
  return {
    ...result,
    status: preservedOmittedStatus ?? aggregateDelegationStatus(result.results),
  };
}

function delegationCompletionPriority(result: DelegationResult): number {
  if (result.status === "error" || result.status === "timed_out" || result.status === "cancelled") {
    return 0;
  }
  if (result.status === "partial") return 1;
  if ((result.artifacts?.length ?? 0) > 0) return 2;
  return 3;
}

function formatDelegationCompletionResult(result: DelegationResult): string {
  const lines = [`task ${result.taskIndex} ${result.status}:`];
  if (result.artifacts?.length) {
    lines.push("artifacts:", ...result.artifacts.map((artifact) => `- ${artifact}`));
  }
  const detail = result.error ?? result.summary;
  if (detail) lines.push(detail);
  return lines.join("\n");
}

function batchFailureMessage(result: DelegationBatchResult): string | undefined {
  if (result.status === "completed") return undefined;
  const firstFailure = result.results.find((child) => child.error?.trim());
  return firstFailure?.error
    ? `委派批次以 ${result.status} 收口: ${firstFailure.error}`
    : `委派批次以 ${result.status} 收口`;
}

function delegationStatusFromError(
  error: unknown,
  signal?: AbortSignal,
): Extract<DelegationBatchStatus, "error" | "timed_out" | "cancelled"> {
  const reason = signal?.aborted ? signal.reason : error;
  if (reason instanceof Error && reason.name === "TimeoutError") return "timed_out";
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return "cancelled";
  }
  return "error";
}

function truncateSummary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n[truncated]";
  if (maxChars <= marker.length) return marker.slice(0, Math.max(0, maxChars));
  return sliceUtf16Safe(value, maxChars - marker.length) + marker;
}

function sliceUtf16Safe(value: string, maxChars: number): string {
  let end = Math.max(0, Math.min(value.length, maxChars));
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return value.slice(0, end);
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
