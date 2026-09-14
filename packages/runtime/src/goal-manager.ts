import { createHash } from "node:crypto";
import {
  normalizeGoalManagerSnapshot,
  toCanonicalUsage,
  type ToolCall,
  type Usage,
} from "@pico/core";
import type { BudgetConfig, BudgetDecision } from "./budget.js";

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalBudgetUsage {
  turns: number;
  tokens: number;
  costCNY: number;
  startedAt: number;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  createdAt: number;
  budgetConfig?: BudgetConfig;
  budgetUsage: GoalBudgetUsage;
  progress?: string;
  blockedReason?: string;
  consecutiveNoProgress?: number;
  lastToolCallHash?: string;
}

export interface GoalManagerSnapshot {
  stateVersion: 1;
  sequence: number;
  activeGoalId: string | null;
  goals: Goal[];
}

export type GoalManagerListener = (snapshot: GoalManagerSnapshot) => void;

const VALID_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  "active",
  "paused",
  "blocked",
  "complete",
]);

export const STALL_EVALUATOR_THRESHOLD = 3;
export const STALL_WARN_THRESHOLD = 5;
export const STALL_BLOCK_THRESHOLD = 8;

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

function formatBudget(config?: BudgetConfig): string {
  if (!config) return "";
  const parts: string[] = [];
  if (config.maxTurns !== undefined) parts.push(`${config.maxTurns} 轮`);
  if (config.maxTokens !== undefined) parts.push(`${config.maxTokens} tokens`);
  if (config.maxCostCNY !== undefined) parts.push(`¥${config.maxCostCNY}`);
  if (config.maxWallClockMs !== undefined) parts.push(`${config.maxWallClockMs}ms`);
  return parts.join(" + ");
}

/** In-memory long-running Goal state machine; Session owns persistence through snapshot/restore. */
export class GoalManager {
  private readonly goals = new Map<string, Goal>();
  private activeGoalId: string | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly listeners = new Set<GoalManagerListener>();

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  create(title: string, description: string, budgetConfig?: BudgetConfig): Goal {
    this.seq++;
    const createdAt = this.now();
    const goal: Goal = {
      id: `goal-${this.seq}`,
      title,
      description,
      status: "active",
      createdAt,
      budgetUsage: { turns: 0, tokens: 0, costCNY: 0, startedAt: createdAt },
      ...(budgetConfig !== undefined ? { budgetConfig } : {}),
    };
    this.goals.set(goal.id, goal);
    this.activate(goal.id);
    this.emitChange();
    return goal;
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }

