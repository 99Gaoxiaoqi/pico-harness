/** Stable runtime observation states used by Graph projections and control surfaces. */
export type AgentGraphRuntimeStatus =
  | "not-started"
  | "running"
  | "waiting-permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
