import { normalizeGoalManagerSnapshot, toCanonicalUsage, type Usage } from "@pico/core";
import type { BudgetConfig, BudgetDecision } from "./budget.js";

export type GoalStatus =
  | "active"
  | "waiting"
  | "paused"
  | "achieved"
  | "impossible"
  | "stalled"
  | "budget_limited"
  | "max_iterations"
  | "cleared";

export type GoalEvaluationOutcome = "met" | "impossible" | "progress" | "waiting" | "unknown";

export interface GoalEvaluationRecord {
  outcome: GoalEvaluationOutcome;
  reason: string;
  evidence: string[];
  at: number;
}

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
  completionCriteria: string[];
  constraints?: string[];
  status: GoalStatus;
  createdAt: number;
  maxIterations: number;
  blockCap: number;
  controlRevision: number;
  budgetConfig?: BudgetConfig;
  budgetUsage: GoalBudgetUsage;
  progress?: string;
  blockedReason?: string;
  consecutiveNoProgress: number;
  lastEvaluation?: GoalEvaluationRecord;
  evidence: string[];
  completionRequested: boolean;
  pendingContinuation: boolean;
  awaitingUserTurn: boolean;
  waitingReason?: string;
  nextCheckAt?: number;
  waitCount: number;
  admissionKey?: string;
  targetRunId?: string;
}

export interface GoalManagerSnapshot {
  stateVersion: 2;
  sequence: number;
  activeGoalId: string | null;
  goals: Goal[];
}

export type GoalManagerListener = (snapshot: GoalManagerSnapshot) => void;

export interface GoalCreateOptions {
  readonly title: string;
  readonly description: string;
  readonly completionCriteria: readonly string[];
  readonly constraints?: readonly string[];
  readonly budgetConfig?: BudgetConfig;
  readonly maxIterations?: number;
  readonly blockCap?: number;
  /** Host-created Goals wait for a user turn; tool-created Goals belong to this in-flight Run. */
  readonly awaitingUserTurn?: boolean;
}

export interface GoalEvaluation {
  readonly outcome: GoalEvaluationOutcome;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly progress?: boolean;
  readonly evaluatorFailed?: boolean;
  readonly usage?: Usage;
  readonly costCNY?: number;
}

const MAX_WAIT_MS = 5 * 60_000;
const INITIAL_WAIT_MS = 5_000;

function isCurrent(status: GoalStatus): boolean {
  return status === "active" || status === "waiting";
}

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

function formatBudget(config?: BudgetConfig): string {
  if (!config) return "";
  const parts: string[] = [];
  if (config.maxTurns !== undefined) parts.push(`${config.maxTurns} 轮`);
  if (config.maxTokens !== undefined) parts.push(`${config.maxTokens} tokens`);
  if (config.maxCostCNY !== undefined) parts.push(`¥${config.maxCostCNY}`);
  if (config.maxWallClockMs !== undefined) parts.push(`${config.maxWallClockMs}ms`);
  return parts.join(" + ");
}

