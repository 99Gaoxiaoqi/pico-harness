import type { ToolDefinition } from "@pico/core";
import { GoalManager, type Goal, type GoalStatus } from "./goal-manager.js";
import { ToolAccesses, type ToolAccesses as ToolAccessSet } from "./tool-access.js";

function statusMark(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "🟢";
    case "waiting":
      return "⏳";
    case "paused":
      return "⏸️";
    case "achieved":
      return "✅";
    case "impossible":
      return "🚫";
    case "stalled":
      return "⚠️";
    case "budget_limited":
      return "💸";
    case "max_iterations":
      return "🔢";
    case "cleared":
      return "🗑️";
  }
}

function formatGoal(goal: Goal): string {
  const usedTokens = Math.max(0, goal.tokensNow - goal.tokensAtStart);
  return [
    `🎯 ${statusMark(goal.status)} ${goal.condition}`,
    `- id: ${goal.id}`,
    `- revision: ${goal.revision}`,
    `- 轮次: ${goal.iterations}/${goal.maxIterations}`,
    `- Token: ${usedTokens}${goal.tokenBudget === undefined ? "" : `/${goal.tokenBudget}`}`,
    `- 连续无进展: ${goal.consecutiveNoProgress}/${goal.blockCap}`,
    ...(goal.lastReason ? [`- 最近状态: ${goal.lastReason}`] : []),
    ...(goal.lastEvaluation ? [`- 最近验收: ${goal.lastEvaluation.reason}`] : []),
  ].join("\n");
}

function parseObject(
  args: string,
  toolName: string,
  emptyAllowed = false,
): Record<string, unknown> {
  if (emptyAllowed && args.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(args);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${toolName} 参数必须是 JSON 对象`);
  }
}

function requiredId(parsed: Record<string, unknown>, toolName: string): string {
  const id = parsed["id"];
  if (typeof id !== "string" || id.trim() === "") throw new Error(`${toolName} 缺少必填参数 id`);
  return id.trim();
}

function expectedRevision(parsed: Record<string, unknown>): number | undefined {
  const value = parsed["expectedRevision"];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("expectedRevision 必须是非负安全整数");
  return value as number;
}

abstract class GoalTool {
  readonly fileSideEffects = { kind: "none" } as const;
  protected readonly manager: GoalManager;

  constructor(manager: GoalManager) {
    this.manager = manager;
  }
  accesses(_args: string): ToolAccessSet {
    return ToolAccesses.none();
  }
  abstract name(): string;
  abstract definition(): ToolDefinition;
  abstract execute(args: string): Promise<string>;
}

export class CreateGoalTool extends GoalTool {
  readonly readOnly = false;
  readonly permissionCategory = "bounded_control" as const;

  name(): string {
    return "create_goal";
  }
  override accesses(_args: string): ToolAccessSet {
    return ToolAccesses.all();
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "创建一个长程 Goal。condition 是唯一完成标准，由 Host 在每个 Run 结束后独立验收。",
      inputSchema: {
        type: "object",
        properties: {
          condition: { type: "string", description: "最多 500 字符，描述要达成的结果" },
          tokenBudget: {
            type: "integer",
            minimum: 1_000,
            description: "可选的 Goal 主执行 Token 上限",
          },
          maxIterations: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "最多 Goal Run 数，默认 50",
          },
          blockCap: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "连续无进展上限，默认 8",
          },
          expectedRevision: {
            type: "integer",
            minimum: 0,
            description: "替换终态 Goal 时的 CAS revision",
          },
        },
        required: ["condition"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    const parsed = parseObject(args, this.name());
    const condition = parsed["condition"];
    if (typeof condition !== "string") throw new Error("create_goal 缺少必填参数 condition");
    const tokenBudget = parsed["tokenBudget"];
    const maxIterations = parsed["maxIterations"];
    const blockCap = parsed["blockCap"];
    const expected = expectedRevision(parsed);
    const goal = this.manager.create(
      {
        condition,
        ...(tokenBudget === undefined ? {} : { tokenBudget: tokenBudget as number }),
        ...(maxIterations === undefined ? {} : { maxIterations: maxIterations as number }),
        ...(blockCap === undefined ? {} : { blockCap: blockCap as number }),
      },
      expected,
    );
    return `Goal 已创建并激活。\n${formatGoal(goal)}`;
  }
}

export class GetGoalTool extends GoalTool {
  readonly readOnly = true;

  name(): string {
    return "get_goal";
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: "查询当前 Goal 或按 id 查询；返回状态、轮次、Token 用量及最近验收理由。",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    };
  }
  async execute(args: string): Promise<string> {
    const parsed = parseObject(args, this.name(), true);
    const id = parsed["id"];
    const goal = typeof id === "string" ? this.manager.get(id) : this.manager.getCurrent();
    return goal ? formatGoal(goal) : "当前没有 Goal。";
  }
}

abstract class GoalControlTool extends GoalTool {
  readonly readOnly = false;
  readonly permissionCategory = "bounded_control" as const;
  protected async control(
    args: string,
    toolName: string,
  ): Promise<{ id: string; revision?: number }> {
    const parsed = parseObject(args, toolName);
    const revision = expectedRevision(parsed);
    return { id: requiredId(parsed, toolName), ...(revision === undefined ? {} : { revision }) };
  }
  protected schema(name: string, description: string): ToolDefinition {
    return {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Goal id" },
          expectedRevision: { type: "integer", minimum: 0, description: "防止并发控制覆盖新状态" },
        },
        required: ["id", "expectedRevision"],
      },
    };
  }
}

export class PauseGoalTool extends GoalControlTool {
  name(): string {
    return "pause_goal";
  }
  definition(): ToolDefinition {
    return this.schema(this.name(), "暂停 Goal 续跑；不会中断已经运行的当前 Run。");
  }
  async execute(args: string): Promise<string> {
    const { id, revision } = await this.control(args, this.name());
    const goal = this.manager.pause(id, "模型请求暂停", revision);
    if (!goal) throw new Error(`未找到 Goal ${id}`);
    return `Goal 已暂停。\n${formatGoal(goal)}`;
  }
}

export class ResumeGoalTool extends GoalControlTool {
  name(): string {
    return "resume_goal";
  }
  definition(): ToolDefinition {
    return this.schema(this.name(), "恢复暂停的 Goal；Host 将按 Session 空闲状态准入后续 Run。 ");
  }
  async execute(args: string): Promise<string> {
    const { id, revision } = await this.control(args, this.name());
    const goal = this.manager.resume(id, revision);
    if (!goal) throw new Error(`Goal ${id} 不存在或当前状态不能恢复`);
    return `Goal 已恢复。\n${formatGoal(goal)}`;
  }
}

export class ClearGoalTool extends GoalControlTool {
  name(): string {
    return "clear_goal";
  }
  definition(): ToolDefinition {
    return this.schema(this.name(), "清除 Goal 并取消待续跑；当前 Agent Run 会继续到正常结束。");
  }
  async execute(args: string): Promise<string> {
    const { id, revision } = await this.control(args, this.name());
    if (!this.manager.clear(id, revision)) throw new Error(`未找到 Goal ${id}`);
    const goal = this.manager.get(id);
    return goal ? `Goal 已清除。\n${formatGoal(goal)}` : `Goal ${id} 已清除。`;
  }
}
