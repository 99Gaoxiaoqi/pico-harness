import { randomBytes } from "node:crypto";
import type {
  CreateTaskInput,
  TaskSnapshot,
  TaskStatus,
  TaskSubscriber,
  TaskType,
  UpdateTaskInput,
} from "./task-types.js";
export type { CreateTaskInput, TaskSnapshot, TaskStatus, TaskType, UpdateTaskInput };
export { isTerminalTaskStatus } from "./task-types.js";

const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_bash: "b",
  local_agent: "a",
  remote_agent: "r",
  local_workflow: "w",
  monitor_mcp: "m",
};

const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type];
  const bytes = randomBytes(8);
  let suffix = "";
  for (const byte of bytes) {
    suffix += TASK_ID_ALPHABET[byte % TASK_ID_ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

export interface TaskRegistryOptions {
  generateId?: (type: TaskType) => string;
  now?: () => number;
}

interface StoredTask {
  snapshot: TaskSnapshot;
  order: number;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, StoredTask>();
  private readonly subscribers = new Set<TaskSubscriber>();
  private readonly generateId: (type: TaskType) => string;
  private readonly now: () => number;
  private nextOrder = 0;

  constructor(options: TaskRegistryOptions = {}) {
    this.generateId = options.generateId ?? generateTaskId;
    this.now = options.now ?? Date.now;
  }

  create(type: TaskType, input: CreateTaskInput = {}): TaskSnapshot {
    const taskId = this.generateId(type);
    if (this.tasks.has(taskId)) {
      throw new Error(`任务 ID 已存在: ${taskId}`);
    }

    const snapshot: TaskSnapshot = {
      taskId,
      type,
      status: "pending",
      description: input.description ?? type,
      startTime: this.now(),
      outputOffset: input.outputOffset ?? 0,
      notified: input.notified ?? false,
      ...defined({
        toolUseId: input.toolUseId,
        outputFile: input.outputFile,
        data: cloneData(input.data),
      }),
    };

    this.tasks.set(taskId, { snapshot, order: this.nextOrder++ });
    this.emit(snapshot);
    return cloneSnapshot(snapshot);
  }

  start(taskId: string, input: UpdateTaskInput = {}): TaskSnapshot {
    return this.update(taskId, "running", input);
  }

  complete(taskId: string, input: UpdateTaskInput = {}): TaskSnapshot {
    return this.update(taskId, "completed", { ...input, endTime: this.now() });
  }

  fail(taskId: string, error: unknown, input: UpdateTaskInput = {}): TaskSnapshot {
    return this.update(taskId, "failed", {
      ...input,
      endTime: this.now(),
      error: errorToMessage(error),
    });
  }

  kill(taskId: string, reason = "killed", input: UpdateTaskInput = {}): TaskSnapshot {
    return this.update(taskId, "killed", { ...input, endTime: this.now(), error: reason });
  }

  get(taskId: string): TaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneSnapshot(task.snapshot) : undefined;
  }

  list(): TaskSnapshot[] {
    return [...this.tasks.values()]
      .sort((a, b) => a.snapshot.startTime - b.snapshot.startTime || a.order - b.order)
      .map((task) => cloneSnapshot(task.snapshot));
  }

  subscribe(subscriber: TaskSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private update(
    taskId: string,
    status: TaskSnapshot["status"],
    input: UpdateTaskInput & { endTime?: number; error?: string } = {},
  ): TaskSnapshot {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`未知任务: ${taskId}`);
    }

    task.snapshot = {
      ...task.snapshot,
      status,
      ...defined({
        description: input.description,
        toolUseId: input.toolUseId,
        outputFile: input.outputFile,
        outputOffset: input.outputOffset,
        notified: input.notified,
        endTime: input.endTime,
        error: input.error,
      }),
      data: mergeData(task.snapshot.data, input.data),
    };

    this.emit(task.snapshot);
    return cloneSnapshot(task.snapshot);
  }

  private emit(snapshot: TaskSnapshot): void {
    const cloned = cloneSnapshot(snapshot);
    for (const subscriber of this.subscribers) {
      subscriber(cloned);
    }
  }
}

function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return {
    ...snapshot,
    data: cloneData(snapshot.data),
  };
}

function cloneData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return data ? { ...data } : undefined;
}

function mergeData(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!current && !next) return undefined;
  return { ...(current ?? {}), ...(next ?? {}) };
}

function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output as Partial<T>;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
