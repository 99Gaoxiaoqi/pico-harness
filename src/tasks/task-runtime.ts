import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { logger } from "../observability/logger.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { TaskRegistry, type TaskSnapshot } from "./task-registry.js";
import { TaskStore } from "./task-store.js";
import { JobService } from "./job-service.js";
import {
  materializeRuntimeTaskSnapshot,
  materializeRuntimeTaskSnapshots,
  RuntimeTaskMirror,
  type RuntimeTaskMirrorOptions,
} from "./runtime-task-mirror.js";
import { WorktreeMergeQueue, type WorktreeMergeSnapshot } from "./merge-queue.js";
import {
  WorktreeSupervisor,
  type WorktreeTaskFinalization,
  type WorktreeTaskFinalizationInput,
  type WorktreeTaskRequest,
  type WorktreeTaskRunner,
  type WorktreeTaskSnapshot,
} from "./worktree-supervisor.js";

export interface TaskHostRuntimeOptions {
  workDir: string;
  repoRoot?: string;
  runtimeMirror?: RuntimeTaskMirrorOptions;
  reconcileIntervalMs?: number;
  now?: () => number;
}

/** TUI-lifetime owner for durable task state and isolated worktree execution. */
export class TaskHostRuntime {
  readonly taskRegistry: TaskRegistry;
  readonly taskStore: TaskStore;
  readonly supervisor: WorktreeSupervisor;
  readonly mergeQueue: WorktreeMergeQueue;
  readonly jobService: JobService;
  readonly repoRoot: string;
  readonly targetBranch: string;

  private readonly runtimeMirror: RuntimeTaskMirror;
  private readonly reconcileTimer: ReturnType<typeof setInterval>;

  private constructor(
    repoRoot: string,
    targetBranch: string,
    jobService: JobService,
    runtimeMirrorOptions: RuntimeTaskMirrorOptions = {},
    reconcileIntervalMs = 5_000,
  ) {
    this.repoRoot = repoRoot;
    this.targetBranch = targetBranch;
    this.jobService = jobService;
    this.taskRegistry = new TaskRegistry();
    this.taskStore = new TaskStore({
      filePath: join(resolvePicoPaths(repoRoot).workspace.tasks, "state.json"),
    });
    this.jobService.reconcileExpiredJobs();
    this.taskRegistry.hydrate(materializeRuntimeTaskSnapshots(this.jobService), {
      preserveNonTerminal: true,
    });
    this.runtimeMirror = new RuntimeTaskMirror(
      this.taskRegistry,
      this.jobService,
      runtimeMirrorOptions,
    );
    // SQLite 先接收 Registry 变更，TaskStore 只在其后写兼容快照。
    this.taskStore.bind(this.taskRegistry);
    this.mergeQueue = new WorktreeMergeQueue();
    this.supervisor = new WorktreeSupervisor({
      taskRegistry: this.taskRegistry,
      repoRoot,
      finalizer: (input) => this.finalizeWorktree(input),
    });
    this.reconcileTimer = setInterval(
      () => {
        try {
          this.reconcileRuntimeAuthority();
        } catch (error) {
          logger.warn({ error: String(error) }, "[runtime-store] 过期任务收口失败");
        }
      },
      positiveDuration(reconcileIntervalMs, "reconcileIntervalMs"),
    );
    this.reconcileTimer.unref?.();
  }

  static async create(options: TaskHostRuntimeOptions): Promise<TaskHostRuntime> {
    const cwd = resolve(options.workDir);
    let repoRoot: string;
    try {
      repoRoot = options.repoRoot
        ? resolve(options.repoRoot)
        : await gitOutput(["rev-parse", "--show-toplevel"], cwd);
    } catch (error) {
      throw new Error(
        gitWorkspaceError(cwd, error),
        error instanceof Error ? { cause: error } : {},
      );
    }
    const targetBranch = await gitOutput(["branch", "--show-current"], repoRoot);
    if (!targetBranch) throw new Error("当前 Git 工作树处于 detached HEAD，无法启动任务监督器");
    const { service } = await JobService.create({
      workDir: repoRoot,
      ownerId: `tui-host:${process.pid}`,
      ...(options.now ? { now: options.now } : {}),
    });
    return new TaskHostRuntime(
      repoRoot,
      targetBranch,
      service,
      options.runtimeMirror ?? {},
      options.reconcileIntervalMs ?? 5_000,
    );
  }

