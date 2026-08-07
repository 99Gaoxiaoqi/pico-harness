// 后台任务控制工具:task_list / task_output / task_stop。
// 对应课程第 06 讲,与 BashTool 的 background=true 配套。
//
// 三个工具共享 parseTaskIdArgs 和外部注入的 BackgroundManager 实例,
// 独立文件实现,不进 registry-impl.ts,由 default-registry.ts 在合并阶段统一挂载。

import type { BaseTool } from "./registry.js";
import { NO_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { BackgroundManager } from "./background-manager.js";

export class TaskListTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly backgroundManager: BackgroundManager) {}

  name(): string {
    return "task_list";
  }

  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "task_list",
      description: "列出当前会话中由 bash background=true 启动的后台任务。",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };
  }

  async execute(_args: string): Promise<string> {
    return JSON.stringify(
      this.backgroundManager.list().map((task) => ({
        ...task,
        startedAt: task.startedAt.toISOString(),
        endedAt: task.endedAt?.toISOString() ?? null,
      })),
    );
  }
}

export class TaskOutputTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly backgroundManager: BackgroundManager) {}

  name(): string {
    return "task_output";
  }

  accesses(_args?: string): ToolAccesses {
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
    return JSON.stringify(this.backgroundManager.output(input.taskId, input.tail));
  }
}

export class TaskStopTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly backgroundManager: BackgroundManager) {}

  name(): string {
    return "task_stop";
  }

  accesses(_args?: string): ToolAccesses {
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
    const task = await this.backgroundManager.stop(input.taskId);
    return JSON.stringify({
      ...task,
      startedAt: task.startedAt.toISOString(),
      endedAt: task.endedAt?.toISOString() ?? null,
    });
  }
}

function parseTaskIdArgs(args: string): { taskId: string; tail?: number } {
  try {
    const input = JSON.parse(args) as { taskId?: string; tail?: number };
    if (!input.taskId) {
      throw new Error("缺少 taskId 字段");
    }
    return {
      taskId: input.taskId,
      ...(input.tail !== undefined ? { tail: input.tail } : {}),
    };
  } catch (err) {
    if (err instanceof Error && err.message === "缺少 taskId 字段") {
      throw err;
    }
    throw new Error("参数解析失败: 期望 JSON 含 taskId 字段", { cause: err });
  }
}