/** Session-owned long-running Goal state machine. All mutations publish a full durable snapshot. */
export class GoalManager {
  private readonly goals = new Map<string, Goal>();
  private activeGoalId: string | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly listeners = new Set<GoalManagerListener>();
  private runInProgress = false;
  private currentRunId: string | undefined;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  create(options: GoalCreateOptions): Goal {
    const completionCriteria = options.completionCriteria.map((item) => item.trim()).filter(Boolean);
    if (completionCriteria.length === 0)
      throw new Error("Goal 至少需要一条可独立验收的完成标准");
    if (completionCriteria.length > 30)
      throw new Error("Goal 完成标准最多 30 条，以便逐项保存验收证据");
    const createdAt = this.now();
    const goal: Goal = {
      id: `goal-${++this.seq}`,
      title: options.title,
      description: options.description,
      completionCriteria,
      ...(options.constraints ? { constraints: [...options.constraints] } : {}),
      status: "active",
      createdAt,
      maxIterations: options.maxIterations ?? 50,
      blockCap: options.blockCap ?? 8,
      controlRevision: 1,
      budgetUsage: {
        turns: this.runInProgress ? 1 : 0,
        tokens: 0,
        costCNY: 0,
        startedAt: createdAt,
      },
      consecutiveNoProgress: 0,
      evidence: [],
      completionRequested: false,
      pendingContinuation: false,
      awaitingUserTurn: options.awaitingUserTurn ?? !this.runInProgress,
      waitCount: 0,
      ...(this.runInProgress && this.currentRunId ? { targetRunId: this.currentRunId } : {}),
      ...(options.budgetConfig !== undefined ? { budgetConfig: options.budgetConfig } : {}),
    };
    const previous = this.getActive();
    if (previous) {
      previous.status = "paused";
      previous.pendingContinuation = false;
      previous.awaitingUserTurn = false;
      delete previous.waitingReason;
      delete previous.nextCheckAt;
      delete previous.admissionKey;
      delete previous.targetRunId;
    }
    this.goals.set(goal.id, goal);
    this.activeGoalId = goal.id;
    this.emitChange();
    return goal;
  }

  get(id: string): Goal | undefined {
    return this.goals.get(id);
  }
  getActive(): Goal | undefined {
    return this.activeGoalId === null ? undefined : this.goals.get(this.activeGoalId);
  }
  list(): Goal[] {
    return [...this.goals.values()];
  }

  /** Called exactly once per RuntimeRun, before the model/tool loop starts. */
  beginRun(origin: "user" | "goal" = "user", runId?: string): BudgetDecision {
    this.runInProgress = true;
    this.currentRunId = runId;
    const goal = this.getActive();
    if (!goal || goal.status === "paused" || !isCurrent(goal.status)) return { allowed: true };
    if (origin === "user" && (goal.awaitingUserTurn || goal.status === "waiting")) {
      goal.status = "active";
      goal.awaitingUserTurn = false;
      goal.pendingContinuation = false;
      delete goal.waitingReason;
      delete goal.nextCheckAt;
      delete goal.admissionKey;
      delete goal.targetRunId;
    }
    if (goal.status !== "active") {
      this.emitChange();
      return { allowed: true };
    }
    if (goal.awaitingUserTurn) return { allowed: true };
    const decision = this.checkBudget(goal);
    if (!decision.allowed) {
      this.terminate(goal, "budget_limited", decision.reason ?? "Goal 预算已耗尽");
      return decision;
    }
    if (goal.budgetUsage.turns >= goal.maxIterations) {
      this.terminate(goal, "max_iterations", `Goal 已达到最大迭代数 ${goal.maxIterations}`);
      return { allowed: false, reason: `Goal 已达到最大迭代数 ${goal.maxIterations}` };
    }
    if (
      goal.budgetConfig?.maxTurns !== undefined &&
      goal.budgetUsage.turns >= goal.budgetConfig.maxTurns
    ) {
      this.terminate(goal, "budget_limited", `Goal 已达到最大轮次 ${goal.budgetConfig.maxTurns}`);
      return { allowed: false, reason: `Goal 已达到最大轮次 ${goal.budgetConfig.maxTurns}` };
    }
    goal.budgetUsage.turns++;
    if (this.currentRunId) goal.targetRunId = this.currentRunId;
    goal.controlRevision++;
    this.emitChange();
    return { allowed: true };
  }

  endRun(): void {
    this.runInProgress = false;
    this.currentRunId = undefined;
  }