  start(request: WorktreeTaskRequest, runner: WorktreeTaskRunner): WorktreeTaskSnapshot {
    return this.supervisor.start(request, runner);
  }

  list(): TaskSnapshot[] {
    return materializeRuntimeTaskSnapshots(this.jobService);
  }

  get(taskId: string): TaskSnapshot | undefined {
    const durable = this.jobService.get(taskId);
    return durable ? materializeRuntimeTaskSnapshot(durable) : undefined;
  }

  tail(taskId: string, maxChars?: number): string {
    return this.supervisor.get(taskId)
      ? this.supervisor.tail(taskId, maxChars)
      : "Output tail is unavailable for a task restored after host restart.";
  }

  stop(taskId: string): Promise<WorktreeTaskSnapshot> {
    return this.supervisor.stop(taskId);
  }

  retry(taskId: string): WorktreeTaskSnapshot {
    return this.supervisor.retry(taskId);
  }

  sendMessage(taskId: string, message: string): WorktreeTaskSnapshot {
    return this.supervisor.sendMessage(taskId, message);
  }

  async merge(taskId: string): Promise<WorktreeMergeSnapshot> {
    const task = this.supervisor.get(taskId);
    if (!task) throw new Error(`任务 ${taskId} 不属于当前 TUI 的 worktree supervisor`);
    if (task.status !== "completed") throw new Error(`任务 ${taskId} 尚未完成，不能合并`);
    if (task.dirty) throw new Error(`任务 ${taskId} 的 worktree 仍有未提交修改，不能合并`);
    return this.mergeQueue.enqueue({
      taskId,
      sourceBranch: task.branch,
      sourceWorktree: task.worktreePath,
      targetBranch: this.targetBranch,
      targetWorktree: this.repoRoot,
    });
  }

  async cleanupMerged(taskId: string): Promise<void> {
    const merged = this.mergeQueue.get(taskId);
    if (merged?.status !== "merged") throw new Error(`任务 ${taskId} 尚未完成合并`);
    await this.supervisor.cleanup(taskId, { merged: true });
  }

  /** SQLite 先收口，再幂等刷新进程内视图与 legacy TaskStore 投影。 */
  private reconcileRuntimeAuthority(): void {
    this.jobService.reconcileExpiredJobs();
    for (const snapshot of materializeRuntimeTaskSnapshots(this.jobService)) {
      this.taskRegistry.replaceFromAuthority(snapshot);
    }
  }

