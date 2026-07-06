import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
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
}

interface ManagedTask {
  record: BackgroundTaskRecord;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  stopping: boolean;
  closePromise: Promise<BackgroundTaskRecord>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 64_000;

export class BackgroundManager {
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly maxOutputChars: number;
  private nextId = 1;

  constructor(options: BackgroundManagerOptions = {}) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  start(command: string, cwd: string): BackgroundTaskRecord {
    const taskId = this.createTaskId();
    const shell = resolveShell();
    const child = spawn(shell, shellArgs(shell, command), {
      cwd,
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
    task.child.kill("SIGTERM");
    return task.closePromise;
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
