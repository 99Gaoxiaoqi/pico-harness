import type { RuntimeEventStore } from "../storage/runtime-event-store.js";
import { projectGraphEntries } from "./graph-reducer.js";
import type { GraphProjection } from "./contract.js";

/**
 * Context for orphan-work recovery. Only durable sessions participate: in-memory
 * sessions cannot lose work to a crash because nothing was persisted.
 *
 * `isWorkLeaseLive` queries the durable `graph-work:${workId}` lease: a
 * dispatched work whose lease is dead (TTL expired / never acquired / released)
 * has lost its backing delegation — the process restarted and heartbeat stopped,
 * so the TTL elapsed. The caller supplies this from the live DelegationManager
 * (which owns the RuntimeStore lease source); the scanner itself stays pure and
 * store-backed.
 */
export interface RecoverOrphanGraphWorksContext {
  readonly runtimeStore: RuntimeEventStore;
  readonly sessionId: string;
  readonly graphId: string;
  readonly isWorkLeaseLive: (workId: string) => boolean;
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
 * delegation's durable lease is dead (TTL elapsed after the host stopped
 * heartbeating, e.g. on process restart).
 *
 * Earlier implementations matched `work.delegationId` against in-process live
 * delegation ids; that relied on the "empty after restart" negative signal of a
 * freshly-constructed DelegationManager, which is fragile (any future
 * persistence/hydration of records would silently break it). The lease-liveness
 * check is a positive, durable signal: a dispatched work whose lease TTL has
 * elapsed can never settle on its own, so it is safe to mark failed+recovered.
 */
export async function findOrphanGraphWorks(
  context: RecoverOrphanGraphWorksContext,
): Promise<RecoverOrphanGraphWorksResult> {
  const entries = await context.runtimeStore.readSessionEntries(context.sessionId);
  const projection = projectGraphEntries(context.graphId, entries);
  if (projection.status !== "active") {
    return { orphanWorkIds: [], projection };
  }
  const orphanWorkIds = projection.works
    .filter(
      (work) => work.status === "dispatched" && !context.isWorkLeaseLive(work.workId),
    )
    .map((work) => work.workId);
  return { orphanWorkIds, projection };
}
