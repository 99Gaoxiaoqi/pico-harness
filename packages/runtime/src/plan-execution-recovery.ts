import { PLAN_EVENT_KINDS, type PlanProjection } from "@pico/core";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { PlanCoordinator, type RuntimeEventWriteGuard } from "./plan-coordinator.js";
import { projectActivePlanEntries } from "./plan-reducer.js";

/** Engine-owned in-memory Run liveness, injected so Runtime stays independent from Engine. */
export type RuntimeRunLiveness = (sessionId: string, runId: string) => boolean;

export async function reconcilePlanExecution(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  writeGuard?: RuntimeEventWriteGuard,
  isAdmissionLive: (operationId: string) => boolean = () => false,
  isRunLive: RuntimeRunLiveness = () => false,
): Promise<PlanProjection> {
  // plan.* + run.started 事件切片(票 04):本函数只消费 plan 事件与
  // transition 之后的 run.started 准入事实,不再全量读。
  const { entries } = await store.readSessionEntriesOfKinds(sessionId, [
    ...PLAN_EVENT_KINDS,
    "run.started",
  ]);
  const coordinator = new PlanCoordinator(store, {
    sessionId,
    invocationId: "plan-reconcile",
    runId: "plan-reconcile",
    turnId: "plan-reconcile",
    ...(writeGuard ? { writeGuard } : {}),
  });
  const projection = await coordinator.project();
  if (projection.execution?.status !== "active") return projection;
  const transition = projectActivePlanEntries(entries)
    .filter(
      ({ event }) =>
        event.kind === "plan.execution.started" || event.kind === "plan.execution.resumed",
    )
    .at(-1);
  if (!transition) return projection;
  const transitionOperationId =
    "operationId" in transition.event.data ? transition.event.data.operationId : undefined;
  if (typeof transitionOperationId === "string" && isAdmissionLive(transitionOperationId)) {
    return projection;
  }
  if (await isPlanGraphWaiting(store, sessionId, projection, isRunLive)) return projection;
  const admittedRun = entries
    .filter(({ sequence, event }) => sequence > transition.sequence && event.kind === "run.started")
    .at(-1);
  if (admittedRun && isRunLive(sessionId, admittedRun.event.runId)) return projection;
  const current = await coordinator.project();
  if (current.execution?.status !== "active") return current;
  return await coordinator.interrupt({
    operationId: `reconcile-plan-execution:${transition.event.eventId}`,
    expectedSessionSequence: current.sessionSequence,
    planId: current.execution.planId,
    reason: admittedRun
      ? "RuntimeRun ended without closing the active plan execution"
      : "Plan execution transition has no durable RuntimeRun admission",
  });
}

/** Only the latest root Run's durable yield can keep a bound plan alive. */
export async function isPlanGraphWaiting(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  projection: PlanProjection,
  isRunLive: RuntimeRunLiveness = () => false,
): Promise<boolean> {
  const binding = projection.execution?.graph;
  if (!binding || projection.execution?.status !== "active") return false;
  const graphStore = new SqliteAgentGraphControlStore({ storageRoot: store.storageRoot });
  try {
    const graph = graphStore.getGraph(binding.graphId);
    if (
      !graph ||
      graph.epoch !== binding.epoch ||
      graph.rootSessionId !== sessionId ||
      graph.phase !== "open"
    )
      return false;
    const { entries } = await store.readSessionEntriesOfKinds(sessionId, [
      "run.started",
      "run.terminal",
    ]);
    const latest = entries.filter(({ event }) => event.kind === "run.started").at(-1);
    if (!latest) return false;
    if (isRunLive(sessionId, latest.event.runId)) return true;
    const terminal = entries
      .filter(({ event }) => event.runId === latest.event.runId && event.kind !== "run.started")
      .at(-1);
    if (
      terminal &&
      (terminal.event.kind !== "run.terminal" || terminal.event.data.status !== "completed")
    )
      return false;
    const interest = graphStore
      .listYieldInterests(binding.graphId)
      .find((item) => item.rootRunId === latest.event.runId && item.state !== "cancelled");
    if (!interest) return false;
    if (interest.state === "registered") return true;
    return graphStore
      .listSupervisorWakes(binding.graphId)
      .some((wake) =>
        ["pending", "running", "waiting_permission", "retryable_failed"].includes(wake.status),
      );
  } finally {
    graphStore.close();
  }
}
