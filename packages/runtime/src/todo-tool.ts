import type { ToolDefinition } from "@pico/core";
import type { TodoItem, TodoPriority, TodoStatus } from "@pico/storage/todo-store";
import { ToolAccesses, type ToolAccesses as ToolAccessesValue } from "./tool-access.js";

/** Runtime 只依赖 Todo 的持久化能力，不绑定具体 SQLite 或宿主路径适配。 */
export interface TodoStorePort {
  load(): Promise<unknown>;
  add(content: string, priority?: TodoPriority): Promise<TodoItem>;
  update(
    id: number,
    patch: Partial<Pick<TodoItem, "content" | "priority" | "status">>,
  ): Promise<TodoItem | undefined>;
  toggle(id: number): Promise<TodoItem | undefined>;
  remove(id: number): Promise<boolean>;
  list(): TodoItem[];
  buildTodoContext(): Promise<string>;
}

/** 与外层 BaseTool 结构兼容的无文件副作用声明。 */
const NO_FILE_SIDE_EFFECTS = { kind: "none" } as const;

const VALID_ACTIONS: ReadonlySet<string> = new Set(["add", "update", "toggle", "remove", "list"]);
const VALID_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const VALID_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Storage-backed Todo 的运行时工具适配。 */
export class TodoTool {
  readonly readOnly = false;
  readonly permissionCategory = "bounded_control" as const;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly store: TodoStorePort) {}

  name(): string {
    return "todo";
  }

  definition(): ToolDefinition {
    return {
      name: "todo",
      description:
        "管理任务清单,支持 add/update/toggle/remove/list 操作,状态持久化到当前 Pico workspace state 的 todo.json",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型",
            enum: ["add", "update", "toggle", "remove", "list"],
          },
          content: { type: "string", description: "任务内容(add 时必填)" },
          id: { type: "number", description: "任务 id(update/toggle/remove 时必填)" },
          priority: {
            type: "string",
            description: "优先级(add 时可选,默认 medium)",
            enum: ["high", "medium", "low"],
          },
          status: {
            type: "string",
            description: "任务状态(update 时可选)",
            enum: ["pending", "in_progress", "completed"],
          },
        },
        required: ["action"],
      },
    };
  }

  /** Todo 的所有动作共享一个 durable resource，保守地全局互斥。 */
  accesses(_args: string): ToolAccessesValue {
    return ToolAccesses.all();
  }

  async execute(args: string): Promise<string> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      throw new Error("参数解析失败:期望 JSON 对象");
    }

    const action = parsed["action"];
    if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
      throw new Error(`非法 action: ${String(action)}。合法值:add/update/toggle/remove/list`);
    }

    switch (action) {
      case "add":
        return this.handleAdd(parsed);
      case "update":
        return this.handleUpdate(parsed);
      case "toggle":
        return this.handleToggle(parsed);
      case "remove":
        return this.handleRemove(parsed);
      case "list":
        return this.handleList();
      default:
        throw new Error(`未知 action: ${action}`);
    }
  }

  private async handleAdd(parsed: Record<string, unknown>): Promise<string> {
    const content = parsed["content"];
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("add 缺少必填参数 content(非空字符串)");
    }

    let priority: TodoPriority = "medium";
    const rawPriority = parsed["priority"];
    if (rawPriority !== undefined) {
      if (typeof rawPriority !== "string" || !VALID_PRIORITIES.has(rawPriority)) {
        throw new Error(`非法 priority: ${String(rawPriority)}。合法值:high/medium/low`);
      }
      priority = rawPriority as TodoPriority;
    }

    const item = await this.store.add(content, priority);
    return `✅ 已添加任务 #${item.id} (${item.priority}): ${item.content}\n\n${await this.renderSnapshot()}`;
  }

  private async handleUpdate(parsed: Record<string, unknown>): Promise<string> {
    const id = parseId(parsed);
    if (id === undefined) throw new Error("update 缺少必填参数 id(正整数)");

    const patch: Partial<Pick<TodoItem, "content" | "priority" | "status">> = {};
    if (parsed["content"] !== undefined) {
      if (typeof parsed["content"] !== "string" || parsed["content"].trim() === "") {
        throw new Error("update 的 content 必须是非空字符串");
      }
      patch.content = parsed["content"];
    }
    if (parsed["priority"] !== undefined) {
      if (typeof parsed["priority"] !== "string" || !VALID_PRIORITIES.has(parsed["priority"])) {
        throw new Error(`非法 priority: ${String(parsed["priority"])}。合法值:high/medium/low`);
      }
      patch.priority = parsed["priority"] as TodoPriority;
    }
    if (parsed["status"] !== undefined) {
      if (typeof parsed["status"] !== "string" || !VALID_STATUSES.has(parsed["status"])) {
        throw new Error(`非法 status: ${String(parsed["status"])}。合法值:pending/in_progress/completed`);
      }
      patch.status = parsed["status"] as TodoStatus;
    }
    if (patch.content === undefined && patch.priority === undefined && patch.status === undefined) {
      throw new Error("update 至少需提供 content/priority/status 之一");
    }

    const updated = await this.store.update(id, patch);
    if (!updated) throw new Error(`未找到任务 #${id}`);
    return `✅ 已更新任务 #${updated.id}: ${formatItem(updated)}\n\n${await this.renderSnapshot()}`;
  }

  private async handleToggle(parsed: Record<string, unknown>): Promise<string> {
    const id = parseId(parsed);
    if (id === undefined) throw new Error("toggle 缺少必填参数 id(正整数)");
    const toggled = await this.store.toggle(id);
    if (!toggled) throw new Error(`未找到任务 #${id}`);
    return `✅ 已切换任务 #${toggled.id} 状态: ${formatItem(toggled)}\n\n${await this.renderSnapshot()}`;
  }

  private async handleRemove(parsed: Record<string, unknown>): Promise<string> {
    const id = parseId(parsed);
    if (id === undefined) throw new Error("remove 缺少必填参数 id(正整数)");
    if (!(await this.store.remove(id))) throw new Error(`未找到任务 #${id}`);
    return `🗑️ 已删除任务 #${id}\n\n${await this.renderSnapshot()}`;
  }

  private async handleList(): Promise<string> {
    await this.store.load();
    const items = this.store.list();
    if (items.length === 0) return "📋 当前清单为空";
    return `📋 当前清单(${items.length} 项):\n${items
      .map((item) => `- ${statusMark(item.status)} #${item.id} (${item.priority}) ${item.content}`)
      .join("\n")}`;
  }

  private async renderSnapshot(): Promise<string> {
    return (await this.store.buildTodoContext()) || "📋 当前清单为空";
  }
}

function statusMark(status: TodoStatus): string {
  switch (status) {
    case "pending":
      return "[ ]";
    case "in_progress":
      return "[~]";
    case "completed":
      return "[x]";
  }
}

function formatItem(item: TodoItem): string {
  return `${statusMark(item.status)} (${item.priority}) ${item.content}`;
}

function parseId(parsed: Record<string, unknown>): number | undefined {
  const raw = parsed["id"];
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const id = Number(raw.trim());
    if (id > 0) return id;
  }
  return undefined;
}
