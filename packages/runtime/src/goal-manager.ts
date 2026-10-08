import { normalizeGoalManagerSnapshot, parseGoalConfig } from "@pico/core";
import { randomUUID } from "node:crypto";
import type {
  PersistedGoalContinuationIntent,
  PersistedGoalCoordinator,
  PersistedGoalControlLease,
  PersistedGoalEvaluation,
  PersistedGoalExecutionRef,
  PersistedGoalManagerSnapshot,
  PersistedGoalState,
  PersistedGoalStatus,
} from "@pico/core";
import type { GoalEvidenceTrace } from "./goal-evidence.js";

export type GoalStatus = PersistedGoalStatus;
export type Goal = PersistedGoalState;
export type GoalManagerSnapshot = PersistedGoalManagerSnapshot;
export type GoalEvaluationRecord = PersistedGoalEvaluation;
export type GoalCoordinator = PersistedGoalCoordinator;
export type GoalContinuationIntent = PersistedGoalContinuationIntent;
export type GoalExecutionRef = PersistedGoalExecutionRef;
export type GoalControlLease = PersistedGoalControlLease;

export type GoalEvaluationOutcome = "met" | "impossible" | "progress" | "waiting" | "unknown";

export interface GoalEvaluation {
  readonly met?: boolean;
  readonly impossible?: boolean;
  readonly progress?: boolean;
  readonly waiting?: boolean;
  readonly evaluatorFailed?: boolean;
  readonly reason: string;
}

export interface GoalCreateOptions {
  readonly condition: string;
  readonly tokenBudget?: number;
  readonly maxIterations?: number;
  readonly blockCap?: number;
  /** Host-created Goals wait for the next ordinary user Run. */
  readonly awaitingUserTurn?: boolean;
}

export interface GoalRunCheckpoint {
  readonly goalId: string;
  readonly revision: number;
}

export interface GoalSettleInput {
  readonly checkpoint: GoalRunCheckpoint;
  readonly evaluation: GoalEvaluation;
  readonly evidenceTrace?: GoalEvidenceTrace;
  /** Cumulative primary-execution tokens at this Run's terminal boundary. */
  readonly tokensNow: number;
}

export type GoalManagerListener = (snapshot: GoalManagerSnapshot) => void;
export type GoalRunOrigin = "user" | "goal";

interface UnboundRun {
  readonly runId: string;
  readonly daemonRunId: string;
  readonly turnId: string;
  readonly origin: GoalRunOrigin;
  readonly prompt?: string;
  readonly createdAt?: number;
  readonly triggeringRunId?: string;
  readonly invocationId?: string;
  readonly runStartedEventId?: string;
  readonly runStartedAt?: number;
}

export type GoalRunIdentity = Omit<UnboundRun, "runId" | "daemonRunId" | "turnId" | "origin">;

const EMPTY_COORDINATOR: GoalCoordinator = {
  pendingContinuation: null,
  currentExecution: null,
  workTokens: 0,
  accountedRunIds: [],
};

function isIncomplete(status: GoalStatus): boolean {
  return status === "active" || status === "waiting" || status === "paused";
}

