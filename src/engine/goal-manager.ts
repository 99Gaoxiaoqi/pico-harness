// GoalManager:长程目标的状态机 + budget 管理(ROADMAP 3.5 Goal Mode)。
//
// 与 PlanStore(计划文档)、TodoStore(任务清单)的层次区分:
//   - Goal:宏观长程目标 + budget(轮次/Token/墙钟),用状态机约束生命周期
//   - Plan:目标的实现路径,以 PLAN.md 文本落地
//   - Todo:路径上的原子任务清单
// 三者层次不同,Goal 居于最上层,锚定"我们在追什么、还能追多久"。
//
// 关键架构决策:
// 1. GoalManager 必须是单例,被 engine(→PromptComposer)和 3 个 Goal 工具共享。
//    TodoStore 当年各 new 各的导致跨实例不可见 bug,这里从源头规避:
//    host 创建唯一实例,经构造注入传到 registry 与 engine,杜绝跨实例。
// 2. budget 复用 IterationBudget 的 BudgetConfig,不在本类重造 token 计数。
//    本轮简化:Goal 只存 budget 配置,实际执行(每轮消耗判定)留后续接入;
//    buildGoalContext 渲染配置供模型感知约束。
//
// 状态机:active(进行中) → paused(主动暂停) / blocked(被阻塞) → complete(完成)
// 同一时刻最多一个 active goal(setActive 会把旧的置回 active 之外的状态)。

import type { Usage } from "../schema/message.js";
import { toCanonicalUsage } from "../schema/message.js";
import type { BudgetConfig, BudgetDecision } from "./budget.js";

/** 目标状态机四态 */
export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalBudgetUsage {
  turns: number;
  tokens: number;
  costCNY: number;
  /** Wall-clock budgets are measured from goal creation and do not pause. */
  startedAt: number;
}

/** 单个目标 */
export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  /** 创建时间戳(ms) */
  createdAt: number;
  /** 预算配置(tokens / turns / 墙钟)。可选:无配置表示不设预算约束。 */
  budgetConfig?: BudgetConfig;
  /** Session-lifetime usage retained when budget limits are edited. */
  budgetUsage: GoalBudgetUsage;
  /** 模型更新的进度说明(自由文本,模型在推进过程中写入) */
  progress?: string;
  /** blocked 状态下的阻塞原因 */
  blockedReason?: string;
}

/** 合法状态白名单(校验用) */
const VALID_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  "active",
  "paused",
  "blocked",
  "complete",
]);

/** 状态对应的中文标记(供 buildGoalContext / 工具渲染) */
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

/** 把 BudgetConfig 渲染成单行人类可读字符串(无配置返回空) */
function formatBudget(config?: BudgetConfig): string {
  if (!config) return "";
  const parts: string[] = [];
  if (config.maxTurns !== undefined) parts.push(`${config.maxTurns} 轮`);
  if (config.maxTokens !== undefined) parts.push(`${config.maxTokens} tokens`);
  if (config.maxCostCNY !== undefined) parts.push(`¥${config.maxCostCNY}`);
  if (config.maxWallClockMs !== undefined) parts.push(`${config.maxWallClockMs}ms`);
  return parts.length > 0 ? parts.join(" + ") : "";
}

/**
 * Goal Mode 的核心:管理一组 Goal 的状态机与 budget 配置。
 *
 * 内存单例:状态不落盘(Goal 是会话级工作记忆,非跨会话持久化文档)。
 * 单例由 host 创建,经构造注入到 PromptComposer 与 3 个 Goal 工具,
 * 确保所有持有者操作的是同一份状态。
 */
