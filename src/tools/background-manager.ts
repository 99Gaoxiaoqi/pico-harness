import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { isWindows, resolveShell, shellCommandArgs } from "../os/shell.js";
import { signalProcessTree } from "../os/process-tree.js";
import { TaskRegistry } from "../tasks/task-registry.js";

export type BackgroundTaskStatus = "running" | "exited" | "failed" | "stopped";

export interface BackgroundTaskRecord {
  taskId: string;
  command: string;
  cwd: string;
  pid: number;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface BackgroundTaskOutput {
  taskId: string;
  stdout: string;
  stderr: string;
}

export interface BackgroundManagerOptions {
  maxOutputChars?: number;
  stopTimeoutMs?: number;
  maxCompletedTasks?: number;
  taskRegistry?: TaskRegistry;
}

export interface BackgroundTaskSpawnOptions {
  /** 可信宿主生成的实际执行文件与参数，任务记录仍保留原始 command。 */
  executable?: string;
  args?: readonly string[];
  /** 可信宿主为隔离子进程注入的最小环境。 */
  env?: NodeJS.ProcessEnv;
}

interface ManagedTask {
  record: BackgroundTaskRecord;
  order: number;
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout: string;
  stderr: string;
  stopping: boolean;
  closePromise: Promise<BackgroundTaskRecord>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_COMPLETED_TASKS = 100;

export class BackgroundManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly maxOutputChars: number;
  private readonly stopTimeoutMs: number;
  private readonly maxCompletedTasks: number;
  readonly taskRegistry: TaskRegistry;
  private nextId = 1;

  constructor(options: BackgroundManagerOptions = {}) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.maxCompletedTasks = options.maxCompletedTasks ?? DEFAULT_MAX_COMPLETED_TASKS;
    this.taskRegistry = options.taskRegistry ?? new TaskRegistry();
  }

  start(
    command: string,
    cwd: string,
    spawnOptions?: BackgroundTaskSpawnOptions,
  ): BackgroundTaskRecord {
    const order = this.nextId;
    this.nextId++;
    const task = this.taskRegistry.create("local_bash", {
      description: command,
      data: { command, cwd },
    });
    const taskId = task.taskId;
    const shell = resolveShell();
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(
        spawnOptions?.executable ?? shell,
        spawnOptions?.args ? [...spawnOptions.args] : shellCommandArgs(shell, command),
        {
          cwd,
          detached: !isWindows,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...(spawnOptions?.env ? { env: spawnOptions.env } : {}),
        },
      );
    } catch (err) {
      this.taskRegistry.fail(taskId, err);
      throw err;
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
    child.on("error", (err) => {
      if (record.status === "running") {
        record.status = "failed";
        record.endedAt = new Date();
        this.taskRegistry.fail(taskId, err);
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
    if (task.record.status !== "running") {
      return { ...task.record };
    }

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
    if (!task) {
      throw new Error(`未知后台任务: ${taskId}`);
    }
    return task;
  }

  private killTask(task: ManagedTask, signal: NodeJS.Signals): Promise<boolean> {
    return signalProcessTree(task.child, signal);
  }

  private waitForClose(
    promise: Promise<BackgroundTaskRecord>,
    timeoutMs: number,
  ): Promise<BackgroundTaskRecord | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (record?: BackgroundTaskRecord): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(record);
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      void promise.then((record) => finish(record));
    });
  }

  private pruneCompletedTasks(): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.record.status !== "running")
      .sort((a, b) => a.order - b.order);

    while (completed.length > this.maxCompletedTasks) {
      const oldest = completed.shift();
      if (oldest) this.tasks.delete(oldest.record.taskId);
    }
  }
}

function appendRing(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  if (next.length <= maxChars) {
    return next;
  }
  return next.slice(next.length - maxChars);
}

function tailOutput(output: string, tail?: number): string {
  if (tail === undefined || tail < 0 || output.length <= tail) {
    return output;
  }
  return output.slice(output.length - tail);
}