  /** Evaluator settles the completed Run and produces a durable continuation intent. */
  settle(evaluation: GoalEvaluation): Goal | undefined {
    const goal = this.getActive();
    if (!goal || goal.status !== "active") return goal;
    const at = this.now();
    if (evaluation.usage) {
      const canonical = toCanonicalUsage(evaluation.usage);
      goal.budgetUsage.tokens += canonical.totalPromptTokens + canonical.totalCompletionTokens;
    }
    if (
      evaluation.costCNY !== undefined &&
      Number.isFinite(evaluation.costCNY) &&
      evaluation.costCNY > 0
    ) {
      goal.budgetUsage.costCNY += evaluation.costCNY;
    }
    if (evaluation.evaluatorFailed === true) {
      goal.lastEvaluation = { outcome: "unknown", reason: "评估器暂不可用", evidence: [], at };
      const budget = this.checkBudget(goal, at);
      if (!budget.allowed) {
        this.terminate(goal, "budget_limited", budget.reason ?? "Goal 预算已耗尽");
        return goal;
      }
      if (goal.budgetUsage.turns >= goal.maxIterations) {
        this.terminate(goal, "max_iterations", `Goal 已达到最大迭代数 ${goal.maxIterations}`);
        return goal;
      }
      goal.pendingContinuation = true;
      delete goal.admissionKey;
      delete goal.targetRunId;
      goal.controlRevision++;
      this.emitChange();
      return goal;
    }
    const evidence = [...evaluation.evidence]
      .map((item) => item.trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 30);
    const metHasEvidenceForEveryCriterion =
      evidence.length >= goal.completionCriteria.length &&
      evidence.every((item) => item.trim().length > 0);
    const outcome =
      evaluation.outcome === "met" && !metHasEvidenceForEveryCriterion
        ? "progress"
        : evaluation.outcome;
    const reason =
      evaluation.outcome === "met" && !metHasEvidenceForEveryCriterion
        ? "验收结果没有为每条完成标准提供对应证据"
        : evaluation.reason;
    const progress = evaluation.outcome === "met" && !metHasEvidenceForEveryCriterion
      ? false
      : evaluation.progress;
    goal.lastEvaluation = { outcome, reason, evidence, at };
    goal.evidence = [...new Set([...goal.evidence, ...evidence])].slice(-30);
    if (reason) goal.progress = reason;
    delete goal.blockedReason;
    delete goal.waitingReason;
    delete goal.nextCheckAt;
    const budget = this.checkBudget(goal, at);
    if (!budget.allowed && outcome !== "met" && outcome !== "impossible") {
      this.terminate(goal, "budget_limited", budget.reason ?? "Goal 预算已耗尽");
      return goal;
    }
    if (outcome === "met") {
      this.terminate(goal, "achieved", reason || "完成标准已满足");
    } else if (outcome === "impossible") {
      this.terminate(goal, "impossible", reason || "评估器判断目标不可达");
    } else if (goal.budgetUsage.turns >= goal.maxIterations) {
      this.terminate(goal, "max_iterations", `Goal 已达到最大迭代数 ${goal.maxIterations}`);
    } else if (outcome === "waiting") {
      goal.status = "waiting";
      goal.pendingContinuation = false;
      goal.waitCount++;
      goal.waitingReason = evaluation.reason || "等待外部事件";
      goal.nextCheckAt =
        at + Math.min(INITIAL_WAIT_MS * 2 ** Math.min(goal.waitCount - 1, 16), MAX_WAIT_MS);
      delete goal.admissionKey;
      delete goal.targetRunId;
      goal.controlRevision++;
      this.emitChange();
    } else if (outcome === "unknown") {
      goal.pendingContinuation = true;
      delete goal.admissionKey;
      delete goal.targetRunId;
      goal.controlRevision++;
      this.emitChange();
    } else {
      goal.consecutiveNoProgress =
        progress === true ? 0 : goal.consecutiveNoProgress + 1;
      goal.waitCount = 0;
      if (goal.consecutiveNoProgress >= goal.blockCap) {
        this.terminate(goal, "stalled", `连续 ${goal.consecutiveNoProgress} 轮无进展`);
      } else {
        goal.status = "active";
        goal.pendingContinuation = true;
        delete goal.admissionKey;
        delete goal.targetRunId;
        goal.controlRevision++;
        this.emitChange();
      }
    }
    return goal;
  }

