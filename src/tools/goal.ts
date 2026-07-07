// Goal 工具:create_goal / get_goal / update_goal(ROADMAP 3.5 Goal Mode)。
//
// 对标 todo.ts / plan-exit.ts 的跨文件工具模式:独立文件定义 BaseTool 实现,
// 持有 GoalManager 单例引用(构造注入),不进 registry-impl.ts。
//
// 三个工具的职责:
//   - CreateGoalTool:create + setActive(新建目标并自动激活)
//   - GetGoalTool:查询单个/全部/当前激活目标(只读)
//   - UpdateGoalTool:更新目标字段(标题/描述/状态/进度/budget)
//
// 单例约束:三工具共享同一个 GoalManager 实例(由 host 注入),
// 与 PromptComposer 注入的也是同一份,杜绝跨实例不可见 bug。
//
// 并发安全:create/update 改全局状态(GoalManager 内存),声明 ToolAccesses.all(),
// 与同批次任何工具均冲突,退化为串行执行。get 是只读,声明 none()。

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import type { BudgetConfig } from "../engine/budget.js";
import { GoalManager, type Goal, type GoalStatus } from "../engine/goal-manager.js";

/** 合法状态白名单(校验 update_goal 的 status 入参) */
const VALID_STATUSES: ReadonlySet<string> = new Set<string>([
  "active",
  "paused",
  "blocked",
  "complete",
]);

/** 状态对应的标记(与 GoalManager.buildGoalContext 一致) */
function statusMark(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "🟢";
    case "paused":
      return "⏸️";
    case "blocked":
      return "🚫";
    case "complete":
      return "✅";
  }
}

/** 把单个 Goal 渲染为多行展示 */
function formatGoal(goal: Goal): string {
  const lines = [`- ${statusMark(goal.status)} **${goal.title}** (id: ${goal.id})`];
  lines.push(`  - 描述: ${goal.description}`);
  if (goal.progress) lines.push(`  - 进度: ${goal.progress}`);
  if (goal.blockedReason) lines.push(`  - 阻塞原因: ${goal.blockedReason}`);
  if (goal.budgetConfig) {
    const parts: string[] = [];
    const c = goal.budgetConfig;
    if (c.maxTurns !== undefined) parts.push(`${c.maxTurns} 轮`);
    if (c.maxTokens !== undefined) parts.push(`${c.maxTokens} tokens`);
    if (c.maxCostCNY !== undefined) parts.push(`¥${c.maxCostCNY}`);
    if (c.maxWallClockMs !== undefined) parts.push(`${c.maxWallClockMs}ms`);
    if (parts.length > 0) lines.push(`  - 预算: ${parts.join(" + ")}`);
  }
  return lines.join("\n");
}

/** 从 JSON 参数解析可选的 budget 配置;字段非法抛错 */
function parseBudgetConfig(parsed: Record<string, unknown>): BudgetConfig | undefined {
  const raw = parsed["budget"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("budget 必须是对象,含可选字段 maxTurns/maxTokens/maxCostCNY/maxWallClockMs");
  }
  const b = raw as Record<string, unknown>;
  const config: BudgetConfig = {};
  let hasAny = false;
  if (b.maxTurns !== undefined) {
    if (typeof b.maxTurns !== "number" || !Number.isFinite(b.maxTurns) || b.maxTurns <= 0) {
      throw new Error("budget.maxTurns 必须是正数");
    }
    config.maxTurns = b.maxTurns;
    hasAny = true;
  }
  if (b.maxTokens !== undefined) {
    if (typeof b.maxTokens !== "number" || !Number.isFinite(b.maxTokens) || b.maxTokens <= 0) {
      throw new Error("budget.maxTokens 必须是正数");
    }
    config.maxTokens = b.maxTokens;
    hasAny = true;
  }
  if (b.maxCostCNY !== undefined) {
    if (typeof b.maxCostCNY !== "number" || !Number.isFinite(b.maxCostCNY) || b.maxCostCNY <= 0) {
      throw new Error("budget.maxCostCNY 必须是正数");
    }
    config.maxCostCNY = b.maxCostCNY;
    hasAny = true;
  }
  if (b.maxWallClockMs !== undefined) {
    if (
      typeof b.maxWallClockMs !== "number" ||
      !Number.isFinite(b.maxWallClockMs) ||
      b.maxWallClockMs <= 0
    ) {
      throw new Error("budget.maxWallClockMs 必须是正数");
    }
    config.maxWallClockMs = b.maxWallClockMs;
    hasAny = true;
  }
  if (!hasAny) {
    throw new Error("budget 对象至少需含一个预算字段(maxTurns/maxTokens/maxCostCNY/maxWallClockMs)");
  }
  return config;
}

