import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { TaskSnapshot } from "../tasks/task-registry.js";
import { TaskHostRuntime, type TaskHostRuntimeOptions } from "../tasks/task-runtime.js";
import type {
  WorktreeTaskRequest,
  WorktreeTaskRunner,
  WorktreeTaskSnapshot,
} from "../tasks/worktree-supervisor.js";

export const WORKSPACE_RUN_STATUSES = [
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type WorkspaceRunStatus = (typeof WORKSPACE_RUN_STATUSES)[number];

export interface WorkspaceRunSnapshot {
  runId: string;
  workspace: string;
  /** Runtime-owned linkage used by non-TUI clients to resolve durable session state. */
  sessionId?: string;
  /** Exact user-message rewind point created for this Run. */
  checkpointId?: string;
  description: string;
  status: WorkspaceRunStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
  version: number;
}

export interface WorkspaceRunRequest {
  description: string;
}

export interface WorkspaceRunContext {
  readonly run: WorkspaceRunSnapshot;
  readonly signal: AbortSignal;
  /** 取走宿主在运行期间追加的引导消息。 */
  drainSteers(): string[];
  /** 在 executor 需要立即响应引导时订阅后续消息。 */
  onSteer(listener: (message: string) => void): () => void;
  /** Bind once the executor has resolved the concrete session. Conflicting rebinds fail closed. */
  bindSession(sessionId: string): void;
  /** Bind the exact rewind point created by the executor. Conflicting rebinds fail closed. */
  bindCheckpoint(checkpointId: string): void;
}

export type WorkspaceRunExecutor = (
  context: WorkspaceRunContext,
) => Promise<Record<string, unknown> | void>;

export interface WorkspaceRuntimeEvent {
  eventId: string;
  type:
    | "workspace.ready"
    | "run.started"
    | "run.steer_requested"
    | "run.cancel_requested"
    | "run.finished"
    | "task.updated";
  workspace: string;
  at: number;
  resourceVersion: number;
  run?: WorkspaceRunSnapshot;
  task?: TaskSnapshot;
}

export type WorkspaceRuntimeEventSubscriber = (event: WorkspaceRuntimeEvent) => void;

export interface WorkspaceTaskRuntimeOptions {
  workDir: string;
  /** 注入时由调用方拥有其创建时机；WorkspaceTaskRuntime 仍负责 close。 */
  taskHostRuntime?: TaskHostRuntime;
  taskHostRuntimeOptions?: Omit<TaskHostRuntimeOptions, "workDir">;
  now?: () => number;
  generateRunId?: () => string;
}

interface WorkspaceRunRecord {
  snapshot: WorkspaceRunSnapshot;
  controller: AbortController;
  steers: string[];
  steerSubscribers: Set<(message: string) => void>;
  promise: Promise<void>;
}

/**
 * UI-neutral owner for one canonical Git workspace.
 *
 * It deliberately wraps the current TaskHostRuntime rather than changing TUI ownership in
 * place. A future daemon can own this class unchanged while the existing TUI keeps using its
 * compatibility facade.
 */
export class WorkspaceTaskRuntime {
  readonly workspace: string;
  readonly taskHostRuntime: TaskHostRuntime;

  private readonly now: () => number;
  private readonly generateRunId: () => string;
  private readonly runs = new Map<string, WorkspaceRunRecord>();
  private readonly subscribers = new Set<WorkspaceRuntimeEventSubscriber>();
  private readonly unsubscribeTaskRegistry: () => void;
  private eventSequence = 0;
  private closed = false;

  /** Compatibility name used by the daemon's generic canonical-workspace registry. */
  get workspacePath(): string {
    return this.workspace;
  }

  private constructor(
    workspace: string,
    taskHostRuntime: TaskHostRuntime,
    options: Pick<WorkspaceTaskRuntimeOptions, "now" | "generateRunId">,
  ) {
    this.workspace = workspace;
    this.taskHostRuntime = taskHostRuntime;
    this.now = options.now ?? Date.now;
    this.generateRunId = options.generateRunId ?? (() => `run_${randomUUID()}`);
    this.unsubscribeTaskRegistry = this.taskHostRuntime.taskRegistry.subscribe((task) => {
      this.publish({
        type: "task.updated",
        resourceVersion: taskVersion(task),
        task,
      });
    });
    this.publish({ type: "workspace.ready", resourceVersion: 1 });
  }

  static async create(options: WorkspaceTaskRuntimeOptions): Promise<WorkspaceTaskRuntime> {
    const requestedWorkspace = await realpath(resolve(options.workDir));
    const taskHostRuntime =
      options.taskHostRuntime ??
      (await TaskHostRuntime.create({
        workDir: requestedWorkspace,
        ...(options.taskHostRuntimeOptions ?? {}),
      }));
    const workspace = await realpath(taskHostRuntime.repoRoot);
    return new WorkspaceTaskRuntime(workspace, taskHostRuntime, options);
  }

  subscribe(subscriber: WorkspaceRuntimeEventSubscriber): () => void {
    this.assertOpen();
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  startRun(request: WorkspaceRunRequest, executor: WorkspaceRunExecutor): WorkspaceRunSnapshot {
    this.assertOpen();
    const description = request.description.trim();
    if (!description) throw new Error("Run 描述不能为空");
    if (this.listRuns().some((run) => !isTerminalRunStatus(run.status))) {
      throw new Error(`工作区 ${this.workspace} 已有活跃 Run，拒绝并发执行`);
    }

    const runId = this.generateRunId();
    if (this.runs.has(runId)) throw new Error(`Run ID 已存在: ${runId}`);
    const startedAt = this.now();
    const record: WorkspaceRunRecord = {
      snapshot: {
        runId,
        workspace: this.workspace,
        description,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        version: 1,
      },
      controller: new AbortController(),
      steers: [],
      steerSubscribers: new Set(),
      promise: Promise.resolve(),
    };
    this.runs.set(runId, record);
    this.publish({
      type: "run.started",
      resourceVersion: record.snapshot.version,
      run: cloneRun(record.snapshot),
    });
    record.promise = Promise.resolve().then(() => this.executeRun(record, executor));
    return cloneRun(record.snapshot);
  }

  getRun(runId: string): WorkspaceRunSnapshot | undefined {
    const record = this.runs.get(runId);
    return record ? cloneRun(record.snapshot) : undefined;
  }

  listRuns(): WorkspaceRunSnapshot[] {
    return [...this.runs.values()]
      .map((record) => cloneRun(record.snapshot))
      .sort(
        (left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
      );
  }

  async waitForRun(runId: string): Promise<WorkspaceRunSnapshot> {
    const record = this.requireRun(runId);
    await record.promise;
    return cloneRun(record.snapshot);
  }

  cancel(runId: string, reason = "cancelled by user"): WorkspaceRunSnapshot {
    const record = this.requireRun(runId);
    if (isTerminalRunStatus(record.snapshot.status)) return cloneRun(record.snapshot);
    if (record.snapshot.status !== "cancelling") {
      record.snapshot = updateRun(record.snapshot, { status: "cancelling" }, this.now());
      record.controller.abort(new DOMException(reason, "AbortError"));
      this.publish({
        type: "run.cancel_requested",
        resourceVersion: record.snapshot.version,
        run: cloneRun(record.snapshot),
      });
    }
    return cloneRun(record.snapshot);
  }

  steer(runId: string, message: string): WorkspaceRunSnapshot {
    const record = this.requireRun(runId);
    if (isTerminalRunStatus(record.snapshot.status)) {
      throw new Error(`Run ${runId} 已结束，无法追加引导`);
    }
    const normalized = message.trim();
    if (!normalized) throw new Error("追加引导不能为空");
    record.steers.push(normalized);
    record.snapshot = updateRun(record.snapshot, {}, this.now());
    for (const subscriber of record.steerSubscribers) subscriber(normalized);
    this.publish({
      type: "run.steer_requested",
      resourceVersion: record.snapshot.version,
      run: cloneRun(record.snapshot),
    });
    return cloneRun(record.snapshot);
  }

  startTask(request: WorktreeTaskRequest, runner: WorktreeTaskRunner): WorktreeTaskSnapshot {
    this.assertOpen();
    return this.taskHostRuntime.start(request, runner);
  }

  listTasks(): TaskSnapshot[] {
    return this.taskHostRuntime.list();
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    return this.taskHostRuntime.get(taskId);
  }

  cancelTask(taskId: string): Promise<WorktreeTaskSnapshot> {
    this.assertOpen();
    return this.taskHostRuntime.stop(taskId);
  }

  steerTask(taskId: string, message: string): WorktreeTaskSnapshot {
    this.assertOpen();
    return this.taskHostRuntime.sendMessage(taskId, message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeTaskRegistry();
    for (const record of this.runs.values()) {
      if (!isTerminalRunStatus(record.snapshot.status)) this.cancelDuringClose(record);
    }
    await Promise.allSettled([...this.runs.values()].map((record) => record.promise));
    await this.taskHostRuntime.close();
    this.subscribers.clear();
  }

  private async executeRun(
    record: WorkspaceRunRecord,
    executor: WorkspaceRunExecutor,
  ): Promise<void> {
    try {
      const result = await executor({
        run: cloneRun(record.snapshot),
        signal: record.controller.signal,
        drainSteers: () => record.steers.splice(0),
        onSteer: (subscriber) => {
          record.steerSubscribers.add(subscriber);
          return () => record.steerSubscribers.delete(subscriber);
        },
        bindSession: (sessionId) => this.bindRunIdentifier(record, "sessionId", sessionId),
        bindCheckpoint: (checkpointId) =>
          this.bindRunIdentifier(record, "checkpointId", checkpointId),
      });
      this.finishRun(record, record.controller.signal.aborted ? "cancelled" : "succeeded", result);
    } catch (error) {
      this.finishRun(
        record,
        record.controller.signal.aborted ? "cancelled" : "failed",
        undefined,
        errorMessage(error),
      );
    } finally {
      record.steerSubscribers.clear();
    }
  }

  private bindRunIdentifier(
    record: WorkspaceRunRecord,
    field: "checkpointId" | "sessionId",
    value: string,
  ): void {
    const normalized = value.trim();
    if (!normalized) throw new Error(`Run ${field} 不能为空`);
    const current = record.snapshot[field];
    if (current !== undefined && current !== normalized) {
      throw new Error(`Run ${record.snapshot.runId} 已绑定其他 ${field}`);
    }
    if (current === normalized) return;
    record.snapshot = {
      ...record.snapshot,
      [field]: normalized,
      updatedAt: this.now(),
      version: record.snapshot.version + 1,
    };
  }

  private finishRun(
    record: WorkspaceRunRecord,
    status: Extract<WorkspaceRunStatus, "succeeded" | "failed" | "cancelled">,
    result?: Record<string, unknown> | void,
    error?: string,
  ): void {
    if (isTerminalRunStatus(record.snapshot.status)) return;
    const finishedAt = this.now();
    record.snapshot = {
      ...record.snapshot,
      status,
      updatedAt: finishedAt,
      finishedAt,
      version: record.snapshot.version + 1,
      ...(result ? { result: { ...result } } : {}),
      ...(error ? { error } : {}),
    };
    this.publish({
      type: "run.finished",
      resourceVersion: record.snapshot.version,
      run: cloneRun(record.snapshot),
    });
  }

  private cancelDuringClose(record: WorkspaceRunRecord): void {
    record.snapshot = updateRun(record.snapshot, { status: "cancelling" }, this.now());
    record.controller.abort(new DOMException("workspace runtime closed", "AbortError"));
  }

  private publish(input: Omit<WorkspaceRuntimeEvent, "eventId" | "workspace" | "at">): void {
    const event: WorkspaceRuntimeEvent = {
      eventId: `${this.workspace}:${++this.eventSequence}`,
      workspace: this.workspace,
      at: this.now(),
      ...input,
    };
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private requireRun(runId: string): WorkspaceRunRecord {
    this.assertOpen();
    const record = this.runs.get(runId);
    if (!record) throw new Error(`未知 Run: ${runId}`);
    return record;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("WorkspaceTaskRuntime 已关闭");
  }
}

function updateRun(
  snapshot: WorkspaceRunSnapshot,
  update: Partial<Pick<WorkspaceRunSnapshot, "status">>,
  now: number,
): WorkspaceRunSnapshot {
  return {
    ...snapshot,
    ...update,
    updatedAt: now,
    version: snapshot.version + 1,
  };
}

function cloneRun(snapshot: WorkspaceRunSnapshot): WorkspaceRunSnapshot {
  return {
    ...snapshot,
    ...(snapshot.result ? { result: { ...snapshot.result } } : {}),
  };
}

function isTerminalRunStatus(status: WorkspaceRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function taskVersion(task: TaskSnapshot): number {
  const value = task.data?.["runtimeVersion"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