  pause(id: string, reason = "用户暂停"): Goal | undefined {
    const goal = this.goals.get(id);
    if (!goal) return undefined;
    if (goal.status === "active" || goal.status === "waiting") {
      goal.status = "paused";
      goal.blockedReason = reason;
      goal.pendingContinuation = false;
      goal.awaitingUserTurn = false;
      delete goal.nextCheckAt;
      delete goal.admissionKey;
      delete goal.targetRunId;
      goal.controlRevision++;
      if (this.activeGoalId === id) this.activeGoalId = null;
      this.emitChange();
    }
    return goal;
  }

  resume(id: string): Goal | undefined {
    const goal = this.goals.get(id);
    if (!goal || goal.status !== "paused") return undefined;
    const budget = this.checkBudget(goal);
    if (!budget.allowed) {
      this.terminate(goal, "budget_limited", budget.reason ?? "Goal 预算已耗尽");
      return goal;
    }
    if (goal.budgetUsage.turns >= goal.maxIterations) {
      this.terminate(goal, "max_iterations", `Goal 已达到最大迭代数 ${goal.maxIterations}`);
      return goal;
    }
    const previous = this.getActive();
    if (previous && previous.id !== id) this.pause(previous.id, "被另一个 Goal 替代");
    goal.status = "active";
    delete goal.blockedReason;
    delete goal.waitingReason;
    delete goal.nextCheckAt;
    goal.awaitingUserTurn = false;
    goal.pendingContinuation = true;
    delete goal.admissionKey;
    delete goal.targetRunId;
    goal.controlRevision++;
    this.activeGoalId = id;
    this.emitChange();
    return goal;
  }

  clear(id: string): boolean {
    const goal = this.goals.get(id);
    if (!goal) return false;
    goal.status = "cleared";
    goal.pendingContinuation = false;
    goal.awaitingUserTurn = false;
    delete goal.waitingReason;
    delete goal.nextCheckAt;
    delete goal.admissionKey;
    delete goal.targetRunId;
    goal.controlRevision++;
    if (this.activeGoalId === id) this.activeGoalId = null;
    this.emitChange();
    return true;
  }

  claimContinuation(id: string, admissionKey: string): Goal | undefined {
    const goal = this.goals.get(id);
    if (!goal || goal.status !== "active" || !goal.pendingContinuation) return undefined;
    const budget = this.checkBudget(goal);
    if (!budget.allowed) {
      this.terminate(goal, "budget_limited", budget.reason ?? "Goal 预算已耗尽");
      return undefined;
    }
    if (goal.budgetUsage.turns >= goal.maxIterations) {
      this.terminate(goal, "max_iterations", `Goal 已达到最大迭代数 ${goal.maxIterations}`);
      return undefined;
    }
    goal.pendingContinuation = false;
    goal.admissionKey = admissionKey;
    delete goal.targetRunId;
    goal.controlRevision++;
    this.emitChange();
    return goal;
  }

  recordAdmittedRun(id: string, admissionKey: string, targetRunId: string): void {
    const goal = this.goals.get(id);
    if (!goal || goal.admissionKey !== admissionKey) return;
    goal.targetRunId = targetRunId;
    goal.controlRevision++;
    this.emitChange();
  }

  /** Reconciles a persisted in-flight Goal Run after Host restart. */
  recoverAdmittedRun(
    id: string,
    targetRunId: string,
    status: "succeeded" | "failed" | "cancelled" | "missing",
  ): "continued" | "paused" | "unchanged" {
    const goal = this.goals.get(id);
    if (!goal || goal.targetRunId !== targetRunId || goal.status !== "active") return "unchanged";
    if (status === "succeeded") {
      goal.pendingContinuation = true;
      delete goal.admissionKey;
      delete goal.targetRunId;
      goal.controlRevision++;
      this.emitChange();
      return "continued";
    }
    const reason =
      status === "missing"
        ? `Goal Run ${targetRunId} 在 Runtime ledger 中不存在，已暂停以避免重复执行`
        : status === "cancelled"
          ? `Goal Run ${targetRunId} 已中断`
          : `Goal Run ${targetRunId} 失败，已暂停`;
    this.pause(id, reason);
    return "paused";
  }