// ============================================================
// CreateGoalTool:创建目标并自动激活
// ============================================================
export class CreateGoalTool implements BaseTool {
  /** 非只读:create 改 GoalManager 全局状态 */
  readonly readOnly = false;

  constructor(private readonly manager: GoalManager) {}

  name(): string {
    return "create_goal";
  }

  /** 改全局状态,与同批次任何工具均冲突 → all() */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.all();
  }

  definition(): ToolDefinition {
    return {
      name: "create_goal",
      description:
        "创建一个长程目标并自动设为当前激活目标。用于锚定宏观目标与 budget 约束(轮次/Token/墙钟)。同一时刻仅一个 active goal。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "目标标题(简短一行)" },
          description: { type: "string", description: "目标详细描述" },
          budget: {
            type: "object",
            description: "可选预算约束,含 maxTurns/maxTokens/maxCostCNY/maxWallClockMs(至少一个)",
            properties: {
              maxTurns: { type: "number", description: "最大轮次" },
              maxTokens: { type: "number", description: "最大 Token 数" },
              maxCostCNY: { type: "number", description: "最大成本(人民币元)" },
              maxWallClockMs: { type: "number", description: "最大墙钟时间(毫秒)" },
            },
          },
        },
        required: ["title", "description"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      throw new Error("参数解析失败:期望 JSON 对象");
    }

    const title = parsed["title"];
    if (typeof title !== "string" || title.trim() === "") {
      throw new Error("create_goal 缺少必填参数 title(非空字符串)");
    }
    const description = parsed["description"];
    if (typeof description !== "string" || description.trim() === "") {
      throw new Error("create_goal 缺少必填参数 description(非空字符串)");
    }

    const budgetConfig = parseBudgetConfig(parsed);
    const goal = this.manager.create(title, description, budgetConfig);
    return `🎯 已创建并激活目标 ${goal.id}: ${goal.title}\n${formatGoal(goal)}`;
  }
}

// ============================================================
// GetGoalTool:查询目标(只读)
// ============================================================
export class GetGoalTool implements BaseTool {
  /** 只读:仅查询 GoalManager 内存状态 */
  readonly readOnly = true;

  constructor(private readonly manager: GoalManager) {}

  /** 无副作用,不与任何工具冲突 */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.none();
  }

  name(): string {
    return "get_goal";
  }

  definition(): ToolDefinition {
    return {
      name: "get_goal",
      description:
        "查询目标。无参数时返回当前激活目标(若无则返回全部);传 id 返回单个目标详情。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "目标 id(可选)。不传则返回激活目标或全部。" },
        },
      },
    };
  }

  async execute(args: string): Promise<string> {
    let parsed: Record<string, unknown> = {};
    if (args.trim() !== "") {
      try {
        parsed = JSON.parse(args) as Record<string, unknown>;
      } catch {
        throw new Error("参数解析失败:期望 JSON 对象");
      }
    }

    const id = parsed["id"];
    if (typeof id === "string" && id.trim() !== "") {
      const goal = this.manager.get(id);
      if (!goal) {
        throw new Error(`未找到目标 ${id}`);
      }
      return `🎯 目标详情:\n${formatGoal(goal)}`;
    }

    // 无 id:优先返回 active,无 active 返回全部
    const active = this.manager.getActive();
    if (active) {
      return `🎯 当前激活目标:\n${formatGoal(active)}`;
    }
    const all = this.manager.list();
    if (all.length === 0) {
      return "📋 当前无任何目标。可用 create_goal 创建。";
    }
    const lines = all.map(formatGoal);
    return `🎯 全部目标(共 ${all.length} 个,无激活):\n${lines.join("\n")}`;
  }
}

