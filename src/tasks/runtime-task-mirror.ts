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
  TerminalJobStatus,
} from "./runtime-types.js";

/**
 * Compatibility bridge while Background/Delegation/Worktree still publish TaskRegistry snapshots.
 * RuntimeStore is durable; TaskRegistry remains the current-process presentation facade.
 */
export class RuntimeTaskMirror {
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    registry: TaskRegistry,
    private readonly jobs: JobService,
  ) {
    this.unsubscribe = registry.subscribe((snapshot) => this.mirror(snapshot));
    for (const snapshot of registry.list()) this.mirror(snapshot);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
  }

  private mirror(snapshot: TaskSnapshot): void {
    if (this.closed) return;
    try {
      let durable = this.jobs.get(snapshot.taskId);
      if (!durable) {
        this.jobs.dispatch({
          jobId: snapshot.taskId,
          type: snapshot.type,
          executionClass: executionClass(snapshot),
          completionPolicy: completionPolicy(snapshot),
          description: snapshot.description,
          ...(snapshot.toolUseId ? { toolUseId: snapshot.toolUseId } : {}),
          ...(snapshot.outputFile ? { outputPath: snapshot.outputFile } : {}),
          ...(snapshot.data ? { data: snapshot.data } : {}),
        });
        durable = this.jobs.get(snapshot.taskId);
      }
      if (!durable) throw new Error(`无法创建持久任务 ${snapshot.taskId}`);

      if (snapshot.status === "running" && durable.job.status === "queued") {
        this.jobs.start(snapshot.taskId, {
          expectedVersion: durable.job.version,
          ...(snapshot.outputFile ? { outputPath: snapshot.outputFile } : {}),
        });
        return;
      }
      if (!isLegacyTerminal(snapshot.status) || isDurableTerminal(durable.job.status)) return;

      durable = ensureAttempt(this.jobs, durable, snapshot);
      const attempt = durable.attempts.at(-1);
      if (!attempt || durable.job.status !== "running") return;
      this.jobs.terminal({
        jobId: durable.job.jobId,
        attemptId: attempt.attemptId,
        status: terminalStatus(snapshot.status),
        expectedJobVersion: durable.job.version,
        expectedAttemptVersion: attempt.version,
        leaseEpoch: attempt.leaseEpoch,
        completionId: `completion:${durable.job.jobId}:${attempt.attemptNumber}`,
        outputOffset: snapshot.outputOffset,
        ...(snapshot.error ? { error: snapshot.error } : {}),
        ...(snapshot.data ? { result: snapshot.data } : {}),
      });
    } catch (error) {
      // The bridge cannot roll back an executor that already changed state. Surface a durable
      // diagnostic without throwing through TaskRegistry subscribers; Doctor will reconcile it.
      logger.warn(
        { taskId: snapshot.taskId, status: snapshot.status, error: String(error) },
        "[runtime-store] 同步 TaskRegistry 状态失败",
      );
    }
  }
}

function ensureAttempt(
  jobs: JobService,
  durable: NonNullable<ReturnType<JobService["get"]>>,
  snapshot: TaskSnapshot,
): NonNullable<ReturnType<JobService["get"]>> {
  if (durable.job.status !== "queued") return durable;
  jobs.start(durable.job.jobId, {
    expectedVersion: durable.job.version,
    ...(snapshot.outputFile ? { outputPath: snapshot.outputFile } : {}),
  });
  const started = jobs.get(durable.job.jobId);
  if (!started) throw new Error(`持久任务 ${durable.job.jobId} 启动后消失`);
  return started;
}

function executionClass(snapshot: TaskSnapshot): JobExecutionClass {
  return snapshot.type === "remote_agent" || snapshot.type === "monitor_mcp"
    ? "host_bound"
    : "recoverable";
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

function terminalStatus(status: Extract<TaskStatus, "completed" | "failed" | "killed">): TerminalJobStatus {
  if (status === "completed") return "succeeded";
  if (status === "killed") return "cancelled";
  return "failed";
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