  releaseContinuation(id: string, admissionKey: string, reason?: string): void {
    const goal = this.goals.get(id);
    if (!goal || (goal.admissionKey !== admissionKey && goal.targetRunId !== admissionKey)) return;
    delete goal.admissionKey;
    delete goal.targetRunId;
    if (reason) {
      goal.status = "paused";
      goal.blockedReason = reason;
      if (this.activeGoalId === id) this.activeGoalId = null;
    } else {
      goal.pendingContinuation = true;
    }
    goal.controlRevision++;
    this.emitChange();
  }

  wakeWaiting(id: string, now = this.now()): boolean {
    const goal = this.goals.get(id);
    if (!goal || goal.status !== "waiting" || (goal.nextCheckAt ?? Infinity) > now) return false;
    goal.status = "active";
    delete goal.waitingReason;
    delete goal.nextCheckAt;
    goal.pendingContinuation = true;
    delete goal.admissionKey;
    delete goal.targetRunId;
    goal.controlRevision++;
    this.emitChange();
    return true;
  }

  update(
    id: string,
    patch: Partial<
      Pick<Goal, "title" | "description" | "progress" | "budgetConfig" | "completionRequested">
    >,
  ): Goal | undefined {
    const goal = this.goals.get(id);
    if (!goal) return undefined;
    Object.assign(goal, patch);
    goal.controlRevision++;
    this.emitChange();
    return goal;
  }

  snapshot(): GoalManagerSnapshot {
    return {
      stateVersion: 2,
      sequence: this.seq,
      activeGoalId: this.activeGoalId,
      goals: structuredClone([...this.goals.values()]),
    };
  }

  restore(snapshot: GoalManagerSnapshot): void {
    const normalized = normalizeGoalManagerSnapshot(snapshot);
    if (!normalized)
      throw new Error("Goal 快照无效；当前只支持 Goal schema v2，请清理旧 Session 数据后重试");
    this.goals.clear();
    for (const goal of normalized.goals) this.goals.set(goal.id, structuredClone(goal) as Goal);
    this.seq = normalized.sequence;
    this.activeGoalId = normalized.activeGoalId;
    this.runInProgress = false;
  }