// ============================================================
// UpdateGoalTool:更新目标字段(状态/进度/标题/描述/budget)
// ============================================================
export class UpdateGoalTool implements BaseTool {
  /** 非只读:update 改 GoalManager 全局状态 */
  readonly readOnly = false;

  constructor(private readonly manager: GoalManager) {}

  /** 改全局状态,与同批次任何工具均冲突 → all() */
  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.all();
  }

  name(): string {
    return "update_goal";
  }

  definition(): ToolDefinition {
    return {
      name: "update_goal",
      description:
        "更新目标字段:title/description/status/progress/blockedReason/budget。status 合法值:active/paused/blocked/complete。把某目标置为 active 会自动把原 active 降级为 paused。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "目标 id(必填)" },
          title: { type: "string", description: "新标题" },
          description: { type: "string", description: "新描述" },
          status: {
            type: "string",
            description: "新状态",
            enum: ["active", "paused", "blocked", "complete"],
          },
          progress: { type: "string", description: "进度说明(自由文本)" },
          blockedReason: { type: "string", description: "阻塞原因(置 blocked 时建议提供)" },
          budget: {
            type: "object",
            description: "预算配置(覆盖原值)",
            properties: {
              maxTurns: { type: "number" },
              maxTokens: { type: "number" },
              maxCostCNY: { type: "number" },
              maxWallClockMs: { type: "number" },
            },
          },
        },
        required: ["id"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      throw new Error("参数解析失败:期望 JSON 对象");
    }

    const id = parsed["id"];
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("update_goal 缺少必填参数 id(字符串)");
    }

    // 校验 status
    if (parsed["status"] !== undefined) {
      if (typeof parsed["status"] !== "string" || !VALID_STATUSES.has(parsed["status"])) {
        throw new Error(
          `非法 status: ${String(parsed["status"])}。合法值:active/paused/blocked/complete`,
        );
      }
    }

    const patch: {
      title?: string;
      description?: string;
      status?: GoalStatus;
      progress?: string;
      blockedReason?: string;
      budgetConfig?: BudgetConfig;
    } = {};

    if (parsed["title"] !== undefined) {
      if (typeof parsed["title"] !== "string" || parsed["title"].trim() === "") {
        throw new Error("update_goal 的 title 必须是非空字符串");
      }
      patch.title = parsed["title"];
    }
    if (parsed["description"] !== undefined) {
      if (typeof parsed["description"] !== "string") {
        throw new Error("update_goal 的 description 必须是字符串");
      }
      patch.description = parsed["description"];
    }
    if (parsed["status"] !== undefined) {
      patch.status = parsed["status"] as GoalStatus;
    }
    if (parsed["progress"] !== undefined) {
      if (typeof parsed["progress"] !== "string") {
        throw new Error("update_goal 的 progress 必须是字符串");
      }
      patch.progress = parsed["progress"];
    }
    if (parsed["blockedReason"] !== undefined) {
      if (typeof parsed["blockedReason"] !== "string") {
        throw new Error("update_goal 的 blockedReason 必须是字符串");
      }
      patch.blockedReason = parsed["blockedReason"];
    }
    if (parsed["budget"] !== undefined) {
      patch.budgetConfig = parseBudgetConfig(parsed);
    }

    if (
      patch.title === undefined &&
      patch.description === undefined &&
      patch.status === undefined &&
      patch.progress === undefined &&
      patch.blockedReason === undefined &&
      patch.budgetConfig === undefined
    ) {
      throw new Error("update_goal 至少需提供一个可更新字段(title/description/status/progress/blockedReason/budget)");
    }

    const updated = this.manager.update(id, patch);
    if (!updated) {
      throw new Error(`未找到目标 ${id}`);
    }
    return `✅ 已更新目标 ${updated.id}:\n${formatGoal(updated)}`;
  }
}
