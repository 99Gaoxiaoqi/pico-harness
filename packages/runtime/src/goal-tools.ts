import type { ToolDefinition } from "@pico/core";
import type { BudgetConfig } from "./budget.js";
import { GoalManager, type Goal, type GoalStatus } from "./goal-manager.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";

/** 合法状态白名单（校验 update_goal 的 status 输入）。 */
const VALID_STATUSES: ReadonlySet<string> = new Set(["active", "paused", "blocked", "complete"]);

/** 状态对应的展示标记，与 GoalManager.buildGoalContext 保持一致。 */
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

function formatGoal(goal: Goal): string {
  const lines = [`- ${statusMark(goal.status)} **${goal.title}** (id: ${goal.id})`];
  lines.push(`  - 描述: ${goal.description}`);
  if (goal.progress) lines.push(`  - 进度: ${goal.progress}`);
  if (goal.blockedReason) lines.push(`  - 阻塞原因: ${goal.blockedReason}`);
  if (goal.budgetConfig) {
    const parts: string[] = [];
    const budget = goal.budgetConfig;
    if (budget.maxTurns !== undefined) parts.push(`${budget.maxTurns} 轮`);
    if (budget.maxTokens !== undefined) parts.push(`${budget.maxTokens} tokens`);
    if (budget.maxCostCNY !== undefined) parts.push(`¥${budget.maxCostCNY}`);
    if (budget.maxWallClockMs !== undefined) parts.push(`${budget.maxWallClockMs}ms`);
    if (parts.length > 0) lines.push(`  - 预算: ${parts.join(" + ")}`);
    lines.push(
      `  - 已消耗: ${goal.budgetUsage.turns} 轮 + ${goal.budgetUsage.tokens} tokens + ¥${goal.budgetUsage.costCNY.toFixed(4)}`,
    );
  }
  if (goal.consecutiveNoProgress && goal.consecutiveNoProgress >= 3) {
    lines.push(`  - ⚠ 连续无进展: ${goal.consecutiveNoProgress} 轮`);
  }
  return lines.join("\n");
}

function parseBudgetConfig(parsed: Record<string, unknown>): BudgetConfig | undefined {
  const raw = parsed["budget"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("budget 必须是对象,含可选字段 maxTurns/maxTokens/maxCostCNY/maxWallClockMs");
  }
  const budget = raw as Record<string, unknown>;
  const config: BudgetConfig = {};
  let hasAny = false;
  if (budget.maxTurns !== undefined) {
    if (
      typeof budget.maxTurns !== "number" ||
      !Number.isFinite(budget.maxTurns) ||
      budget.maxTurns <= 0
    ) {
      throw new Error("budget.maxTurns 必须是正数");
    }
    config.maxTurns = budget.maxTurns;
    hasAny = true;
  }
  if (budget.maxTokens !== undefined) {
    if (
      typeof budget.maxTokens !== "number" ||
      !Number.isFinite(budget.maxTokens) ||
      budget.maxTokens <= 0
    ) {
      throw new Error("budget.maxTokens 必须是正数");
    }
    config.maxTokens = budget.maxTokens;
    hasAny = true;
  }
  if (budget.maxCostCNY !== undefined) {
    if (
      typeof budget.maxCostCNY !== "number" ||
      !Number.isFinite(budget.maxCostCNY) ||
      budget.maxCostCNY <= 0
    ) {
      throw new Error("budget.maxCostCNY 必须是正数");
    }
    config.maxCostCNY = budget.maxCostCNY;
    hasAny = true;
  }
  if (budget.maxWallClockMs !== undefined) {
    if (
      typeof budget.maxWallClockMs !== "number" ||
      !Number.isFinite(budget.maxWallClockMs) ||
      budget.maxWallClockMs <= 0
    ) {
      throw new Error("budget.maxWallClockMs 必须是正数");
    }
    config.maxWallClockMs = budget.maxWallClockMs;
    hasAny = true;
  }
  if (!hasAny) {
    throw new Error(
      "budget 对象至少需含一个预算字段(maxTurns/maxTokens/maxCostCNY/maxWallClockMs)",
    );
  }
  return config;
}

/** 创建目标并将其自动激活。 */
export class CreateGoalTool {
  readonly readOnly = false;
  readonly permissionCategory = "bounded_control" as const;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(private readonly manager: GoalManager) {}

  name(): string {
    return "create_goal";
  }

  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.all();
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

/** 查询当前激活目标、全部目标或指定目标。 */
export class GetGoalTool {
  readonly readOnly = true;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(private readonly manager: GoalManager) {}

  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.none();
  }

  name(): string {
    return "get_goal";
  }

  definition(): ToolDefinition {
    return {
      name: "get_goal",
      description: "查询目标。无参数时返回当前激活目标(若无则返回全部);传 id 返回单个目标详情。",
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
      if (!goal) throw new Error(`未找到目标 ${id}`);
      return `🎯 目标详情:\n${formatGoal(goal)}`;
    }

    const active = this.manager.getActive();
    if (active) return `🎯 当前激活目标:\n${formatGoal(active)}`;
    const all = this.manager.list();
    if (all.length === 0) return "📋 当前无任何目标。可用 create_goal 创建。";
    return `🎯 全部目标(共 ${all.length} 个,无激活):\n${all.map(formatGoal).join("\n")}`;
  }
}

/** 更新目标状态、展示文本或预算。 */
export class UpdateGoalTool {
  readonly readOnly = false;
  readonly permissionCategory = "bounded_control" as const;
  readonly fileSideEffects = { kind: "none" } as const;

  constructor(private readonly manager: GoalManager) {}

  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.all();
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
    if (parsed["status"] !== undefined) patch.status = parsed["status"] as GoalStatus;
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
      const budgetConfig = parseBudgetConfig(parsed);
      if (!budgetConfig) throw new Error("update_goal 的 budget 无效");
      patch.budgetConfig = budgetConfig;
    }

    if (
      patch.title === undefined &&
      patch.description === undefined &&
      patch.status === undefined &&
      patch.progress === undefined &&
      patch.blockedReason === undefined &&
      patch.budgetConfig === undefined
    ) {
      throw new Error(
        "update_goal 至少需提供一个可更新字段(title/description/status/progress/blockedReason/budget)",
      );
    }

    const updated = this.manager.update(id, patch);
    if (!updated) throw new Error(`未找到目标 ${id}`);
    return `✅ 已更新目标 ${updated.id}:\n${formatGoal(updated)}`;
  }
}