  private async finalizeWorktree(
    input: WorktreeTaskFinalizationInput,
  ): Promise<WorktreeTaskFinalization> {
    const durable = this.jobService.get(input.taskId);
    if (!durable) throw new Error(`持久任务 ${input.taskId} 不存在，拒绝无记录合并`);
    const attempt = durable.attempts.at(-1);
    if (!attempt || durable.job.status !== "running") {
      throw new Error(`持久任务 ${input.taskId} 没有 running attempt，拒绝合并`);
    }

    let merge = this.jobService.enqueueMerge({
      jobId: input.taskId,
      attemptId: attempt.attemptId,
      sourceBranch: input.sourceBranch,
      sourceWorktree: input.sourceWorktree,
      targetBranch: this.targetBranch,
      targetWorktree: this.repoRoot,
      sourceHead: input.sourceHead,
    });

    try {
      if (await gitIsAncestor(input.sourceHead, this.targetBranch, this.repoRoot)) {
        merge = this.jobService.updateMerge(merge.mergeRequestId, merge.version, "not_needed");
        return this.settleWorktreeFinalization(durable, attempt.attemptId, {
          status: "not_needed",
          mergeRequestId: merge.mergeRequestId,
        });
      }

      await this.mergeQueue.enqueue({
        taskId: input.taskId,
        sourceBranch: input.sourceBranch,
        sourceWorktree: input.sourceWorktree,
        targetBranch: this.targetBranch,
        targetWorktree: this.repoRoot,
      });
      merge = this.jobService.updateMerge(merge.mergeRequestId, merge.version, "running");
      await this.mergeQueue.waitForIdle();
      const result = this.mergeQueue.get(input.taskId);
      if (result?.status === "merged") {
        merge = this.jobService.updateMerge(merge.mergeRequestId, merge.version, "merged");
        return this.settleWorktreeFinalization(durable, attempt.attemptId, {
          status: "merged",
          mergeRequestId: merge.mergeRequestId,
          ...(result.mergeHead ? { mergeHead: result.mergeHead } : {}),
        });
      }
      const error =
        result?.error ??
        (result?.status === "queued"
          ? "串行合并队列被早先的 blocked 任务阻塞"
          : "合并队列未生成终态");
      merge = this.jobService.updateMerge(merge.mergeRequestId, merge.version, "blocked", error);
      return this.settleWorktreeFinalization(durable, attempt.attemptId, {
        status: "blocked",
        mergeRequestId: merge.mergeRequestId,
        error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (merge.status === "queued" || merge.status === "running") {
        merge = this.jobService.updateMerge(merge.mergeRequestId, merge.version, "failed", message);
      }
      return this.settleWorktreeFinalization(durable, attempt.attemptId, {
        status: "failed",
        mergeRequestId: merge.mergeRequestId,
        error: message,
      });
    }
  }

  private settleWorktreeFinalization(
    initial: NonNullable<ReturnType<JobService["get"]>>,
    attemptId: string,
    finalization: WorktreeTaskFinalization,
  ): WorktreeTaskFinalization {
    const current = this.jobService.get(initial.job.jobId);
    const attempt = current?.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!current || current.job.status !== "running" || !attempt || attempt.status !== "running") {
      throw new Error(`持久任务 ${initial.job.jobId} 在宿主收口前已丢失 running attempt`);
    }
    const status =
      finalization.status === "merged" || finalization.status === "not_needed"
        ? "succeeded"
        : finalization.status === "blocked"
          ? "partial"
          : "failed";
    this.runtimeMirror.stopHeartbeat(current.job.jobId);
    this.jobService.terminal({
      jobId: current.job.jobId,
      attemptId: attempt.attemptId,
      status,
      expectedJobVersion: current.job.version,
      expectedAttemptVersion: attempt.version,
      leaseEpoch: attempt.leaseEpoch,
      completionId: `completion:${current.job.jobId}:${attempt.attemptNumber}`,
      ...(finalization.error ? { error: finalization.error } : {}),
      result: { finalization },
      completionPayload: { finalization },
      ...(current.job.data?.["internalCompletion"] === true
        ? { completionAlreadyDelivered: true }
        : {}),
    });
    return finalization;
  }

  async close(): Promise<void> {
    clearInterval(this.reconcileTimer);
    const running = this.supervisor
      .list()
      .filter(
        (task) =>
          task.status === "preparing" || task.status === "running" || task.status === "stopping",
      );
    await Promise.allSettled(
      running.map((task) => this.supervisor.stop(task.taskId, "TUI closed")),
    );
    await this.mergeQueue.waitForIdle();
    this.taskStore.close();
    this.runtimeMirror.close();
    this.jobService.close();
  }
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正数`);
  return value;
}

function gitWorkspaceError(cwd: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b|not found|不是内部或外部命令/iu.test(detail)) {
    return "Pico 未找到 Git。请先安装 Git，并重新启动 Pico。";
  }
  if (/not a git repository/iu.test(detail)) {
    return `所选文件夹不是 Git 仓库：${cwd}。请选择包含 .git 的项目文件夹，或先在该目录运行 git init。`;
  }
  return `Pico 无法检查 Git 工作区 ${cwd}：${detail}`;
}

function gitOutput(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolveOutput(stdout.trim());
    });
  });
}

function gitIsAncestor(source: string, target: string, cwd: string): Promise<boolean> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      ["merge-base", "--is-ancestor", source, target],
      { cwd, encoding: "utf8" },
      (error, _stdout, stderr) => {
        if (!error) {
          resolveResult(true);
          return;
        }
        if (typeof error.code === "number" && error.code === 1) {
          resolveResult(false);
          return;
        }
        reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}
