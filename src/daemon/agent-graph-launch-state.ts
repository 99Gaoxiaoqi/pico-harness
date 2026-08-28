import type { AgentGraphRunLaunchState } from "../agent-graph/runtime-activation-projection.js";
import type { WorkspaceRunSnapshot } from "../runtime/workspace-runtime.js";
import { INTERRUPTED_DAEMON_RUN_ERROR } from "./workspace-runtime-service.js";

/** One daemon-owned mapping shared by production execution and Desktop read projections. */
export function agentGraphLaunchStateFromWorkspaceRun(
  run: WorkspaceRunSnapshot | undefined,
  expectedSessionId: string,
): AgentGraphRunLaunchState {
  if (!run || run.sessionId !== expectedSessionId) return { status: "unknown" };
  if (["running", "pause_requested", "paused", "cancelling"].includes(run.status)) {
    return { status: "running" };
  }
  if (run.status === "succeeded") return { status: "succeeded" };
  if (run.status === "failed" && run.error === INTERRUPTED_DAEMON_RUN_ERROR) {
    return { status: "interrupted", error: run.error };
  }
  if (run.status === "failed" || run.status === "cancelled") {
    return {
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
    };
  }
  return { status: "unknown" };
}
