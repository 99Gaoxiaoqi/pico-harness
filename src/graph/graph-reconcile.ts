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

/** True if the graph still has any un-recorded work (requested or dispatched). */
export function hasPendingWorks(projection: GraphProjection): boolean {
  return (
    projection.status === "active" &&
    projection.works.some((w) => w.status === "requested" || w.status === "dispatched")
  );
}
