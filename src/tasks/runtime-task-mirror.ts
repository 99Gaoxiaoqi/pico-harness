import { logger } from "../observability/logger.js";
import { JobService } from "./job-service.js";
import {
  TaskRegistry,
  type TaskSnapshot,
  type TaskStatus,
  type TaskType,
} from "./task-registry.js";
import type {
  JobCompletionPolicy,
  JobExecutionClass,
  JobRecord,
  JobStatus,
  JobWithAttempts,
  TerminalJobStatus,
} from "./runtime-types.js";

export interface RuntimeTaskMirrorOptions {
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
}

interface HeartbeatHandle {
  leaseEpoch: number;
  timer: ReturnType<typeof setInterval>;
}

/**
 * Compatibility bridge while Background/Delegation/Worktree still publish TaskRegistry snapshots.
 * RuntimeStore is durable; TaskRegistry remains the current-process presentation facade.
 */
export class RuntimeTaskMirror {
  private readonly unsubscribe: () => void;
  private readonly heartbeats = new Map<string, HeartbeatHandle>();
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private closed = false;

  constructor(
    registry: TaskRegistry,
    private readonly jobs: JobService,
    options: RuntimeTaskMirrorOptions = {},
  ) {
    this.leaseTtlMs = positiveDuration(options.leaseTtlMs ?? 30_000, "leaseTtlMs");
    this.heartbeatIntervalMs = positiveDuration(
      options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseTtlMs / 3)),
      "heartbeatIntervalMs",
    );
    if (this.heartbeatIntervalMs >= this.leaseTtlMs) {
      throw new Error("heartbeatIntervalMs 必须小于 leaseTtlMs");
    }
    this.unsubscribe = registry.subscribe((snapshot) => this.mirror(snapshot));
    for (const snapshot of registry.list()) this.mirror(snapshot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const taskId of this.heartbeats.keys()) this.stopHeartbeat(taskId);
  }

  private mirror(snapshot: TaskSnapshot): void {
    if (this.closed) return;
    try {
      let durable = this.jobs.get(snapshot.taskId);
      if (!durable) {
        this.jobs.dispatch({
          jobId: snapshot.taskId,
          type: snapshot.type,
          executionClass: executionClass(),
          completionPolicy: completionPolicy(snapshot),
          description: snapshot.description,
          ...(stringData(snapshot, "ownerSessionId")
            ? { ownerSessionId: stringData(snapshot, "ownerSessionId") }
            : {}),
          ...(stringData(snapshot, "childSessionId")
            ? { childSessionId: stringData(snapshot, "childSessionId") }
            : {}),
          ...(snapshot.toolUseId ? { toolUseId: snapshot.toolUseId } : {}),
          ...(snapshot.outputFile ? { outputPath: snapshot.outputFile } : {}),
          data: taskPayload(snapshot),
        });
        durable = this.jobs.get(snapshot.taskId);
      }
      if (!durable) throw new Error(`无法创建持久任务 ${snapshot.taskId}`);

      if (snapshot.status === "running" && durable.job.status === "queued") {
        const started = this.jobs.start(snapshot.taskId, {
          expectedVersion: durable.job.version,
          ...(snapshot.outputFile ? { outputPath: snapshot.outputFile } : {}),
          leaseTtlMs: this.leaseTtlMs,
        });
        this.startHeartbeat(snapshot.taskId, started.lease.leaseEpoch);
        return;
      }
      if (snapshot.status === "running" && durable.job.status === "running") {
        const attempt = durable.attempts.at(-1);
        if (attempt?.ownerId === this.jobs.ownerId) {
          this.startHeartbeat(snapshot.taskId, attempt.leaseEpoch);
        }
        return;
      }
      if (!isLegacyTerminal(snapshot.status) || isDurableTerminal(durable.job.status)) return;

      durable = ensureAttempt(this.jobs, durable, snapshot, this.leaseTtlMs);
      const attempt = durable.attempts.at(-1);
      if (!attempt || durable.job.status !== "running") return;
      this.stopHeartbeat(snapshot.taskId);
      this.jobs.terminal({
        jobId: durable.job.jobId,
        attemptId: attempt.attemptId,
        status: terminalStatus(snapshot),
        expectedJobVersion: durable.job.version,
        expectedAttemptVersion: attempt.version,
        leaseEpoch: attempt.leaseEpoch,
        completionId:
          stringData(snapshot, "completionId") ??
          `completion:${durable.job.jobId}:${attempt.attemptNumber}`,
        outputOffset: snapshot.outputOffset,
        ...(snapshot.error ? { error: snapshot.error } : {}),
        result: terminalResult(snapshot),
        completionPayload: terminalPayload(snapshot, durable.job.ownerSessionId),
        ...(snapshot.data?.["internalCompletion"] === true
          ? { completionAlreadyDelivered: true }
          : {}),
      });
    } catch (error) {
      // SQLite 是权威控制面：不允许 Registry/TaskStore 在持久化失败后
      // 继续装作成功。让同步调用方看到失败，同时保留诊断日志。
      logger.error(
        { taskId: snapshot.taskId, status: snapshot.status, error: String(error) },
        "[runtime-store] 同步 TaskRegistry 状态失败",
      );
      throw error;
    }
  }

  private startHeartbeat(taskId: string, leaseEpoch: number): void {
    const existing = this.heartbeats.get(taskId);
    if (existing?.leaseEpoch === leaseEpoch) return;
    this.stopHeartbeat(taskId);
    const timer = setInterval(() => {
      try {
        this.jobs.heartbeat(taskId, leaseEpoch, this.leaseTtlMs);
      } catch (error) {
        this.stopHeartbeat(taskId);
        logger.warn(
          { taskId, leaseEpoch, error: String(error) },
          "[runtime-store] 任务 heartbeat 失败，已停止续租",
        );
      }
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    this.heartbeats.set(taskId, { leaseEpoch, timer });
  }

  stopHeartbeat(taskId: string): void {
    const heartbeat = this.heartbeats.get(taskId);
    if (!heartbeat) return;
    clearInterval(heartbeat.timer);
    this.heartbeats.delete(taskId);
  }
}

function ensureAttempt(
  jobs: JobService,
  durable: NonNullable<ReturnType<JobService["get"]>>,
  snapshot: TaskSnapshot,
  leaseTtlMs: number,
): NonNullable<ReturnType<JobService["get"]>> {
  if (durable.job.status !== "queued") return durable;
  jobs.start(durable.job.jobId, {
    expectedVersion: durable.job.version,
    ...(snapshot.outputFile ? { outputPath: snapshot.outputFile } : {}),
    leaseTtlMs,
  });
  const started = jobs.get(durable.job.jobId);
  if (!started) throw new Error(`持久任务 ${durable.job.jobId} 启动后消失`);
  return started;
}

function executionClass(): JobExecutionClass {
  // 当前 executor 都没有可持久 resume contract。未来只有在生产者明确标记并
  // 实现恢复适配器后，才允许进入 recoverable 车道。
  return "host_bound";
}

function completionPolicy(snapshot: TaskSnapshot): JobCompletionPolicy {
  const candidate = snapshot.data?.["completionPolicy"];
  if (candidate === "required" || candidate === "optional" || candidate === "detached") {
    return candidate;
  }
  return defaultCompletionPolicy(snapshot.type);
}

function defaultCompletionPolicy(type: TaskType): JobCompletionPolicy {
  return type === "local_bash" || type === "monitor_mcp" ? "detached" : "required";
}

function terminalStatus(snapshot: TaskSnapshot): TerminalJobStatus {
  const explicit = snapshot.data?.["terminalStatus"];
  if (isTerminalStatus(explicit)) return explicit;
  if (snapshot.status === "completed") return "succeeded";
  if (snapshot.status === "killed") return "cancelled";
  return "failed";
}

function taskPayload(snapshot: TaskSnapshot): Record<string, unknown> {
  return {
    ...(snapshot.data ?? {}),
    legacyTask: {
      type: snapshot.type,
      startTime: snapshot.startTime,
      outputOffset: snapshot.outputOffset,
      notified: snapshot.notified,
    },
  };
}

/** 从 runtime.sqlite 权威事实生成进程内 TaskRegistry 兼容投影。 */
export function materializeRuntimeTaskSnapshots(jobs: JobService): TaskSnapshot[] {
  return jobs.list().map((job) => {
    const durable = jobs.get(job.jobId);
    if (!durable) throw new Error(`持久任务 ${job.jobId} 在投影期间消失`);
    return materializeRuntimeTaskSnapshot(durable);
  });
}

export function materializeRuntimeTaskSnapshot(durable: JobWithAttempts): TaskSnapshot {
  const { job } = durable;
  const attempt = durable.attempts.at(-1);
  const legacyTask = recordData(job.data, "legacyTask");
  const legacyTaskStore = recordData(job.data, "legacyTaskStore");
  const data: Record<string, unknown> = {
    ...(job.data ?? {}),
    ...(attempt?.result ?? {}),
    runtimeStatus: job.status,
    runtimeVersion: job.version,
    executionClass: job.executionClass,
    completionPolicy: job.completionPolicy,
    ...(job.ownerSessionId ? { ownerSessionId: job.ownerSessionId } : {}),
    ...(job.childSessionId ? { childSessionId: job.childSessionId } : {}),
    ...(attempt ? { attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber } : {}),
  };
  return {
    taskId: job.jobId,
    type: taskTypeFromJob(job, legacyTask),
    status: taskStatusFromJob(job.status),
    description: job.description,
    startTime: finiteNumber(legacyTask?.["startTime"]) ?? job.createdAt,
    outputOffset:
      attempt?.outputOffset ??
      nonNegativeInteger(legacyTask?.["outputOffset"]) ??
      nonNegativeInteger(legacyTaskStore?.["outputOffset"]) ??
      0,
    notified:
      booleanValue(legacyTask?.["notified"]) ??
      booleanValue(legacyTaskStore?.["notified"]) ??
      false,
    ...(job.toolUseId ? { toolUseId: job.toolUseId } : {}),
    ...((attempt?.outputPath ?? job.outputPath)
      ? { outputFile: attempt?.outputPath ?? job.outputPath }
      : {}),
    ...(job.terminalAt !== undefined ? { endTime: job.terminalAt } : {}),
    ...((job.error ?? attempt?.error) ? { error: job.error ?? attempt?.error } : {}),
    data,
  };
}

function taskStatusFromJob(status: JobStatus): TaskStatus {
  if (status === "queued") return "pending";
  if (status === "running") return "running";
  if (status === "succeeded") return "completed";
  if (status === "cancelled") return "killed";
  return "failed";
}

function taskTypeFromJob(
  job: JobRecord,
  legacyTask: Record<string, unknown> | undefined,
): TaskType {
  const legacyType = legacyTask?.["type"];
  if (isTaskType(legacyType)) return legacyType;
  if (isTaskType(job.type)) return job.type;
  return job.type === "worker" ? "local_agent" : "local_workflow";
}

function isTaskType(value: unknown): value is TaskType {
  return (
    value === "local_bash" ||
    value === "local_agent" ||
    value === "remote_agent" ||
    value === "local_workflow" ||
    value === "monitor_mcp"
  );
}

function recordData(
  data: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = data?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function terminalResult(snapshot: TaskSnapshot): Record<string, unknown> {
  return {
    legacyStatus: snapshot.status,
    ...(snapshot.data ?? {}),
  };
}

function terminalPayload(
  snapshot: TaskSnapshot,
  ownerSessionId: string | undefined,
): Record<string, unknown> {
  const aggregateStatus = snapshot.data?.["aggregateStatus"];
  const completionId = stringData(snapshot, "completionId");
  const activityIds = snapshot.data?.["activityIds"];
  const outputSummary = snapshot.data?.["outputSummary"];
  const completionPolicy = completionPolicyFromData(snapshot);
  return {
    description: snapshot.description,
    legacyStatus: snapshot.status,
    outputOffset: snapshot.outputOffset,
    ...(completionId
      ? {
          delegationCompletion: {
            completionId,
            jobId: snapshot.taskId,
            ...(ownerSessionId ? { ownerSessionId } : {}),
            completionSeq: numericData(snapshot, "completionSeq") ?? 0,
            activityIds: Array.isArray(activityIds)
              ? activityIds.filter((value): value is string => typeof value === "string")
              : [],
            completionPolicy,
            status: isDelegationTerminalStatus(aggregateStatus)
              ? aggregateStatus
              : delegationStatusFromSnapshot(snapshot),
            outputSummary: typeof outputSummary === "string" ? outputSummary : "",
            ...(snapshot.error ? { error: snapshot.error } : {}),
          },
        }
      : {}),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(snapshot.data ? { data: snapshot.data } : {}),
  };
}

function completionPolicyFromData(snapshot: TaskSnapshot): JobCompletionPolicy {
  return completionPolicy(snapshot);
}

function numericData(snapshot: TaskSnapshot, key: string): number | undefined {
  const value = snapshot.data?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function isDelegationTerminalStatus(
  value: unknown,
): value is "completed" | "partial" | "error" | "timed_out" | "cancelled" {
  return (
    value === "completed" ||
    value === "partial" ||
    value === "error" ||
    value === "timed_out" ||
    value === "cancelled"
  );
}

function delegationStatusFromSnapshot(snapshot: TaskSnapshot): "completed" | "error" | "cancelled" {
  if (snapshot.status === "completed") return "completed";
  if (snapshot.status === "killed") return "cancelled";
  return "error";
}

function stringData(snapshot: TaskSnapshot, key: string): string | undefined {
  const value = snapshot.data?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTerminalStatus(value: unknown): value is TerminalJobStatus {
  return (
    value === "succeeded" ||
    value === "partial" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正数`);
  return value;
}

function isLegacyTerminal(
  status: TaskStatus,
): status is Extract<TaskStatus, "completed" | "failed" | "killed"> {
  return status === "completed" || status === "failed" || status === "killed";
}

function isDurableTerminal(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "partial" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
