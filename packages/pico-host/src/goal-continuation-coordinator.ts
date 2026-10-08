import { randomUUID } from "node:crypto";
import type {
  PersistedGoalState as GoalState,
  PersistedGoalContinuationIntent as GoalContinuationIntent,
  PersistedGoalExecutionRef as GoalExecutionRef,
  Message,
} from "@pico/core";
import type { GoalManager, GoalEvaluation } from "@pico/runtime/goal-manager";
import type { GoalEvidenceTrace } from "@pico/runtime/goal-evaluator";
import type { Session } from "./session.js";
import { INTERRUPTED_DAEMON_RUN_ERROR } from "./workspace-run-lifecycle.js";

export interface GoalRunCompletion {
  readonly runId: string;
  readonly status: string;
  readonly stopReason?: string;
  readonly error?: string;
  readonly primaryUsage?: { readonly promptTokens: number; readonly completionTokens: number };
}
export type GoalAdmissionResult =
  | { kind: "started" }
  | { kind: "busy" }
  | { kind: "unavailable"; reason: string };
export interface GoalContinuationDeps {
  withSession<T>(
    workspace: string,
    sessionId: string,
    work: (session: Session, manager: GoalManager) => Promise<T>,
  ): Promise<T>;
  evaluate(
    workspace: string,
    session: Session,
    goal: GoalState,
    execution: GoalExecutionRef,
    messages: readonly Message[],
    signal: AbortSignal,
  ): Promise<GoalEvaluation & { readonly evidenceTrace?: GoalEvidenceTrace }>;
  admit(
    workspace: string,
    sessionId: string,
    intent: GoalContinuationIntent,
  ): Promise<GoalAdmissionResult>;
  dispatchUser(workspace: string): Promise<boolean>;
  getRun(workspace: string, runId: string): Promise<GoalRunCompletion | undefined>;
  changed(workspace: string, sessionId: string, goal: GoalState | null): void;
  report(workspace: string, error: unknown): void;
  now?: () => number;
  initialWaitMs?: number;
}
interface Lane {
  workspace: string;
  sessionId: string;
  tail: Promise<void>;
  queued: number;
  unsubscribe?: () => void;
  manager?: GoalManager;
  abort?: AbortController | undefined;
  evaluationRevision?: number | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
  waitCount: number;
  generation?: number | undefined;
}

