import type { ToolDefinition } from "@pico/core";
import type { BudgetConfig } from "./budget.js";
import { GoalManager, type Goal, type GoalStatus } from "./goal-manager.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";

/** 合法状态白名单（校验 update_goal 的 status 输入）。 */
const VALID_STATUSES: ReadonlySet<string> = new Set(["active", "paused", "complete"]);

/** 状态对应的展示标记，与 GoalManager.buildGoalContext 保持一致。 */
function statusMark(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "🟢";
    case "waiting":
      return "⏳";
    case "paused":
      return "⏸️";
    case "impossible":
      return "🚫";
    case "stalled":
      return "⚠️";
    case "budget_limited":
      return "💸";
    case "max_iterations":
      return "🔢";
    case "cleared":
      return "🚫";
    case "achieved":
      return "✅";
  }
}

function formatGoal(goal: Goal): string {
  const lines = [`- ${statusMark(goal.status)} **${goal.title}** (id: ${goal.id})`];
  lines.push(`  - 描述: ${goal.description}`);
  lines.push("  - 完成标准:", ...goal.completionCriteria.map((item) => `    - ${item}`));
  if (goal.constraints?.length)
    lines.push("  - 约束:", ...goal.constraints.map((item) => `    - ${item}`));
  if (goal.progress) lines.push(`  - 进度: ${goal.progress}`);
  if (goal.blockedReason) lines.push(`  - 阻塞原因: ${goal.blockedReason}`);
  if (goal.waitingReason) lines.push(`  - 等待原因: ${goal.waitingReason}`);
  lines.push(`  - 迭代: ${goal.budgetUsage.turns}/${goal.maxIterations}`);
  if (goal.lastEvaluation)
    lines.push(
      `  - 最近评估: ${goal.lastEvaluation.outcome} · ${goal.lastEvaluation.reason || "无原因"}`,
    );
  if (goal.evidence.length) lines.push(`  - 证据: ${goal.evidence.slice(-3).join("；")}`);
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
  if (goal.consecutiveNoProgress > 0) {
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

function parseTextList(value: unknown, field: string, required: boolean): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`${field} 必须是非空字符串数组`);
  }
  return value.map((item) => (item as string).trim());
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
        "创建一个长程目标并自动设为当前 Goal。每个 Goal 必须明确给出可独立验收的 completionCriteria；AgentEngine 不会在本次 Run 内隐藏续跑，Host 会在本 Run 结束验收后决定是否续跑。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "目标标题(简短一行)" },
          description: { type: "string", description: "目标详细描述" },
          completionCriteria: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: { type: "string" },
            description: "全部必须满足的可验证完成标准",
          },
          constraints: { type: "array", items: { type: "string" }, description: "执行约束" },
          maxIterations: { type: "number", description: "最多 Goal Run 数，默认 50" },
          blockCap: { type: "number", description: "连续无进展上限，默认 8" },
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
        required: ["title", "description", "completionCriteria"],
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

    const completionCriteria = parseTextList(
      parsed["completionCriteria"],
      "completionCriteria",
      true,
    )!;
    if (completionCriteria.length > 30)
      throw new Error("completionCriteria 最多 30 条，以便逐项保存验收证据");
    const constraints = parseTextList(parsed["constraints"], "constraints", false);
    const maxIterations = parsed["maxIterations"] ?? 50;
    const blockCap = parsed["blockCap"] ?? 8;
    if (!Number.isSafeInteger(maxIterations) || (maxIterations as number) <= 0)
      throw new Error("maxIterations 必须是正整数");
    if (!Number.isSafeInteger(blockCap) || (blockCap as number) <= 0)
      throw new Error("blockCap 必须是正整数");

    const budgetConfig = parseBudgetConfig(parsed);
    const goal = this.manager.create({
      title,
      description,
      completionCriteria,
      ...(constraints ? { constraints } : {}),
      ...(budgetConfig !== undefined ? { budgetConfig } : {}),
      maxIterations: maxIterations as number,
      blockCap: blockCap as number,
    });
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
        "更新目标字段。status=complete 仅请求独立验收，不能直接完成 Goal；status=paused 暂停；status=active 恢复暂停的 Goal。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "目标 id(必填)" },
          title: { type: "string", description: "新标题" },
          description: { type: "string", description: "新描述" },
          status: {
            type: "string",
            description: "complete 表示请求独立验收，不直接更改为 achieved",
            enum: ["active", "paused", "complete"],
          },
          progress: { type: "string", description: "进度说明(自由文本)" },
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
        throw new Error(`非法 status: ${String(parsed["status"])}。合法值:active/paused/complete`);
      }
    }

    const patch: {
      title?: string;
      description?: string;
      progress?: string;
      budgetConfig?: BudgetConfig;
      completionRequested?: boolean;
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
    const requestedStatus = parsed["status"] as string | undefined;
    if (parsed["progress"] !== undefined) {
      if (typeof parsed["progress"] !== "string") {
        throw new Error("update_goal 的 progress 必须是字符串");
      }
      patch.progress = parsed["progress"];
    }
    if (requestedStatus === "complete") patch.completionRequested = true;
    if (parsed["budget"] !== undefined) {
      const budgetConfig = parseBudgetConfig(parsed);
      if (!budgetConfig) throw new Error("update_goal 的 budget 无效");
      patch.budgetConfig = budgetConfig;
    }

    if (
      patch.title === undefined &&
      patch.description === undefined &&
      requestedStatus === undefined &&
      patch.progress === undefined &&
      patch.budgetConfig === undefined
    ) {
      throw new Error(
        "update_goal 至少需提供一个可更新字段(title/description/status/progress/budget)",
      );
    }

    const target = this.manager.get(id);
    if (!target) throw new Error(`未找到目标 ${id}`);
    const hasPatch = Object.keys(patch).length > 0;
    let updated: Goal | undefined;
    if (requestedStatus === "paused") {
      if (hasPatch) this.manager.update(id, patch);
      updated = this.manager.pause(id, "模型请求暂停");
    }
    else if (requestedStatus === "active") {
      if (target.status !== "active" && target.status !== "waiting" && target.status !== "paused") {
        throw new Error(`Goal ${id} 的状态 ${target.status} 不能恢复`);
      }
      if (hasPatch) this.manager.update(id, patch);
      updated = target.status === "paused" ? this.manager.resume(id) : this.manager.get(id);
    } else updated = this.manager.update(id, patch);
    if (!updated) throw new Error(`未找到目标 ${id}`);
    return requestedStatus === "complete"
      ? `🧾 已请求 Goal ${updated.id} 验收；是否完成将由独立评估器根据完成标准和证据决定。\n${formatGoal(updated)}`
      : `✅ 已更新目标 ${updated.id}:\n${formatGoal(updated)}`;
  }
}
