import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStore, RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import { projectGraphEntries } from "./graph-reducer.js";
import type { GraphProjection, GraphWork } from "./contract.js";

/**
 * Context for orphan-work recovery. Only durable sessions participate: in-memory
 * sessions cannot lose work to a crash because nothing was persisted.
 */
export interface RecoverOrphanGraphWorksContext {
  readonly runtimeStore: RuntimeEventStore;
  readonly sessionId: string;
  readonly graphId: string;
}

/**
 * Result of an orphan scan: the workIds that were dispatched to a run which has
 * since terminated without producing a record. The caller is responsible for
 * emitting recovery events (graph.work.failed or a fresh graph.work.dispatched);
 * this function never writes to the store.
 */
export interface RecoverOrphanGraphWorksResult {
  readonly orphanWorkIds: readonly string[];
  readonly projection: GraphProjection;
}

/**
 * Detects orphan graph works: works marked `dispatched` whose backing delegation
 * run has terminated (a `run.terminal` event with matching runId exists) without
 * a corresponding `graph.work.recorded` or `graph.work.failed` fact.
 *
 * The mapping delegationId -> runId is by value equality: the delegation runtime
 * mints the RuntimeRun runId from the same delegation id, so we treat the stored
 * delegationId as the runId for terminal lookup. This simplified scanner only
 * returns the orphan workIds; durable recovery is the caller's responsibility.
 */
export async function findOrphanGraphWorks(
  context: RecoverOrphanGraphWorksContext,
): Promise<RecoverOrphanGraphWorksResult> {
  const entries = await context.runtimeStore.readSessionEntries(context.sessionId);
  const projection = projectGraphEntries(context.graphId, entries);
  if (projection.status !== "active") {
    return { orphanWorkIds: [], projection };
  }
  const terminalRunIds = collectTerminalRunIds(entries);
  if (terminalRunIds.size === 0) {
    return { orphanWorkIds: [], projection };
  }
  const orphanWorkIds = projection.works
    .filter((work) => isOrphan(work, terminalRunIds))
    .map((work) => work.workId);
  return { orphanWorkIds, projection };
}

function isOrphan(work: GraphWork, terminalRunIds: Set<string>): boolean {
  if (work.status !== "dispatched") return false;
  if (!work.delegationId) return false;
  return terminalRunIds.has(work.delegationId);
}

function collectTerminalRunIds(entries: readonly RuntimeEventStoreEntry[]): Set<string> {
  const terminalRunIds = new Set<string>();
  for (const { event } of entries) {
    if (isRunTerminalEvent(event)) terminalRunIds.add(event.runId);
  }
  return terminalRunIds;
}

function isRunTerminalEvent(
  event: RuntimeEvent,
): event is Extract<RuntimeEvent, { kind: "run.terminal" }> {
  return event.kind === "run.terminal";
}