export class GoalManager {
  /** 全部目标,按 id 索引 */
  private readonly goals = new Map<string, Goal>();
  /** 当前激活的目标 id(同一时刻最多一个) */
  private activeGoalId: string | null = null;
  /** 自增序列,保证 id 唯一且可读 */
  private seq = 0;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * 创建一个新目标,默认状态为 active,并自动设为当前激活目标。
   * 若已有 active 目标,会被降级为 paused(让位给新目标)。
   *
   * @param title 目标标题(简短一行)
   * @param description 目标详细描述
   * @param budgetConfig 可选预算约束(tokens/turns/墙钟)
   */
  create(title: string, description: string, budgetConfig?: BudgetConfig): Goal {
    this.seq++;
    const createdAt = this.now();
    const goal: Goal = {
      id: `goal-${this.seq}`,
      title,
      description,
      status: "active",
      createdAt,
      budgetUsage: {
        turns: 0,
        tokens: 0,
        costCNY: 0,
        startedAt: createdAt,
      },
      ...(budgetConfig !== undefined ? { budgetConfig } : {}),
    };
    this.goals.set(goal.id, goal);
    // 新 goal 成为 active;旧的 active 降级为 paused 让位
    this.setActive(goal.id);
    return goal;
  }

  /** 按 id 取目标;不存在返回 undefined */
  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  /** 取当前激活的目标;无激活目标返回 undefined */
  getActive(): Goal | undefined {
    if (this.activeGoalId === null) return undefined;
    return this.goals.get(this.activeGoalId);
  }

  /**
   * 更新目标的可变字段。
   * status 修改走状态机校验(必须是合法四态之一)。
   * 特殊:若把某 goal 置为 active,会自动把原 active 降级为 paused。
   *
   * @returns 更新后的目标;找不到返回 undefined
   */
  update(
    id: string,
    patch: Partial<
      Pick<Goal, "title" | "description" | "status" | "progress" | "blockedReason" | "budgetConfig">
    >,
  ): Goal | undefined {
    const goal = this.goals.get(id);
    if (!goal) return undefined;

    if (patch.title !== undefined) goal.title = patch.title;
    if (patch.description !== undefined) goal.description = patch.description;
    if (patch.progress !== undefined) goal.progress = patch.progress;
    if (patch.blockedReason !== undefined) goal.blockedReason = patch.blockedReason;
    if (patch.budgetConfig !== undefined) goal.budgetConfig = patch.budgetConfig;

    if (patch.status !== undefined) {
      if (!VALID_STATUSES.has(patch.status)) {
        throw new Error(`非法 goal 状态: ${patch.status}。合法值:active/paused/blocked/complete`);
      }
      // 切到 active 时,把原 active 降级(状态机唯一性约束)
      if (patch.status === "active" && this.activeGoalId !== id) {
        if (this.activeGoalId !== null) {
          const prev = this.goals.get(this.activeGoalId);
          if (prev && prev.status === "active") {
            prev.status = "paused";
          }
        }
        this.activeGoalId = id;
      }
      goal.status = patch.status;
      // 若当前 active goal 被切到非 active,清空 activeGoalId
      if (patch.status !== "active" && this.activeGoalId === id) {
        this.activeGoalId = null;
      }
    }

    return goal;
  }

  /** 返回全部目标(按创建顺序) */
  list(): Goal[] {
    return [...this.goals.values()];
  }

  /** Check whether the active goal permits one more model turn. */
  canStartTurn(now = this.now()): BudgetDecision {
    const active = this.getActive();
    if (!active) return { allowed: true };
    const config = active.budgetConfig;
    if (!config) return { allowed: true };
    if (config.maxTurns !== undefined && active.budgetUsage.turns + 1 > config.maxTurns) {
      return { allowed: false, reason: `Goal 已达到最大轮次 ${config.maxTurns}` };
    }
    return this.currentBudgetDecision(now);
  }

  /** Consume one model turn only when the active goal still allows it. */
  startTurn(): BudgetDecision {
    const decision = this.canStartTurn();
    if (!decision.allowed) return decision;
    const active = this.getActive();
    if (active) active.budgetUsage.turns++;
    return { allowed: true };
  }

