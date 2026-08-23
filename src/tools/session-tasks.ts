import type { ToolDefinition } from "../schema/message.js";
import type {
  SessionTaskStatus,
  SqliteSessionWorkbarRepository,
} from "../storage/sqlite/sqlite-session-workbar-repository.js";
import { logger } from "../observability/logger.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";

export interface BoundSessionTaskAuthority {
  readonly repository: SqliteSessionWorkbarRepository;
  readonly sessionId: string;
  readonly onChanged?: (revision: number) => void;
}

abstract class SessionTaskTool implements BaseTool {
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly toolset = "session-tasks";
  abstract readonly readOnly: boolean;

  constructor(protected readonly authority: BoundSessionTaskAuthority) {}
  abstract name(): string;
  abstract definition(): ToolDefinition;
  abstract execute(args: string, context?: ToolExecutionContext): Promise<string>;

  accesses(): ToolAccesses {
    return this.readOnly ? ToolAccesses.none() : ToolAccesses.all();
  }

  protected parse(args: string): Record<string, unknown> {
    try {
      const value = JSON.parse(args) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch {
      throw new Error("任务工具参数必须是 JSON 对象");
    }
  }
}

export class SessionTaskCreateTool extends SessionTaskTool {
  readonly readOnly = false;
  name(): string {
    return "task_create";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "在当前 Session 的持久化任务账本中创建任务。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          expectedRevision: { type: "integer", minimum: 0 },
        },
        required: ["title", "expectedRevision"],
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = this.parse(args);
    const result = this.authority.repository.createTask({
      sessionId: this.authority.sessionId,
      title: nonEmpty(input["title"], "title"),
      ...(input["detail"] === undefined ? {} : { detail: nonEmpty(input["detail"], "detail") }),
      expectedRevision: nonNegativeInteger(input["expectedRevision"], "expectedRevision"),
      idempotencyKey: requiredToolCallId(context),
    });
    notifyChanged(this.authority, result.revision);
    return JSON.stringify(result);
  }
}

export class SessionTaskUpdateTool extends SessionTaskTool {
  readonly readOnly = false;
  name(): string {
    return "task_update";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "以 revision CAS 更新当前 Session 的任务。",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          detail: { type: ["string", "null"] },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"],
          },
          expectedRevision: { type: "integer", minimum: 0 },
        },
        required: ["taskId", "expectedRevision"],
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = this.parse(args);
    const status = optionalStatus(input["status"]);
    if (input["title"] === undefined && input["detail"] === undefined && status === undefined) {
      throw new Error("task_update 至少需要 title/detail/status 之一");
    }
    const result = this.authority.repository.updateTask({
      sessionId: this.authority.sessionId,
      taskId: nonEmpty(input["taskId"], "taskId"),
      expectedRevision: nonNegativeInteger(input["expectedRevision"], "expectedRevision"),
      idempotencyKey: requiredToolCallId(context),
      ...(input["title"] === undefined ? {} : { title: nonEmpty(input["title"], "title") }),
      ...(input["detail"] === undefined
        ? {}
        : { detail: input["detail"] === null ? null : nonEmpty(input["detail"], "detail") }),
      ...(status === undefined ? {} : { status }),
    });
    notifyChanged(this.authority, result.revision);
    return JSON.stringify(result);
  }
}

export class SessionTaskGetTool extends SessionTaskTool {
  readonly readOnly = true;
  name(): string {
    return "task_get";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "读取当前 Session 的单个任务。",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    };
  }
  async execute(args: string): Promise<string> {
    const input = this.parse(args);
    return JSON.stringify(
      this.authority.repository.queryTasks({
        sessionId: this.authority.sessionId,
        taskId: nonEmpty(input["taskId"], "taskId"),
      }),
    );
  }
}

export function createSessionTaskTools(authority: BoundSessionTaskAuthority): readonly BaseTool[] {
  return [
    new SessionTaskCreateTool(authority),
    new SessionTaskUpdateTool(authority),
    new SessionTaskGetTool(authority),
  ];
}

/** Bounded prompt projection; completed/cancelled history is omitted first. */
export function buildSessionTaskPromptBlock(
  repository: SqliteSessionWorkbarRepository,
  sessionId: string,
  maxBytes = 8 * 1024,
): string {
  const snapshot = repository.queryTasks({ sessionId, limit: 200 });
  const active = snapshot.tasks.filter(
    (task) => task.status !== "completed" && task.status !== "cancelled",
  );
  if (active.length === 0) return "";
  const header = `Session tasks (revision ${snapshot.revision}):`;
  if (Buffer.byteLength(header, "utf8") > maxBytes) return "";
  const lines = [header];
  for (const task of active) {
    const line = `- [${task.status}] ${task.taskId}: ${task.title}${task.detail ? ` — ${task.detail}` : ""}`;
    if (Buffer.byteLength([...lines, line].join("\n"), "utf8") > maxBytes) {
      const omitted = "- … remaining tasks omitted by prompt budget";
      if (Buffer.byteLength([...lines, omitted].join("\n"), "utf8") <= maxBytes) {
        lines.push(omitted);
      }
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function requiredToolCallId(context: ToolExecutionContext | undefined): string {
  if (!context?.toolCallId) throw new Error("任务写工具需要 Runtime toolCallId 作为幂等键");
  return context.toolCallId;
}

function notifyChanged(authority: BoundSessionTaskAuthority, revision: number): void {
  try {
    authority.onChanged?.(revision);
  } catch (error) {
    // Mutation is already durable; observer failure must never turn it into an uncertain retry.
    logger.warn(
      { sessionId: authority.sessionId, revision, error: String(error) },
      "[SessionTasks] resource_changed 通知失败",
    );
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value.trim();
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${name} 必须是非负整数`);
  return value as number;
}

function optionalStatus(value: unknown): SessionTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "pending" &&
    value !== "in_progress" &&
    value !== "blocked" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  )
    throw new Error("status 非法");
  return value;
}
