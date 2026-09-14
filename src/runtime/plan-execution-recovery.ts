import type { PlanProjection } from "@pico/core";
import {
  isPlanGraphWaiting as isPlanGraphWaitingFromRuntime,
  reconcilePlanExecution as reconcilePlanExecutionFromRuntime,
} from "@pico/runtime/plan-execution-recovery";
import type { EngineRuntimeWriteGuard } from "@pico/runtime/runtime-capability";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { isRuntimeRunLive } from "@pico/runtime/runtime-run";

export async function reconcilePlanExecution(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  writeGuard?: EngineRuntimeWriteGuard,
  isAdmissionLive: (operationId: string) => boolean = () => false,
): Promise<PlanProjection> {
  return reconcilePlanExecutionFromRuntime(
    store,
    sessionId,
    writeGuard,
    isAdmissionLive,
    isRuntimeRunLive,
  );
}

/** Only the latest root Run's durable yield can keep a bound plan alive. */
export async function isPlanGraphWaiting(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  projection: PlanProjection,
): Promise<boolean> {
  return isPlanGraphWaitingFromRuntime(store, sessionId, projection, isRuntimeRunLive);
}
