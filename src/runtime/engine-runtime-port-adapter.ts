import type {
  EngineRuntimeHistoryEntry,
  EngineRuntimePort,
  EngineRuntimeRepairProjectionOptions,
  EngineRuntimeReconcileOptions,
  EngineRuntimeRun,
  EngineRuntimeRunStartOptions,
} from "../engine/runtime-port.js";
import { configureDefaultEngineRuntimePort } from "../engine/runtime-port.js";
import {
  currentRuntimeRun,
  currentRuntimeToolCallId,
  runWithRuntimeToolCall,
  RuntimeRun,
} from "./runtime-run.js";
import type { RuntimeEventStore } from "./runtime-event-store.js";
import type { RuntimeHistoryProjectionEntry } from "./runtime-event-read-model.js";

/**
 * Adapts the concrete durable RuntimeRun to the small port consumed by the
 * engine.  All implementation-specific casts are kept here so the engine does
 * not import RuntimeRun, RuntimeEventStore, or the runtime projection module.
 */
export function createEngineRuntimePort(): EngineRuntimePort {
  return {
    currentRun: () => currentRuntimeRun(),
    currentToolCallId: () => currentRuntimeToolCallId(),
    runWithToolCall: (toolCallId, execute) => runWithRuntimeToolCall(toolCallId, execute),
    reconcileIncompleteRuns: (options: EngineRuntimeReconcileOptions) =>
      RuntimeRun.reconcileIncompleteRuns({
        sessionId: options.sessionId,
        workDir: options.workDir,
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
        writeGuard: options.writeGuard,
      }),
    repairSessionProjection: (
      session,
      options: EngineRuntimeRepairProjectionOptions,
    ): Promise<boolean> =>
      RuntimeRun.repairSessionProjection(session, {
        workDir: options.workDir,
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
      }),
    startRun: (options: EngineRuntimeRunStartOptions): Promise<EngineRuntimeRun> =>
      RuntimeRun.start({
        sessionId: options.sessionId,
        workDir: options.workDir,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
        ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
        writeGuard: options.writeGuard,
      }),
    commitExternalMessages: (session, messages) =>
      RuntimeRun.commitExternalMessages(session, messages),
    commitExternalMessageOnce: (session, eventId, message) =>
      RuntimeRun.commitExternalMessageOnce(session, eventId, message),
  };
}

/** Structural assertion used by tests and host assembly. */
export function asEngineRuntimeHistoryEntry(
  entry: RuntimeHistoryProjectionEntry,
): EngineRuntimeHistoryEntry {
  return { eventId: entry.eventId, message: entry.message };
}

// Legacy Session constructors do not carry a port option; the Runtime
// composition module registers one canonical adapter for those hosts.
configureDefaultEngineRuntimePort(createEngineRuntimePort());
