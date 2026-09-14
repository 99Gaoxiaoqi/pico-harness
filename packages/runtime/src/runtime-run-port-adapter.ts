import type { RuntimePort } from "./runtime-port-contract.js";
import type { RuntimeProjectionSession } from "./runtime-projection-session.js";
import { RuntimeRun, currentRuntimeRun, currentRuntimeToolCallId, runWithRuntimeToolCall } from "./runtime-run.js";
import type {
  RuntimeToolRegistry,
  ToolExecutionContext,
  ToolRecoveryProbeResult,
} from "./runtime-tool-execution.js";

/**
 * Exposes RuntimeRun through the generic lifecycle port consumed by an outer Engine.
 * Concrete Session and Registry implementations remain type parameters owned by the caller.
 */
export function createRuntimeRunPort<
  Session extends RuntimeProjectionSession,
  Registry extends RuntimeToolRegistry,
>(): RuntimePort<Session, Registry, ToolExecutionContext, ToolRecoveryProbeResult> {
  return {
    currentRun: () => currentRuntimeRun(),
    currentToolCallId: () => currentRuntimeToolCallId(),
    runWithToolCall: (toolCallId, execute) => runWithRuntimeToolCall(toolCallId, execute),
    reconcileIncompleteRuns: (options) =>
      RuntimeRun.reconcileIncompleteRuns({ capability: options.capability }),
    repairSessionProjection: (session, options) =>
      RuntimeRun.repairSessionProjection(session, { capability: options.capability }),
    startRun: (options) =>
      RuntimeRun.start({
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
        capability: options.capability,
        agentSwarmAuthorization: "none",
      }),
    commitExternalMessages: (session, messages) =>
      RuntimeRun.commitExternalMessages(session, messages),
    commitExternalMessageOnce: (session, eventId, message) =>
      RuntimeRun.commitExternalMessageOnce(session, eventId, message),
  };
}