  subscribe(listener: GoalManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canStartTurn(now = this.now()): BudgetDecision {
    const goal = this.getActive();
    return goal ? this.checkBudget(goal, now) : { allowed: true };
  }

  consumeUsage(usage: Usage): BudgetDecision {
    const goal = this.getActive();
    if (!goal) return { allowed: true };
    const canonical = toCanonicalUsage(usage);
    goal.budgetUsage.tokens += canonical.totalPromptTokens + canonical.totalCompletionTokens;
    const decision = this.checkBudget(goal);
    if (!decision.allowed)
      this.terminate(goal, "budget_limited", decision.reason ?? "Goal Token 预算已耗尽");
    this.emitChange();
    return decision;
  }

  consumeCost(costCNY: number): BudgetDecision {
    const goal = this.getActive();
    if (!goal) return { allowed: true };
    if (Number.isFinite(costCNY) && costCNY > 0) goal.budgetUsage.costCNY += costCNY;
    const decision = this.checkBudget(goal);
    if (!decision.allowed)
      this.terminate(goal, "budget_limited", decision.reason ?? "Goal 成本预算已耗尽");
    this.emitChange();
    return decision;
  }

  currentBudgetDecision(now = this.now()): BudgetDecision {
    const goal = this.getActive();
    return goal ? this.checkBudget(goal, now) : { allowed: true };
  }

  getStallWarning(): string | null {
    const goal = this.getActive();
    if (!goal || goal.consecutiveNoProgress < Math.max(1, goal.blockCap - 3)) return null;
    return `目标 ${goal.id} 已连续 ${goal.consecutiveNoProgress} 轮无进展，接近停滞上限 ${goal.blockCap}。`;
  }

  formatRemainingBudget(goal: Goal): string | null {
    if (!goal.budgetConfig) return null;
    const { budgetConfig: config, budgetUsage: usage } = goal;
    const parts: string[] = [];
    if (config.maxTurns !== undefined) parts.push(`剩余 ${config.maxTurns - usage.turns} 轮`);
    if (config.maxTokens !== undefined)
      parts.push(`剩余 ${config.maxTokens - usage.tokens} tokens`);
    if (config.maxCostCNY !== undefined)
      parts.push(`剩余 ¥${(config.maxCostCNY - usage.costCNY).toFixed(4)}`);
    if (config.maxWallClockMs !== undefined)
      parts.push(`剩余 ${Math.max(0, config.maxWallClockMs - (this.now() - usage.startedAt))}ms`);
    return parts.length > 0 ? parts.join(" + ") : null;
  }

  buildGoalContext(): string {
    const goal = this.getActive();
    if (!goal) return "";
    const lines = [
      "## 🎯 当前 Goal(长程目标)",
      `- ${statusMark(goal.status)} **${goal.title}** (id: ${goal.id})`,
      `  - 描述: ${goal.description}`,
    ];
    lines.push("  - 完成标准:", ...goal.completionCriteria.map((item) => `    - ${item}`));
    if (goal.constraints?.length)
      lines.push("  - 约束:", ...goal.constraints.map((item) => `    - ${item}`));
    if (goal.progress) lines.push(`  - 最近进展: ${goal.progress}`);
    if (goal.blockedReason) lines.push(`  - 状态原因: ${goal.blockedReason}`);
    if (goal.waitingReason) lines.push(`  - 等待原因: ${goal.waitingReason}`);
    lines.push(`  - 迭代: ${goal.budgetUsage.turns}/${goal.maxIterations}`);
    const budget = formatBudget(goal.budgetConfig);
    if (budget)
      lines.push(
        `  - 预算约束: ${budget}`,
        `  - 已消耗: ${goal.budgetUsage.tokens} tokens + ¥${goal.budgetUsage.costCNY.toFixed(4)}`,
      );
    lines.push(
      "  - 完成标准满足前不要声称 Goal 已完成；可用 update_goal complete 请求一次独立验收。",
    );
    return lines.join("\n");
  }

  private checkBudget(goal: Goal, now = this.now()): BudgetDecision {
    const config = goal.budgetConfig;
    if (!config) return { allowed: true };
    const usage = goal.budgetUsage;
    if (config.maxTurns !== undefined && usage.turns >= config.maxTurns)
      return { allowed: false, reason: `Goal 已达到最大轮次 ${config.maxTurns}` };
    if (config.maxWallClockMs !== undefined && now - usage.startedAt >= config.maxWallClockMs)
      return { allowed: false, reason: `Goal 已达墙钟时间上限 ${config.maxWallClockMs}ms` };
    if (config.maxTokens !== undefined && usage.tokens >= config.maxTokens)
      return { allowed: false, reason: `Goal 已达到 Token 预算 ${config.maxTokens}` };
    if (config.maxCostCNY !== undefined && usage.costCNY >= config.maxCostCNY)
      return { allowed: false, reason: `Goal 已达到成本预算 ¥${config.maxCostCNY}` };
    return { allowed: true };
  }

  private terminate(goal: Goal, status: GoalStatus, reason: string): void {
    goal.status = status;
    goal.blockedReason = reason;
    goal.pendingContinuation = false;
    goal.awaitingUserTurn = false;
    delete goal.nextCheckAt;
    delete goal.admissionKey;
    delete goal.targetRunId;
    goal.controlRevision++;
    if (this.activeGoalId === goal.id) this.activeGoalId = null;
    this.emitChange();
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        /* persistence listeners fail independently */
      }
    }
  }
}
