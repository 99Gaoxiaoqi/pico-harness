import type { AgentGraphRunLaunchState } from "@pico/runtime";
import { INTERRUPTED_DAEMON_RUN_ERROR } from "./workspace-run-lifecycle.js";

/** Narrow daemon-run projection consumed by the Agent Graph runtime read model. */
export interface WorkspaceRunLaunchSnapshot {
  readonly sessionId?: string;
  readonly status:
    | "running"
    | "pause_requested"
    | "paused"
    | "cancelling"
    | "succeeded"
    | "failed"
    | "cancelled";
  readonly error?: string;
}

/** Maps host-owned Run liveness into the Runtime Agent Graph's read-only state. */
export function agentGraphLaunchStateFromWorkspaceRun(
  run: WorkspaceRunLaunchSnapshot | undefined,
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
