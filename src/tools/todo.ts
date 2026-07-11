// TodoTool:结构化任务清单工具。
//
// 对应课程工具层的 SkillViewTool 模式:独立文件定义 BaseTool 实现,
// 持有存储层(TodoStore)引用,不进 registry-impl.ts。
//
// 提供给大模型的能力:add/update/toggle/remove/list,操作结果持久化到
// .claw/todo.json,并由 PromptComposer 注入 system prompt(见 composer.ts)。
//
// 并发安全:所有 action 都写同一个 todo.json,故声明 ToolAccesses.all(),
// 与同批次任何工具均冲突,退化为串行执行,避免清单覆盖写竞态。

import type { BaseTool } from "./registry.js";
import { NO_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import {
  TodoStore,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "../context/todo-store.js";

/** 合法 action 白名单 */
const VALID_ACTIONS: ReadonlySet<string> = new Set(["add", "update", "toggle", "remove", "list"]);

/** 合法优先级白名单 */
const VALID_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);

/** 合法状态白名单 */
const VALID_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** 状态对应的 checkbox 标记(与 TodoStore.buildTodoContext 一致) */
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

/**
 * 结构化任务清单工具。
 *
 * 构造时绑定一个 TodoStore;首次 execute 前会触发 store.load()(add/update
 * 等方法内部已 await load,故无需额外预热)。
 */
export class TodoTool implements BaseTool {
  /** 非只读:所有 action 都可能写 todo.json */
  readonly readOnly = false;
  /** .claw/todo.json 是会话内部状态，不属于 code rewind 范围。 */
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly store: TodoStore) {}

  name(): string {
    return "todo";
  }

  definition(): ToolDefinition {
    return {
      name: "todo",
      description:
        "管理任务清单,支持 add/update/toggle/remove/list 操作,状态持久化到 .claw/todo.json",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型",
            enum: ["add", "update", "toggle", "remove", "list"],
          },
          content: {
            type: "string",
            description: "任务内容(add 时必填)",
          },
          id: {
            type: "number",
            description: "任务 id(update/toggle/remove 时必填)",
          },
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

  /**
   * 声明资源访问集:所有 action 都写同一文件 todo.json,全量互斥。
   * 即便是 list(只读),也保守声明 all,避免与并发写竞态读到半写状态。
   */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.all();
  }

  async execute(args: string): Promise<string> {
    // 参数解析:延迟反序列化,解析失败给模型明确的中文报错
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
        // 理论不可达(已被白名单拦截)
        throw new Error(`未知 action: ${action}`);
    }
  }

  /** add:content 必填,priority 可选(默认 medium) */
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
    return `✅ 已添加任务 #${item.id} (${item.priority}): ${item.content}`;
  }

  /** update:id 必填,可选 content/priority/status */
  private async handleUpdate(parsed: Record<string, unknown>): Promise<string> {
    const id = parseId(parsed);
    if (id === undefined) {
      throw new Error("update 缺少必填参数 id(正整数)");
    }

    const patch: { content?: string; priority?: TodoPriority; status?: TodoStatus } = {};

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
        throw new Error(
          `非法 status: ${String(parsed["status"])}。合法值:pending/in_progress/completed`,
        );
      }
      patch.status = parsed["status"] as TodoStatus;
    }

    if (patch.content === undefined && patch.priority === undefined && patch.status === undefined) {
      throw new Error("update 至少需提供 content/priority/status 之一");
    }

    const updated = await this.store.update(id, patch);
    if (!updated) {
      throw new Error(`未找到任务 #${id}`);
    }
    return `✅ 已更新任务 #${updated.id}: ${formatItem(updated)}`;
  }

  /** toggle:id 必填,循环推进状态 */
  private async handleToggle(parsed: Record<string, unknown>): Promise<string> {
    const id = parseId(parsed);
    if (id === undefined) {
      throw new Error("toggle 缺少必填参数 id(正整数)");
    }
    const toggled = await this.store.toggle(id);
    if (!toggled) {
      throw new Error(`未找到任务 #${id}`);
    }
    return `✅ 已切换任务 #${toggled.id} 状态: ${formatItem(toggled)}`;
  }

  /** remove:id 必填 */
  private async handleRemove(parsed: Record<string, unknown>): Promise<string> {
    const id = parseId(parsed);
    if (id === undefined) {
      throw new Error("remove 缺少必填参数 id(正整数)");
    }
    const removed = await this.store.remove(id);
    if (!removed) {
      throw new Error(`未找到任务 #${id}`);
    }
    return `🗑️ 已删除任务 #${id}`;
  }

  /** list:渲染当前清单 */
  private async handleList(): Promise<string> {
    await this.store.load();
    const items = this.store.list();
    if (items.length === 0) {
      return "📋 当前清单为空";
    }
    const lines = items.map(
      (it) => `- ${statusMark(it.status)} #${it.id} (${it.priority}) ${it.content}`,
    );
    return `📋 当前清单(${items.length} 项):\n${lines.join("\n")}`;
  }
}

/** 格式化单条任务为一行展示 */
function formatItem(item: TodoItem): string {
  return `${statusMark(item.status)} (${item.priority}) ${item.content}`;
}

/** 从参数解析 id:必须是正整数(number 或数字字符串) */
function parseId(parsed: Record<string, unknown>): number | undefined {
  const raw = parsed["id"];
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (n > 0) return n;
  }
  return undefined;
}
