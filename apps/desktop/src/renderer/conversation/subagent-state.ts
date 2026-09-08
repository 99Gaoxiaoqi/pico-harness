import type { ConversationProgressState } from "./types.js";

/** Reporter snapshots and durable transcript rows use the same lifecycle vocabulary. */
export function subagentProgressState(status: unknown): ConversationProgressState {
  switch (status) {
    case "completed":
    case "done":
      return "done";
    case "failed":
    case "timed_out":
    case "cancelled":
    case "partial":
      return "failed";
    case "queued":
    case "waiting":
      return "waiting";
    default:
      return "active";
  }
}