  consumeUsage(usage: Usage): BudgetDecision {
    const active = this.getActive();
    if (!active) return { allowed: true };
    const canonical = toCanonicalUsage(usage);
    active.budgetUsage.tokens += canonical.totalPromptTokens + canonical.totalCompletionTokens;
    return this.currentBudgetDecision();
  }

  consumeCost(costCNY: number): BudgetDecision {
    const active = this.getActive();
    if (!active) return { allowed: true };
    if (Number.isFinite(costCNY) && costCNY > 0) {
      active.budgetUsage.costCNY += costCNY;
    }
    return this.currentBudgetDecision();
  }

  currentBudgetDecision(now = this.now()): BudgetDecision {
    const active = this.getActive();
    if (!active?.budgetConfig) return { allowed: true };
    const { budgetConfig: config, budgetUsage: usage } = active;
    if (config.maxWallClockMs !== undefined && now - usage.startedAt > config.maxWallClockMs) {
      return {
        allowed: false,
        reason: `Goal 已达墙钟时间上限 ${config.maxWallClockMs}ms`,
      };
    }
    if (config.maxTokens !== undefined && usage.tokens > config.maxTokens) {
      return { allowed: false, reason: `Goal 已达到 Token 预算 ${config.maxTokens}` };
    }
    if (config.maxCostCNY !== undefined && usage.costCNY > config.maxCostCNY) {
      return { allowed: false, reason: `Goal 已达到成本预算 ¥${config.maxCostCNY}` };
    }
    return { allowed: true };
  }

  /**
   * 把指定目标设为当前激活目标(状态机唯一性)。
   * 原 active 自动降级为 paused。目标不存在时抛错。
   * 目标若处于 complete 状态,禁止重新激活(需先 update 状态)。
   */
  setActive(id: string): void {
    const goal = this.goals.get(id);
    if (!goal) {
      throw new Error(`未找到目标 ${id}`);
    }
    if (goal.status === "complete") {
      throw new Error(`目标 ${id} 已完成,无法重新激活`);
    }
    // 原 active 降级为 paused
    if (this.activeGoalId !== null && this.activeGoalId !== id) {
      const prev = this.goals.get(this.activeGoalId);
      if (prev && prev.status === "active") {
        prev.status = "paused";
      }
    }
    goal.status = "active";
    this.activeGoalId = id;
  }

  /**
   * 删除目标。若删的是当前 active,清空 activeGoalId。
   * @returns 是否删除成功(找不到返回 false)
   */
  remove(id: string): boolean {
    const existed = this.goals.delete(id);
    if (existed && this.activeGoalId === id) {
      this.activeGoalId = null;
    }
    return existed;
  }

  /**
   * 渲染当前激活目标的状态为 Markdown,供 PromptComposer 注入 system prompt。
   * 无激活目标返回空串(不注入,避免污染 prompt)。
   *
   * 对标 TodoStore.buildTodoContext:让模型每轮都能"看到"自己追的长程目标与 budget 约束。
   */
  buildGoalContext(): string {
    const active = this.getActive();
    if (!active) return "";

    const lines: string[] = ["## 🎯 当前 Goal(长程目标)"];
    lines.push(`- ${statusMark(active.status)} **${active.title}** (id: ${active.id})`);
    lines.push(`  - 描述: ${active.description}`);
    if (active.progress) {
      lines.push(`  - 进度: ${active.progress}`);
    }
    if (active.blockedReason) {
      lines.push(`  - 阻塞原因: ${active.blockedReason}`);
    }
    const budgetStr = formatBudget(active.budgetConfig);
    if (budgetStr) {
      lines.push(`  - 预算约束: ${budgetStr}`);
      lines.push(
        `  - 已消耗: ${active.budgetUsage.turns} 轮 + ${active.budgetUsage.tokens} tokens + ¥${active.budgetUsage.costCNY.toFixed(4)}`,
      );
    }
    lines.push("  - 提示:推进任务时请对齐此目标;达成后用 update_goal 置 complete。");
    return lines.join("\n");
  }
}
