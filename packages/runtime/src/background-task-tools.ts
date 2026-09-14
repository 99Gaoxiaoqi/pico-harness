import type { ToolDefinition } from "@pico/core";
import { ToolAccesses, type ToolAccesses as ToolAccessesValue } from "./tool-access.js";

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

export interface BackgroundTaskPort {
  list(): BackgroundTaskRecord[];
  output(taskId: string, tail?: number): BackgroundTaskOutput;
  stop(taskId: string): Promise<BackgroundTaskRecord>;
}

export interface SessionTaskListPort {
  readonly list: () => unknown;
}

const NO_FILE_SIDE_EFFECTS = { kind: "none" } as const;

export class TaskListTool {
  readonly readOnly = true;

  constructor(
    private readonly backgroundTasks: BackgroundTaskPort,
    private readonly sessionTasks?: SessionTaskListPort,
  ) {}

  name(): string {
    return "task_list";
  }

  accesses(_args?: string): ToolAccessesValue {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "task_list",
      description:
        "列出指定任务域。scope=background 列出 bash background=true 后台进程；scope=session 读取当前 Session 的持久化任务账本。",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["background", "session"],
            description: "必填任务域。",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    };
  }

  async execute(args: string): Promise<string> {
    const scope = parseTaskListScope(args);
    if (scope === "session") {
      if (!this.sessionTasks) throw new Error("当前 Runtime 未连接 Session 任务账本");
      return JSON.stringify(this.sessionTasks.list());
    }
    return JSON.stringify(
      this.backgroundTasks.list().map((task) => ({
        ...task,
        startedAt: task.startedAt.toISOString(),
        endedAt: task.endedAt?.toISOString() ?? null,
      })),
    );
  }
}

export class TaskOutputTool {
  readonly readOnly = true;

  constructor(private readonly backgroundTasks: BackgroundTaskPort) {}

  name(): string {
    return "task_output";
  }

  accesses(_args?: string): ToolAccessesValue {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "task_output",
      description: "读取指定后台任务的 stdout/stderr 环形缓冲输出。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 ID。" },
          tail: { type: "number", description: "可选,只返回 stdout/stderr 末尾 N 个字符。" },
        },
        required: ["taskId"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseTaskIdArgs(args);
    return JSON.stringify(this.backgroundTasks.output(input.taskId, input.tail));
  }
}

export class TaskStopTool {
  readonly readOnly = false;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly backgroundTasks: BackgroundTaskPort) {}

  name(): string {
    return "task_stop";
  }

  accesses(_args?: string): ToolAccessesValue {
    return ToolAccesses.all();
  }

  definition(): ToolDefinition {
    return {
      name: "task_stop",
      description: "停止指定后台任务。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "后台任务 ID。" },
        },
        required: ["taskId"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseTaskIdArgs(args);
    const task = await this.backgroundTasks.stop(input.taskId);
    return JSON.stringify({
      ...task,
      startedAt: task.startedAt.toISOString(),
      endedAt: task.endedAt?.toISOString() ?? null,
    });
  }
}

function parseTaskListScope(args: string): "background" | "session" {
  if (!args.trim()) throw new Error("参数解析失败: scope 必须是 background 或 session");
  try {
    const input = JSON.parse(args) as unknown;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("参数解析失败: 期望 JSON 对象");
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "scope")) {
      throw new Error("参数解析失败: task_list 只接受 scope 字段");
    }
    if (record.scope === "background") return "background";
    if (record.scope === "session") return "session";
    throw new Error("scope 必须是 background 或 session");
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("scope ") || error.message.startsWith("参数解析失败:"))
    ) {
      throw error;
    }
    throw new Error("参数解析失败: 期望 JSON 对象", { cause: error });
  }
}

function parseTaskIdArgs(args: string): { taskId: string; tail?: number } {
  try {
    const input = JSON.parse(args) as { taskId?: string; tail?: number };
    if (!input.taskId) throw new Error("缺少 taskId 字段");
    return {
      taskId: input.taskId,
      ...(input.tail !== undefined ? { tail: input.tail } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "缺少 taskId 字段") throw error;
    throw new Error("参数解析失败: 期望 JSON 含 taskId 字段", { cause: error });
  }
}
