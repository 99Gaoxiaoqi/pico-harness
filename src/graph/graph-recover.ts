import type { RuntimeEventStore } from "../storage/runtime-event-store.js";
import { projectGraphEntries } from "./graph-reducer.js";
import type { GraphProjection } from "./contract.js";

/**
 * Context for orphan-work recovery. Only durable sessions participate: in-memory
 * sessions cannot lose work to a crash because nothing was persisted.
 *
 * `liveDelegationIds` is the set of delegation ids the current process's
 * DelegationManager still considers in-flight. A dispatched work whose
 * delegationId is absent from this set has lost its backing delegation — either
 * the process restarted (DelegationManager is a fresh empty instance) or the
 * delegation was otherwise reaped. The caller supplies this from the live
 * DelegationManager; the scanner itself stays pure and store-backed.
 */
export interface RecoverOrphanGraphWorksContext {
  readonly runtimeStore: RuntimeEventStore;
  readonly sessionId: string;
  readonly graphId: string;
  readonly liveDelegationIds: readonly string[];
}

/**
 * Result of an orphan scan: the workIds that were dispatched to a delegation
 * which is no longer live in this process. The caller is responsible for
 * emitting recovery events (graph.work.failed); this function never writes to
 * the store.
 */
export interface RecoverOrphanGraphWorksResult {
  readonly orphanWorkIds: readonly string[];
  readonly projection: GraphProjection;
}

/**
 * Detects orphan graph works: works marked `dispatched` whose backing
 * delegation is no longer tracked by the current process's DelegationManager.
 *
 * A previous implementation matched `work.delegationId` against `run.terminal`
 * event runIds, assuming delegationId === runId. That assumption does not hold:
 * delegationId is minted by DelegationManager.dispatch, while the backing
 * RuntimeRun's runId is minted independently by runtimePort.startRun inside
 * runSub. The two id spaces never intersect, so the old scan always returned
 * empty. The live-delegation check is both correct (a dispatched work must have
 * had a delegation; if it is gone, the work can never settle on its own) and
 * simpler (no terminal-event collection).
 */
export async function findOrphanGraphWorks(
  context: RecoverOrphanGraphWorksContext,
): Promise<RecoverOrphanGraphWorksResult> {
  const entries = await context.runtimeStore.readSessionEntries(context.sessionId);
  const projection = projectGraphEntries(context.graphId, entries);
  if (projection.status !== "active") {
    return { orphanWorkIds: [], projection };
  }
  const liveDelegationIds = new Set(context.liveDelegationIds);
  const orphanWorkIds = projection.works
    .filter(
      (work) =>
        work.status === "dispatched" &&
        typeof work.delegationId === "string" &&
        !liveDelegationIds.has(work.delegationId),
    )
    .map((work) => work.workId);
  return { orphanWorkIds, projection };
}
