import type { GraphProjection, GraphWork } from "./contract.js";

/**
 * Works whose every declared input record has already been committed and which
 * are still pending dispatch. The orchestrator picks these up next.
 */
export function computeReadyWorks(projection: GraphProjection): GraphWork[] {
  if (projection.status !== "active") return [];
  const committedIds = new Set(projection.records.map((r) => r.recordId));
  return projection.works.filter(
    (w) => w.status === "requested" && w.inputIds.every((id) => committedIds.has(id)),
  );
}

/**
 * True if the graph still has any un-recorded work (requested or dispatched).
 *
 * Deliberately does NOT consult projection.status: a closed graph may still
 * carry in-flight (dispatched) or never-started (requested) works, and
 * view_graph must report that honestly rather than claim the graph converged.
 * The graph-continuation arbiter in the engine gates on status separately, so
 * this stays a pure read of the works slice.
 */
export function hasPendingWorks(projection: GraphProjection): boolean {
  return projection.works.some((w) => w.status === "requested" || w.status === "dispatched");
}

/**
 * Input record ids referenced by a work that are not committed yet. Mirrors
 * maka's `input_not_committed` diagnostic: a waiting work is only actionable
 * when the model knows *which* inputs are missing (and can tell a stale id
 * from an in-flight upstream).
 */
export function missingInputIdsFor(
  projection: GraphProjection,
  work: GraphWork,
): readonly string[] {
  const committedIds = new Set(projection.records.map((record) => record.recordId));
  return work.inputIds.filter((id) => !committedIds.has(id));
}