function isTerminal(status: GoalStatus): boolean {
  return !isIncomplete(status);
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

function evaluationOutcome(evaluation: GoalEvaluation): GoalEvaluationOutcome {
  if (evaluation.met === true) return "met";
  if (evaluation.impossible === true) return "impossible";
  if (evaluation.evaluatorFailed === true) return "unknown";
  if (evaluation.waiting === true) return "waiting";
  return "progress";
}

function evaluationRecord(
  evaluation: GoalEvaluation,
  at: number,
  evidenceTrace?: GoalEvidenceTrace,
): GoalEvaluationRecord {
  return {
    ...(evaluation.met !== undefined ? { met: evaluation.met } : {}),
    ...(evaluation.impossible !== undefined ? { impossible: evaluation.impossible } : {}),
    ...(evaluation.progress !== undefined ? { progress: evaluation.progress } : {}),
    ...(evaluation.waiting !== undefined ? { waiting: evaluation.waiting } : {}),
    ...(evaluation.evaluatorFailed !== undefined
      ? { evaluatorFailed: evaluation.evaluatorFailed }
      : {}),
    reason: evaluation.reason.slice(0, 1_000),
    at,
    ...(evidenceTrace ? { evidenceTrace: structuredClone(evidenceTrace) } : {}),
  };
}

function emptySnapshot(): GoalManagerSnapshot {
  return {
    stateVersion: 3,
    currentGoal: null,
    controlLease: null,
    coordinator: structuredClone(EMPTY_COORDINATOR),
  };
}

/** Session-owned synchronous Goal state machine. Host owns admission and evaluator I/O. */
export class GoalManager {
  private state = emptySnapshot();
  private readonly now: () => number;
  private readonly listeners = new Set<GoalManagerListener>();
  private unboundRun?: UnboundRun;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  create(options: GoalCreateOptions, expectedRevision?: number): Goal {
    const { condition, maxIterations, blockCap, tokenBudget } = parseGoalConfig(options);
    const previous = this.state.currentGoal;
    if (previous && isIncomplete(previous.status))
      throw new Error(`Goal ${previous.id} 尚未完成（${previous.status}），不能替换`);
    if (previous && expectedRevision === undefined)
      throw new Error(`替换终态 Goal ${previous.id} 时必须提供 expectedRevision`);
    if (previous && expectedRevision !== undefined && previous.revision !== expectedRevision)
      throw new Error(
        `Goal revision 冲突：expected ${expectedRevision}, actual ${previous.revision}`,
      );
    if (!previous && expectedRevision !== undefined && expectedRevision !== 0)
      throw new Error(`Goal revision 冲突：expected ${expectedRevision}, actual 0`);

    const now = this.now();
    const unboundRun = this.unboundRun;
    const generation = (this.state.controlLease?.generation ?? 0) + 1;
    const goal: Goal = {
      id: `goal-${randomUUID()}`,
      revision: 1,
      condition,
      status: "active",
      createdAt: now,
      maxIterations,
      blockCap,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
      iterations: 0,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
      consecutiveNoProgress: 0,
      ...(options.awaitingUserTurn ? { armedAt: now } : {}),
    };
    const coordinator: GoalCoordinator = {
      ...structuredClone(this.state.coordinator),
      pendingContinuation: null,
      currentExecution: null,
    };
    if (unboundRun && !options.awaitingUserTurn) {
      coordinator.currentExecution = this.makeExecution(goal, unboundRun, true, generation);
    }
    this.state = {
      stateVersion: 3,
      currentGoal: goal,
      controlLease: {
        goalId: goal.id,
        generation,
      },
      coordinator,
    };
    this.emitChange();
    return goal;
  }

  get(id: string): Goal | undefined {
    return this.state.currentGoal?.id === id ? this.state.currentGoal : undefined;
  }

  getCurrent(): Goal | undefined {
    return this.state.currentGoal ?? undefined;
  }

  getActive(): Goal | undefined {
    const goal = this.state.currentGoal;
    return goal && (goal.status === "active" || goal.status === "waiting") ? goal : undefined;
  }

  list(): Goal[] {
    return this.state.currentGoal ? [this.state.currentGoal] : [];
  }

  /** Host binds an admitted user or Goal Run before Engine execution. */
  beginRun(
    runId: string,
    turnId = runId,
    origin: GoalRunOrigin = "user",
    daemonRunId = runId,
    identity: GoalRunIdentity = {},
  ): GoalExecutionRef | undefined {
    const unbound: UnboundRun = {
      runId,
      daemonRunId,
      turnId,
      origin,
      ...identity,
    };
    // Keep the active Run identity available so a model-created Goal (or a model
    // resume after pausing) is bound before observers see its active snapshot.
    this.unboundRun = unbound;
    const goal = this.state.currentGoal;
    if (!goal) {
      return undefined;
    }
    if (isTerminal(goal.status) || goal.status === "paused") {
      this.setCoordinator({ currentExecution: null });
      return undefined;
    }
    if (goal.status === "waiting" && origin === "user") {
      goal.status = "active";
      delete goal.lastReason;
      goal.revision++;
    }
    if (goal.status === "waiting" && origin === "goal") {
      this.setCoordinator({ pendingContinuation: null, currentExecution: null });
      return undefined;
    }
    delete goal.armedAt;
    const existing = this.state.coordinator.currentExecution;
    const execution =
      existing && existing.runId === runId && existing.daemonRunId === daemonRunId
        ? {
            ...existing,
            goalId: goal.id,
            revision: goal.revision,
            generation: this.state.controlLease?.generation ?? goal.revision,
            origin,
            started: true,
          }
        : this.makeExecution(goal, unbound, true);
    this.state.coordinator = {
      ...this.state.coordinator,
      pendingContinuation: null,
      currentExecution: execution,
    };
    this.emitChange();
    return execution;
  }

  endRun(runId?: string): void {
    if (!runId || this.unboundRun?.runId === runId || this.unboundRun?.daemonRunId === runId)
      delete this.unboundRun;
    // The Host owns terminal settlement and must retain currentExecution until
    // it has accounted usage and evaluated this Run.
  }

  /** Applies one evaluator result only if it still owns the exact Goal revision checkpoint. */
  settle(input: GoalSettleInput): Goal | undefined {
    const goal = this.state.currentGoal;
    if (
      !goal ||
      goal.id !== input.checkpoint.goalId ||
      goal.revision !== input.checkpoint.revision ||
      isTerminal(goal.status) ||
      goal.status === "paused"
    ) {
      return undefined;
    }
    const outcome = evaluationOutcome(input.evaluation);
    const at = this.now();
    const record = evaluationRecord(input.evaluation, at, input.evidenceTrace);
    goal.lastEvaluation = record;
    goal.lastReason = record.reason;

    // A terminal evaluator verdict wins before counters and token baselines change.
    if (outcome === "met" || outcome === "impossible") {
      goal.status = outcome === "met" ? "achieved" : "impossible";
      if (outcome === "met") goal.achievedAt = at;
      goal.revision++;
      this.finishCurrentExecution(goal);
      this.state.controlLease = null;
      this.emitChange();
      return goal;
    }

    if (!Number.isSafeInteger(input.tokensNow) || input.tokensNow < 0)
      throw new Error("tokensNow 必须是非负安全整数");
    const tokensNow = Math.max(goal.tokensNow, input.tokensNow);
    if (goal.tokensBaselinePending) {
      goal.tokensAtStart = tokensNow;
      goal.tokensBaselinePending = false;
    }
    goal.tokensNow = tokensNow;
    if (goal.tokenBudget !== undefined && tokensNow - goal.tokensAtStart >= goal.tokenBudget) {
      goal.status = "budget_limited";
      goal.lastReason = `Goal token budget (${goal.tokenBudget}) exhausted`;
      goal.revision++;
      this.finishCurrentExecution(goal);
      this.state.controlLease = null;
      this.emitChange();
      return goal;
    }

    goal.iterations++;
    if (goal.iterations >= goal.maxIterations) {
      goal.status = "max_iterations";
      goal.lastReason = `Goal reached maxIterations (${goal.maxIterations})`;
      goal.revision++;
      this.finishCurrentExecution(goal);
      this.state.controlLease = null;
      this.emitChange();
      return goal;
    }

    if (input.evaluation.evaluatorFailed !== true && input.evaluation.waiting !== true) {
      if (input.evaluation.progress === true) goal.consecutiveNoProgress = 0;
      else if (input.evaluation.progress === false) goal.consecutiveNoProgress++;
    }
    if (goal.consecutiveNoProgress >= goal.blockCap) {
      goal.status = "stalled";
      goal.lastReason = `Goal stalled after ${goal.consecutiveNoProgress} consecutive turns without progress`;
      goal.revision++;
      this.finishCurrentExecution(goal);
      this.state.controlLease = null;
      this.emitChange();
      return goal;
    }

    goal.status = outcome === "waiting" ? "waiting" : "active";
    goal.revision++;
    this.finishCurrentExecution(goal);
    this.emitChange();
    return goal;
  }

  pause(id: string, reason = "用户暂停", expectedRevision?: number): Goal | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    this.assertRevision(goal, expectedRevision);
    if (!isIncomplete(goal.status)) return goal;
    goal.status = "paused";
    goal.pausedAt = this.now();
    goal.lastReason = reason;
    goal.revision++;
    this.state.coordinator = {
      ...this.state.coordinator,
      pendingContinuation: null,
    };
    this.renewLease(goal);
    const currentExecution = this.state.coordinator.currentExecution;
    if (this.unboundRun && currentExecution) {
      this.state.coordinator = {
        ...this.state.coordinator,
        currentExecution: {
          ...currentExecution,
          revision: goal.revision,
          generation: this.state.controlLease!.generation,
        },
      };
    } else if (this.unboundRun) {
      this.state.coordinator = {
        ...this.state.coordinator,
        currentExecution: this.makeExecution(goal, this.unboundRun, true),
      };
    }
    this.emitChange();
    return goal;
  }

  resume(id: string, expectedRevision?: number): Goal | undefined {
    const goal = this.get(id);
    if (!goal) return undefined;
    this.assertRevision(goal, expectedRevision);
    if (goal.status !== "paused") return undefined;
    goal.status = "active";
    delete goal.pausedAt;
    delete goal.armedAt;
    goal.revision++;
    const priorExecution = this.state.coordinator.currentExecution;
    this.state.coordinator = {
      ...this.state.coordinator,
      pendingContinuation: null,
      currentExecution: this.unboundRun ? priorExecution : null,
    };
    this.renewLease(goal);
    const currentExecution = this.state.coordinator.currentExecution;
    if (this.unboundRun && currentExecution) {
      this.state.coordinator = {
        ...this.state.coordinator,
        currentExecution: {
          ...currentExecution,
          revision: goal.revision,
          generation: this.state.controlLease!.generation,
        },
      };
    } else if (this.unboundRun) {
      this.state.coordinator = {
        ...this.state.coordinator,
        currentExecution: this.makeExecution(goal, this.unboundRun, true),
      };
    }
    this.emitChange();
    return goal;
  }

  clear(id: string, expectedRevision?: number): boolean {
    const goal = this.get(id);
    if (!goal) return false;
    this.assertRevision(goal, expectedRevision);
    const coordinator = structuredClone(this.state.coordinator);
    goal.status = "cleared";
    goal.revision++;
    goal.lastReason = "Goal 已清除";
    goal.lastEvaluation = {
      reason: "Goal 已清除",
      at: this.now(),
    };
    coordinator.pendingContinuation = null;
    coordinator.currentExecution = null;
    this.state = { stateVersion: 3, currentGoal: goal, controlLease: null, coordinator };
    this.emitChange();
    return true;
  }

  /** Host-owned durable continuation/admission facts. Does not change the Goal CAS revision. */
  setCoordinator(patch: Partial<GoalCoordinator>): void {
    this.state.coordinator = { ...this.state.coordinator, ...structuredClone(patch) };
    this.emitChange();
  }

  /** Host wakes an external wait using its retry scheduler; wait deadlines remain ephemeral. */
  wakeWaiting(id: string): boolean {
    const goal = this.get(id);
    if (!goal || goal.status !== "waiting") return false;
    goal.status = "active";
    goal.revision++;
    this.emitChange();
    return true;
  }

  snapshot(): GoalManagerSnapshot {
    return structuredClone(this.state);
  }

  restore(snapshot: GoalManagerSnapshot): void {
    const normalized = normalizeGoalManagerSnapshot(snapshot);
    if (!normalized)
      throw new Error("Goal 快照无效；当前只支持 Goal schema v3，请清理旧 Session 数据后重试");
    this.state = structuredClone(normalized);
    delete this.unboundRun;
  }

  subscribe(listener: GoalManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStallWarning(): string | null {
    const goal = this.getActive();
    return goal && goal.consecutiveNoProgress >= Math.max(1, goal.blockCap - 3)
      ? `目标 ${goal.id} 已连续 ${goal.consecutiveNoProgress} 轮无进展，接近停滞上限 ${goal.blockCap}。`
      : null;
  }

  buildGoalContext(): string {
    const goal = this.getActive();
    if (!goal) return "";
    const usedTokens = Math.max(0, goal.tokensNow - goal.tokensAtStart);
    return [
      "## 当前 Goal",
      `- ${statusMark(goal.status)} ${goal.condition}`,
      `- 迭代：${goal.iterations}/${goal.maxIterations}`,
      `- Token：${usedTokens}${goal.tokenBudget !== undefined ? `/${goal.tokenBudget}（剩余 ${Math.max(0, goal.tokenBudget - usedTokens)}）` : ""}`,
      `- 连续无进展：${goal.consecutiveNoProgress}/${goal.blockCap}`,
      ...(goal.lastReason ? [`- 最近状态：${goal.lastReason}`] : []),
      "完成或不可达时停止工作；等待外部事件时说明等待原因。",
    ].join("\n");
  }

  private makeExecution(
    goal: Goal,
    run: UnboundRun,
    started: boolean,
    generation = this.state.controlLease?.generation ?? goal.revision,
  ): GoalExecutionRef {
    const now = this.now();
    return {
      goalId: goal.id,
      revision: goal.revision,
      generation,
      prompt: run.prompt ?? "",
      createdAt: run.createdAt ?? now,
      ...(run.triggeringRunId ? { triggeringRunId: run.triggeringRunId } : {}),
      runId: run.runId,
      daemonRunId: run.daemonRunId,
      turnId: run.turnId,
      invocationId: run.invocationId ?? run.runId,
      runStartedEventId: run.runStartedEventId ?? `run.started:${run.runId}`,
      runStartedAt: run.runStartedAt ?? now,
      origin: run.origin,
      started,
    };
  }

  private finishCurrentExecution(goal: Goal): void {
    const execution = this.state.coordinator.currentExecution;
    if (execution?.goalId !== goal.id) return;
    this.state.coordinator = {
      ...this.state.coordinator,
      currentExecution: null,
      pendingContinuation: null,
      lastSettledRunId: execution.daemonRunId,
      accountedRunIds: this.state.coordinator.accountedRunIds.includes(execution.daemonRunId)
        ? this.state.coordinator.accountedRunIds
        : [...this.state.coordinator.accountedRunIds, execution.daemonRunId],
    };
  }

  private renewLease(goal: Goal): void {
    this.state.controlLease = {
      goalId: goal.id,
      generation: Math.max((this.state.controlLease?.generation ?? 0) + 1, goal.revision),
    };
  }

  private assertRevision(goal: Goal, expectedRevision?: number): void {
    if (expectedRevision !== undefined && goal.revision !== expectedRevision)
      throw new Error(`Goal revision 冲突：expected ${expectedRevision}, actual ${goal.revision}`);
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Runtime-state subscribers persist independently; one failure must not block transitions.
      }
    }
  }
}
