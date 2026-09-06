import type { EngineRuntimeWriteGuard } from "../engine/runtime-port.js";
import { PlanCoordinator } from "../plan/coordinator.js";
import type { PlanProjection } from "../plan/contract.js";
import { PLAN_EVENT_KINDS } from "../plan/events.js";
import { projectActivePlanEntries } from "../plan/reducer.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import { isRuntimeRunLive } from "./runtime-run.js";

export async function reconcilePlanExecution(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  writeGuard?: EngineRuntimeWriteGuard,
  isAdmissionLive: (operationId: string) => boolean = () => false,
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
  if (await isPlanGraphWaiting(store, sessionId, projection)) return projection;
  const admittedRun = entries
    .filter(({ sequence, event }) => sequence > transition.sequence && event.kind === "run.started")
    .at(-1);
  if (admittedRun && isRuntimeRunLive(sessionId, admittedRun.event.runId)) return projection;
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
    if (isRuntimeRunLive(sessionId, latest.event.runId)) return true;
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
