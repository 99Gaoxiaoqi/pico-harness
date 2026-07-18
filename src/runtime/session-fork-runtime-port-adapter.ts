import type { SessionForkRuntimePort } from "../engine/session-fork-runtime-port.js";
import { materializeRuntimeHistory } from "./runtime-event-read-model.js";
import { deriveRuntimeForkBootstrapRunId, RuntimeRun } from "./runtime-run.js";
import type { RuntimeEventStore } from "./runtime-event-store.js";
import type { RuntimeForkModelCheckpointSeed } from "./runtime-run.js";
import { projectRuntimeSessionMessageEntries } from "./runtime-session-projection.js";

/** Runtime-owned implementation of the narrow fork lifecycle contract. */
export function createSessionForkRuntimePort(): SessionForkRuntimePort {
  return {
    validateModelHistory: (events) => {
      void materializeRuntimeHistory(events);
    },
    projectModelMessages: (events) => projectRuntimeSessionMessageEntries(events),
    reconcileIncompleteRuns: (options) =>
      RuntimeRun.reconcileIncompleteRuns({
        sessionId: options.sessionId,
        workDir: options.workDir,
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
        writeGuard: options.writeGuard,
      }),
    repairSessionProjection: (session, options) =>
      RuntimeRun.repairSessionProjection(session, {
        workDir: options.workDir,
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
      }),
    bootstrapFork: async (options) => {
      await RuntimeRun.bootstrapFork({
        sourceSessionId: options.sourceSessionId,
        targetSessionId: options.targetSessionId,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.operationCreatedAt ? { operationCreatedAt: options.operationCreatedAt } : {}),
        messages: options.messages,
        ...(options.modelCheckpoint
          ? { modelCheckpoint: options.modelCheckpoint as RuntimeForkModelCheckpointSeed }
          : {}),
        ...(options.sourceThroughEventId
          ? { sourceThroughEventId: options.sourceThroughEventId }
          : {}),
        workDir: options.workDir,
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
      });
    },
    deriveBootstrapRunId: (options) =>
      deriveRuntimeForkBootstrapRunId({
        sourceSessionId: options.sourceSessionId,
        targetSessionId: options.targetSessionId,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.operationCreatedAt ? { operationCreatedAt: options.operationCreatedAt } : {}),
        messages: options.messages,
        ...(options.modelCheckpoint
          ? { modelCheckpoint: options.modelCheckpoint as RuntimeForkModelCheckpointSeed }
          : {}),
        ...(options.sourceThroughEventId
          ? { sourceThroughEventId: options.sourceThroughEventId }
          : {}),
        workDir: options.workDir,
        ...(options.store ? { store: options.store as RuntimeEventStore } : {}),
      }),
  };
}