  getActive(): Goal | undefined {
    return this.activeGoalId === null ? undefined : this.goals.get(this.activeGoalId);
  }

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
      if (patch.status === "active" && this.activeGoalId !== id) {
        const previous = this.activeGoalId === null ? undefined : this.goals.get(this.activeGoalId);
        if (previous?.status === "active") previous.status = "paused";
        this.activeGoalId = id;
      }
      goal.status = patch.status;
      if (patch.status !== "active" && this.activeGoalId === id) this.activeGoalId = null;
    }
    this.emitChange();
    return goal;
  }

  list(): Goal[] {
    return [...this.goals.values()];
  }

  snapshot(): GoalManagerSnapshot {
    return {
      stateVersion: 1,
      sequence: this.seq,
      activeGoalId: this.activeGoalId,
      goals: structuredClone([...this.goals.values()]),
    };
  }

  restore(snapshot: GoalManagerSnapshot): void {
    const normalized = normalizeGoalManagerSnapshot(snapshot);
    if (!normalized) throw new Error("Goal 快照无效");
    this.goals.clear();
    for (const goal of normalized.goals) this.goals.set(goal.id, goal);
    this.seq = normalized.sequence;
    this.activeGoalId = normalized.activeGoalId;
  }

  subscribe(listener: GoalManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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

  startTurn(): BudgetDecision {
    const decision = this.canStartTurn();
    if (!decision.allowed) return decision;
    const active = this.getActive();
    if (active) {
      active.budgetUsage.turns++;
      this.emitChange();
    }
    return { allowed: true };
  }

  consumeUsage(usage: Usage): BudgetDecision {
    const active = this.getActive();
    if (!active) return { allowed: true };
    const canonical = toCanonicalUsage(usage);
    active.budgetUsage.tokens += canonical.totalPromptTokens + canonical.totalCompletionTokens;
    this.emitChange();
    return this.currentBudgetDecision();
  }

  consumeCost(costCNY: number): BudgetDecision {
    const active = this.getActive();
    if (!active) return { allowed: true };
    if (Number.isFinite(costCNY) && costCNY > 0) {
      active.budgetUsage.costCNY += costCNY;
      this.emitChange();
    }
    return this.currentBudgetDecision();
  }

  currentBudgetDecision(now = this.now()): BudgetDecision {
    const active = this.getActive();
    if (!active) return { allowed: true };
    if (active.consecutiveNoProgress && active.consecutiveNoProgress >= STALL_BLOCK_THRESHOLD) {
      return {
        allowed: false,
        reason: `Goal 疑似停滞（连续 ${active.consecutiveNoProgress} 轮无进展）`,
      };
    }
    if (!active.budgetConfig) return { allowed: true };
    const { budgetConfig: config, budgetUsage: usage } = active;
    if (config.maxWallClockMs !== undefined && now - usage.startedAt > config.maxWallClockMs) {
      return { allowed: false, reason: `Goal 已达墙钟时间上限 ${config.maxWallClockMs}ms` };
    }
    if (config.maxTokens !== undefined && usage.tokens > config.maxTokens) {
      return { allowed: false, reason: `Goal 已达到 Token 预算 ${config.maxTokens}` };
    }
    if (config.maxCostCNY !== undefined && usage.costCNY > config.maxCostCNY) {
      return { allowed: false, reason: `Goal 已达到成本预算 ¥${config.maxCostCNY}` };
    }
    return { allowed: true };
  }

  recordToolCallProgress(toolCalls: readonly ToolCall[]): void {
    const active = this.getActive();
    if (!active) return;
    if (toolCalls.length === 0) {
      active.consecutiveNoProgress = (active.consecutiveNoProgress ?? 0) + 1;
      this.emitChange();
      return;
    }
    const hash = createHash("md5")
      .update(
        toolCalls
          .map((toolCall) => `${toolCall.name}:${toolCall.arguments}`)
          .sort()
          .join("|"),
      )
      .digest("hex");
    active.consecutiveNoProgress =
      hash === active.lastToolCallHash ? (active.consecutiveNoProgress ?? 0) + 1 : 0;
    active.lastToolCallHash = hash;
    this.emitChange();
  }

  getStallWarning(): string | null {
    const active = this.getActive();
    if (!active?.consecutiveNoProgress || active.consecutiveNoProgress < STALL_WARN_THRESHOLD) {
      return null;
    }
    return `目标 ${active.id} 已连续 ${active.consecutiveNoProgress} 轮无进展，疑似停滞。请换一种方案或缩小范围。`;
  }

  formatRemainingBudget(goal: Goal): string | null {
    if (!goal.budgetConfig) return null;
    const { budgetConfig: config, budgetUsage: usage } = goal;
    const parts: string[] = [];
    if (config.maxTurns !== undefined) {
      const remaining = config.maxTurns - usage.turns;
      parts.push(
        `剩余 ${remaining} 轮${remaining <= Math.ceil(config.maxTurns * 0.2) ? " ⚠" : ""}`,
      );
    }
    if (config.maxTokens !== undefined) {
      const remaining = config.maxTokens - usage.tokens;
      parts.push(
        `剩余 ${remaining} tokens${remaining <= Math.ceil(config.maxTokens * 0.2) ? " ⚠" : ""}`,
      );
    }
    if (config.maxCostCNY !== undefined) {
      const remaining = config.maxCostCNY - usage.costCNY;
      parts.push(
        `剩余 ¥${remaining.toFixed(4)}${remaining <= config.maxCostCNY * 0.2 ? " ⚠" : ""}`,
      );
    }
    return parts.length > 0 ? parts.join(" + ") : null;
  }

  setActive(id: string): void {
    this.activate(id);
    this.emitChange();
  }

  remove(id: string): boolean {
    const existed = this.goals.delete(id);
    if (existed && this.activeGoalId === id) this.activeGoalId = null;
    if (existed) this.emitChange();
    return existed;
  }

  buildGoalContext(): string {
    const active = this.getActive();
    if (!active) return "";
    const lines = ["## 🎯 当前 Goal(长程目标)"];
    lines.push(`- ${statusMark(active.status)} **${active.title}** (id: ${active.id})`);
    lines.push(`  - 描述: ${active.description}`);
    if (active.progress) lines.push(`  - 进度: ${active.progress}`);
    if (active.blockedReason) lines.push(`  - 阻塞原因: ${active.blockedReason}`);
    const budget = formatBudget(active.budgetConfig);
    if (budget) {
      lines.push(`  - 预算约束: ${budget}`);
      lines.push(
        `  - 已消耗: ${active.budgetUsage.turns} 轮 + ${active.budgetUsage.tokens} tokens + ¥${active.budgetUsage.costCNY.toFixed(4)}`,
      );
      const remaining = this.formatRemainingBudget(active);
      if (remaining) lines.push(`  - ${remaining}`);
    }
    if (active.consecutiveNoProgress && active.consecutiveNoProgress >= STALL_EVALUATOR_THRESHOLD) {
      lines.push(`  - ⚠ 连续无进展: ${active.consecutiveNoProgress} 轮`);
    }
    lines.push("  - 提示:推进任务时请对齐此目标;达成后用 update_goal 置 complete。");
    return lines.join("\n");
  }

  private activate(id: string): void {
    const goal = this.goals.get(id);
    if (!goal) throw new Error(`未找到目标 ${id}`);
    if (goal.status === "complete") throw new Error(`目标 ${id} 已完成,无法重新激活`);
    const previous = this.activeGoalId === null ? undefined : this.goals.get(this.activeGoalId);
    if (previous && previous !== goal && previous.status === "active") previous.status = "paused";
    goal.status = "active";
    this.activeGoalId = id;
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        // Observer failures must not corrupt the Goal state machine.
      }
    }
  }
}
