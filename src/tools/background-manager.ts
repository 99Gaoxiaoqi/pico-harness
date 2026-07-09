import { spawn, type ChildProcessByStdio } from "node:child_process";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import { isWindows, resolveShell } from "../os/shell.js";

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
  private nextId = 1;

  constructor(options: BackgroundManagerOptions = {}) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.maxCompletedTasks = options.maxCompletedTasks ?? DEFAULT_MAX_COMPLETED_TASKS;
  }

  start(command: string, cwd: string): BackgroundTaskRecord {
    const order = this.nextId;
    const taskId = this.createTaskId();
    const shell = resolveShell();
    const child = spawn(shell, shellArgs(shell, command), {
      cwd,
      detached: !isWindows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
    child.on("error", () => {
      if (record.status === "running") {
        record.status = "failed";
        record.endedAt = new Date();
      }
    });
    child.on("close", (code, signal) => {
      if (record.status === "running") {
        record.status = managed.stopping ? "stopped" : "exited";
      }
      record.exitCode = code;
      record.signal = signal;
      record.endedAt = new Date();
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
    this.killTask(task, "SIGTERM");
    return this.withTimeout(task.closePromise, this.stopTimeoutMs, async () => {
      this.killTask(task, "SIGKILL");
      return this.withTimeout(task.closePromise, this.stopTimeoutMs, () =>
        this.forceStopRecord(task, "SIGKILL"),
      );
    });
  }

  private createTaskId(): string {
    return `bg-${Date.now().toString(36)}-${this.nextId++}`;
  }

  private getTask(taskId: string): ManagedTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`未知后台任务: ${taskId}`);
    }
    return task;
  }

  private killTask(task: ManagedTask, signal: NodeJS.Signals): void {
    const pid = task.child.pid;
    if (!pid) return;
    try {
      if (isWindows) {
        task.child.kill(signal);
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      try {
        task.child.kill(signal);
      } catch {
        // Process may have exited between the process-group kill and fallback kill.
      }
    }
  }

  private forceStopRecord(task: ManagedTask, signal: NodeJS.Signals): BackgroundTaskRecord {
    if (task.record.status === "running") {
      task.record.status = "stopped";
      task.record.signal = signal;
      task.record.endedAt = new Date();
      this.pruneCompletedTasks();
    }
    return { ...task.record };
  }

  private async withTimeout(
    promise: Promise<BackgroundTaskRecord>,
    timeoutMs: number,
    onTimeout: () => Promise<BackgroundTaskRecord> | BackgroundTaskRecord,
  ): Promise<BackgroundTaskRecord> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<BackgroundTaskRecord>((resolve) => {
          timer = setTimeout(() => {
            Promise.resolve(onTimeout()).then(resolve);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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

function shellArgs(shell: string, command: string): string[] {
  const name = basename(shell).toLowerCase();
  if (isWindows && name === "cmd.exe") {
    return ["/d", "/s", "/c", command];
  }
  return ["-lc", command];
}
