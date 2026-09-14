import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  BackgroundTaskOutput,
  BackgroundTaskRecord,
  BackgroundTaskStatus,
} from "@pico/runtime/background-task-tools";
import { raceWithDeadline } from "@pico/runtime/deadline";
import { TaskRegistry } from "@pico/runtime/task-registry";

export type { BackgroundTaskOutput, BackgroundTaskRecord, BackgroundTaskStatus };

export type BackgroundChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface BackgroundTaskManagerOptions<SpawnOptions> {
  maxOutputChars?: number;
  stopTimeoutMs?: number;
  maxCompletedTasks?: number;
  taskRegistry?: TaskRegistry;
  ownerSessionId?: string;
  launch(command: string, cwd: string, options?: SpawnOptions): BackgroundChildProcess;
  signalProcessTree(child: BackgroundChildProcess, signal: NodeJS.Signals): Promise<boolean>;
}

interface ManagedTask {
  record: BackgroundTaskRecord;
  order: number;
  child: BackgroundChildProcess;
  stdout: string;
  stderr: string;
  stopping: boolean;
  closePromise: Promise<BackgroundTaskRecord>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_COMPLETED_TASKS = 100;

/** Host lifecycle for process-backed background tasks; physical launch and signaling are injected. */
export class HostBackgroundTaskManager<SpawnOptions = never> {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly maxOutputChars: number;
  private readonly stopTimeoutMs: number;
  private readonly maxCompletedTasks: number;
  readonly taskRegistry: TaskRegistry;
  private readonly ownerSessionId: string | undefined;
  private readonly launchProcess: BackgroundTaskManagerOptions<SpawnOptions>["launch"];
  private readonly signalTaskProcessTree: BackgroundTaskManagerOptions<SpawnOptions>["signalProcessTree"];
  private nextId = 1;

  constructor(options: BackgroundTaskManagerOptions<SpawnOptions>) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.maxCompletedTasks = options.maxCompletedTasks ?? DEFAULT_MAX_COMPLETED_TASKS;
    this.taskRegistry = options.taskRegistry ?? new TaskRegistry();
    this.ownerSessionId = options.ownerSessionId;
    this.launchProcess = options.launch;
    this.signalTaskProcessTree = options.signalProcessTree;
  }

  start(command: string, cwd: string, spawnOptions?: SpawnOptions): BackgroundTaskRecord {
    const order = this.nextId++;
    const task = this.taskRegistry.create("local_bash", {
      description: command,
      data: {
        command,
        cwd,
        ...(this.ownerSessionId ? { ownerSessionId: this.ownerSessionId } : {}),
      },
    });
    const taskId = task.taskId;
    let child: BackgroundChildProcess;
    try {
      child = this.launchProcess(command, cwd, spawnOptions);
    } catch (error) {
      this.taskRegistry.fail(taskId, error);
      throw error;
    }

    const record: BackgroundTaskRecord = {
      taskId,
      command,
      cwd,
      pid: child.pid ?? 0,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date(),
      endedAt: null,
    };
    this.taskRegistry.start(taskId, { data: { pid: record.pid } });

    let resolveClose: (record: BackgroundTaskRecord) => void = () => {};
    const closePromise = new Promise<BackgroundTaskRecord>((resolve) => {
      resolveClose = resolve;
    });
    const managed: ManagedTask = {
      record,
      order,
      child,
      stdout: "",
      stderr: "",
      stopping: false,
      closePromise,
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      managed.stdout = appendRing(managed.stdout, chunk, this.maxOutputChars);
    });
    child.stderr.on("data", (chunk: string) => {
      managed.stderr = appendRing(managed.stderr, chunk, this.maxOutputChars);
    });
    child.on("error", (error) => {
      if (record.status === "running") {
        record.status = "failed";
        record.endedAt = new Date();
        this.taskRegistry.fail(taskId, error);
      }
    });
    child.on("close", (code, signal) => {
      if (record.status === "running") {
        record.status = managed.stopping ? "stopped" : "exited";
      }
      record.exitCode = code;
      record.signal = signal;
      record.endedAt = new Date();
      if (record.status === "stopped") {
        this.taskRegistry.kill(taskId, "stopped", { data: { exitCode: code, signal } });
      } else if (record.status === "exited" && code === 0) {
        this.taskRegistry.complete(taskId, { data: { exitCode: code, signal } });
      } else if (record.status === "exited") {
        this.taskRegistry.fail(taskId, `exit code ${code ?? "unknown"}`, {
          data: { exitCode: code, signal },
        });
      }
      this.pruneCompletedTasks();
      resolveClose({ ...record });
    });

    this.tasks.set(taskId, managed);
    return { ...record };
  }

  list(): BackgroundTaskRecord[] {
    return [...this.tasks.values()].map((task) => ({ ...task.record }));
  }

  output(taskId: string, tail?: number): BackgroundTaskOutput {
    const task = this.getTask(taskId);
    return {
      taskId,
      stdout: tailOutput(task.stdout, tail),
      stderr: tailOutput(task.stderr, tail),
    };
  }

  async stop(taskId: string): Promise<BackgroundTaskRecord> {
    const task = this.getTask(taskId);
    if (task.record.status !== "running") return { ...task.record };

    task.stopping = true;
    await this.killTask(task, "SIGTERM");
    const gracefulClose = await this.waitForClose(task.closePromise, this.stopTimeoutMs);
    if (gracefulClose) return gracefulClose;

    await this.killTask(task, "SIGKILL");
    const forcedClose = await this.waitForClose(task.closePromise, this.stopTimeoutMs);
    if (forcedClose) return forcedClose;

    throw new Error(`后台任务 ${taskId} 在强制终止后仍未退出`);
  }

  private getTask(taskId: string): ManagedTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`未知后台任务: ${taskId}`);
    return task;
  }

  private killTask(task: ManagedTask, signal: NodeJS.Signals): Promise<boolean> {
    return this.signalTaskProcessTree(task.child, signal);
  }

  private waitForClose(
    promise: Promise<BackgroundTaskRecord>,
    timeoutMs: number,
  ): Promise<BackgroundTaskRecord | undefined> {
    return raceWithDeadline(promise, timeoutMs).then((closed) =>
      closed ? promise : undefined,
    );
  }

  private pruneCompletedTasks(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.record.status !== "running")
      .sort((left, right) => left.order - right.order);
    while (completed.length > this.maxCompletedTasks) {
      const oldest = completed.shift();
      if (oldest) this.tasks.delete(oldest.record.taskId);
    }
  }
}

function appendRing(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

function tailOutput(output: string, tail?: number): string {
  if (tail === undefined || tail < 0 || output.length <= tail) return output;
  return output.slice(output.length - tail);
}