/** Host-owned per-Session FIFO settlement. Network waits never hold the Session execution lock. */
export class GoalContinuationCoordinator {
  private readonly lanes = new Map<string, Lane>();
  private readonly workspaceDrains = new Map<string, Promise<void>>();
  private readonly pendingWorkspaceWakes = new Set<string>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly deps: GoalContinuationDeps) {
    this.now = deps.now ?? Date.now;
  }

  private lane(workspace: string, sessionId: string): Lane {
    const key = `${workspace}\0${sessionId}`;
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { workspace, sessionId, tail: Promise.resolve(), queued: 0, waitCount: 0 };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  observe(workspace: string, sessionId: string, manager: GoalManager): void {
    const lane = this.lane(workspace, sessionId);
    if (lane.manager === manager) return;
    lane.unsubscribe?.();
    lane.manager = manager;
    lane.generation = manager.snapshot().controlLease?.generation;
    lane.unsubscribe = manager.subscribe((snapshot) => {
      const goal = snapshot.currentGoal;
      const generation = snapshot.controlLease?.generation;
      if (generation !== lane.generation) {
        lane.generation = generation;
        this.clearWait(lane);
        lane.waitCount = 0;
      }
      if (lane.abort && (goal?.revision !== lane.evaluationRevision || goal?.status !== "active")) {
        lane.abort.abort(new DOMException("Goal control changed", "AbortError"));
      }
      this.deps.changed(workspace, sessionId, goal);
      // Model tools may resume the Goal. Admission still passes the workspace/user gates.
      if (
        !this.closed &&
        !lane.queued &&
        goal?.status === "active" &&
        goal.armedAt === undefined &&
        !snapshot.coordinator.currentExecution
      )
        this.wakeWorkspace(workspace);
    });
  }

  isSettling(workspace: string, sessionId: string): boolean {
    return (this.lanes.get(`${workspace}\0${sessionId}`)?.queued ?? 0) > 0;
  }

  finish(workspace: string, sessionId: string, completion: GoalRunCompletion): Promise<void> {
    if (this.closed) return Promise.resolve();
    const lane = this.lane(workspace, sessionId);
    lane.queued++;
    const task = lane.tail.then(() => this.settle(lane, completion));
    lane.tail = task
      .catch((error) => this.deps.report(workspace, error))
      .finally(() => {
        lane.queued--;
        if (!this.closed) this.wakeWorkspace(workspace);
      });
    return lane.tail;
  }

  private async settle(lane: Lane, completion: GoalRunCompletion): Promise<void> {
    await this.deps.withSession(lane.workspace, lane.sessionId, async (session, manager) => {
      const before = manager.snapshot();
      if (
        completion.error === INTERRUPTED_DAEMON_RUN_ERROR &&
        before.coordinator.currentExecution?.daemonRunId === completion.runId &&
        before.coordinator.currentExecution.started === false
      ) {
        // Materializing the daemon ledger emits a synthetic failure on restart.
        // A prepared admission has not executed yet and retains its reserved identity.
        return;
      }
      let workTokens = before.coordinator.workTokens;
      if (!before.coordinator.accountedRunIds.includes(completion.runId)) {
        const usage = completion.primaryUsage;
        workTokens += usage
          ? Math.max(0, usage.promptTokens) + Math.max(0, usage.completionTokens)
          : 0;
        manager.setCoordinator({
          workTokens,
          accountedRunIds: [...before.coordinator.accountedRunIds, completion.runId],
        });
        await session.flushPersistence();
      }
      const current = manager.snapshot();
      const execution = current.coordinator.currentExecution;
      const goal = current.currentGoal;
      if (
        !goal ||
        goal.armedAt !== undefined ||
        !execution ||
        execution.daemonRunId !== completion.runId ||
        current.coordinator.lastSettledRunId === completion.runId ||
        current.controlLease?.generation !== execution.generation ||
        execution.goalId !== goal.id ||
        (goal.status !== "active" && goal.status !== "waiting")
      )
        return;
      this.clearWait(lane);
      if (
        completion.status !== "succeeded" ||
        completion.stopReason === "step_limit" ||
        completion.stopReason === "budget_limit"
      ) {
        manager.pause(
          goal.id,
          completion.error ??
            (completion.status === "cancelled"
              ? "用户中断了运行"
              : `运行结束：${completion.stopReason ?? completion.status}`),
        );
        manager.setCoordinator({
          lastSettledRunId: completion.runId,
          currentExecution: null,
          pendingContinuation: null,
        });
        await session.flushPersistence();
        return;
      }
      // Read an immutable context at this Run's boundary before releasing control to the evaluator.
      let messages: readonly Message[];
      try {
        messages = (await session.readHydrationSnapshot()).messages;
      } catch (error) {
        manager.pause(goal.id, `无法读取验收上下文：${String(error)}`);
        await session.flushPersistence();
        return;
      }
      if (manager.getCurrent()?.status === "waiting") manager.wakeWaiting(goal.id);
      const captured = manager.snapshot();
      const active = captured.currentGoal!;
      const abort = new AbortController();
      lane.abort = abort;
      lane.evaluationRevision = active.revision;
      let evaluation: GoalEvaluation & { readonly evidenceTrace?: GoalEvidenceTrace };
      try {
        evaluation = await this.deps.evaluate(
          lane.workspace,
          session,
          active,
          execution,
          messages,
          abort.signal,
        );
      } catch (error) {
        if (abort.signal.aborted) return;
        evaluation = { evaluatorFailed: true, reason: `验收调用失败：${String(error)}` };
      } finally {
        if (lane.abort === abort) {
          lane.abort = undefined;
          lane.evaluationRevision = undefined;
        }
      }
      const latest = manager.snapshot();
      if (
        this.closed ||
        latest.currentGoal?.id !== active.id ||
        latest.currentGoal.revision !== active.revision ||
        latest.controlLease?.generation !== captured.controlLease?.generation ||
        latest.coordinator.currentExecution?.daemonRunId !== completion.runId
      )
        return;
      manager.settle({
        checkpoint: { goalId: active.id, revision: active.revision },
        evaluation,
        ...(evaluation.evidenceTrace ? { evidenceTrace: evaluation.evidenceTrace } : {}),
        tokensNow: workTokens,
      });
      const settled = manager.getCurrent()!;
      const pending =
        settled.status === "active" || settled.status === "waiting"
          ? this.newIntent(manager, completion.runId)
          : null;
      manager.setCoordinator({
        currentExecution: null,
        lastSettledRunId: completion.runId,
        pendingContinuation: pending,
      });
      await session.flushPersistence();
      if (settled.status === "waiting") {
        lane.waitCount++;
        this.scheduleWait(lane);
      } else lane.waitCount = 0;
    });
  }

  private newIntent(manager: GoalManager, triggeringRunId?: string): GoalContinuationIntent {
    const snapshot = manager.snapshot();
    const goal = snapshot.currentGoal!;
    const runId = `goal-run-${randomUUID()}`;
    return {
      goalId: goal.id,
      revision: goal.revision,
      generation: snapshot.controlLease!.generation,
      ...(triggeringRunId ? { triggeringRunId } : {}),
      prompt: `[Goal continuation]\n目标：${goal.condition}\n最近验收：${goal.lastReason ?? "继续推进目标"}\n请根据实际进展继续工作；说明完成事实或外部等待原因。`,
      createdAt: this.now(),
      runId,
      daemonRunId: runId,
      turnId: `turn:${runId}:0`,
      invocationId: `goal-invocation-${randomUUID()}`,
      runStartedEventId: `goal-start-${randomUUID()}`,
      runStartedAt: this.now(),
    };
  }

  wakeWorkspace(workspace: string): void {
    if (this.closed) return;
    if (this.workspaceDrains.has(workspace)) {
      this.pendingWorkspaceWakes.add(workspace);
      return;
    }
    const task = Promise.resolve()
      .then(() => this.drainWorkspace(workspace))
      .catch((error) => this.deps.report(workspace, error));
    this.workspaceDrains.set(workspace, task);
    void task.finally(() => {
      if (this.workspaceDrains.get(workspace) === task) this.workspaceDrains.delete(workspace);
      if (this.pendingWorkspaceWakes.delete(workspace)) this.wakeWorkspace(workspace);
    });
  }

  private async drainWorkspace(workspace: string): Promise<void> {
    if (this.closed) return;
    const candidates = [...this.lanes.values()].filter(
      (lane) => lane.workspace === workspace && !lane.queued && !lane.timer,
    );
    // Record a resume intention even while the workspace is occupied. Its persisted
    // enqueue time determines ordering when queued user input has drained.
    for (const lane of candidates) {
      await this.deps.withSession(workspace, lane.sessionId, async (session, manager) => {
        const snapshot = manager.snapshot();
        if (
          snapshot.currentGoal?.status === "active" &&
          snapshot.currentGoal.armedAt === undefined &&
          !snapshot.coordinator.pendingContinuation &&
          !snapshot.coordinator.currentExecution
        ) {
          manager.setCoordinator({ pendingContinuation: this.newIntent(manager) });
          await session.flushPersistence();
        }
      });
    }
    if (this.closed || (await this.deps.dispatchUser(workspace))) return;
    candidates.sort(
      (a, b) =>
        (a.manager?.snapshot().coordinator.pendingContinuation?.createdAt ?? Infinity) -
        (b.manager?.snapshot().coordinator.pendingContinuation?.createdAt ?? Infinity),
    );
    for (const lane of candidates) {
      const admitted = await this.deps.withSession(
        workspace,
        lane.sessionId,
        async (session, manager) => {
          let snapshot = manager.snapshot();
          const goal = snapshot.currentGoal;
          if (
            this.closed ||
            !goal ||
            goal.armedAt !== undefined ||
            (goal.status !== "active" && goal.status !== "waiting")
          )
            return false;
          if (goal.status === "waiting") {
            this.scheduleWait(lane);
            return false;
          }
          if (snapshot.coordinator.currentExecution?.started) return false;
          if (!snapshot.coordinator.pendingContinuation && !snapshot.coordinator.currentExecution) {
            manager.setCoordinator({ pendingContinuation: this.newIntent(manager) });
            await session.flushPersistence();
            snapshot = manager.snapshot();
          }
          const intent =
            snapshot.coordinator.pendingContinuation ?? snapshot.coordinator.currentExecution;
          if (
            !intent ||
            intent.goalId !== goal.id ||
            intent.generation !== snapshot.controlLease?.generation
          )
            return false;
          const result = await this.deps.admit(workspace, lane.sessionId, intent);
          if (result.kind === "unavailable" && manager.getCurrent()?.id === goal.id) {
            manager.pause(goal.id, result.reason);
            await session.flushPersistence();
          }
          return result.kind === "started";
        },
      );
      if (admitted) return;
    }
  }

  private clearWait(lane: Lane): void {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = undefined;
  }
  private scheduleWait(lane: Lane): void {
    if (this.closed || lane.timer) return;
    const delay = Math.min(
      (this.deps.initialWaitMs ?? 5_000) * 2 ** Math.min(6, Math.max(0, lane.waitCount - 1)),
      300_000,
    );
    lane.timer = setTimeout(() => {
      lane.timer = undefined;
      void this.deps
        .withSession(lane.workspace, lane.sessionId, async (session, manager) => {
          const goal = manager.getCurrent();
          if (goal?.status !== "waiting") return;
          manager.wakeWaiting(goal.id);
          const pending = manager.snapshot().coordinator.pendingContinuation;
          if (pending)
            manager.setCoordinator({
              pendingContinuation: { ...pending, revision: manager.getCurrent()!.revision },
            });
          await session.flushPersistence();
        })
        .then(
          () => this.wakeWorkspace(lane.workspace),
          (error) => this.deps.report(lane.workspace, error),
        );
    }, delay);
    lane.timer.unref?.();
  }

  async recover(workspace: string, sessionId: string): Promise<void> {
    const completion = await this.deps.withSession(
      workspace,
      sessionId,
      async (session, manager) => {
        const snapshot = manager.snapshot();
        const goal = snapshot.currentGoal;
        if (
          !goal ||
          (goal.status !== "active" && goal.status !== "waiting") ||
          goal.armedAt !== undefined
        )
          return;
        const execution = snapshot.coordinator.currentExecution;
        if (execution) {
          const run = await this.deps.getRun(workspace, execution.daemonRunId);
          // Canonical execution can finish before the daemon publishes its result.
          // Recover that cut from the Run ledger and the already-persisted outcome.
          const facts = await session.runtimeEventStore?.readRun(sessionId, execution.runId);
          const terminal = facts?.find((event) => event.kind === "run.terminal");
          if (
            terminal?.kind === "run.terminal" &&
            (!run || run.error === INTERRUPTED_DAEMON_RUN_ERROR)
          ) {
            return {
              runId: execution.daemonRunId,
              status: terminal.data.status === "completed" ? "succeeded" : terminal.data.status,
              ...(execution.stopReason ? { stopReason: execution.stopReason } : {}),
              ...(terminal.data.reason ? { error: terminal.data.reason } : {}),
            };
          }
          const preparedOnly =
            !execution.started &&
            run?.status === "failed" &&
            run.error === INTERRUPTED_DAEMON_RUN_ERROR;
          if (run && !preparedOnly && ["succeeded", "failed", "cancelled"].includes(run.status))
            return run;
          if (run && !preparedOnly) return;
          if (execution.started) {
            manager.pause(goal.id, "上次执行异常中断；请检查后恢复 Goal");
            await session.flushPersistence();
            return;
          }
        }
        const lane = this.lane(workspace, sessionId);
        if (goal.status === "waiting") {
          lane.waitCount = 1;
          this.scheduleWait(lane);
        }
      },
    );
    if (completion) await this.finish(workspace, sessionId, completion);
    this.wakeWorkspace(workspace);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const lane of this.lanes.values()) {
      this.clearWait(lane);
      lane.abort?.abort(new DOMException("Goal coordinator closed", "AbortError"));
      lane.unsubscribe?.();
    }
    await Promise.allSettled([...this.lanes.values()].map((lane) => lane.tail));
    await Promise.allSettled([...this.workspaceDrains.values()]);
  }
}
