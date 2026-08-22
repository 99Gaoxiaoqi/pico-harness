import type { SessionForkRuntimePort } from "../engine/session-fork-runtime-port.js";
import { materializeRuntimeHistory } from "../engine/session-runtime-read-model.js";
import { deriveRuntimeForkBootstrapRunId, RuntimeRun } from "./runtime-run.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";

/** Runtime-owned implementation of the narrow fork lifecycle contract. */
export function createSessionForkRuntimePort(): SessionForkRuntimePort {
  return {
    engineRuntimePort: createEngineRuntimePort(),
    validateModelHistory: (events) => {
      void materializeRuntimeHistory(events);
    },
    reconcileIncompleteRuns: (options) =>
      RuntimeRun.reconcileIncompleteRuns({
        capability: options.capability,
      }),
    repairSessionProjection: (session, options) =>
      RuntimeRun.repairSessionProjection(session, {
        capability: options.capability,
      }),
    bootstrapFork: async (options) => {
      const store = requireRuntimeEventStore(options.runtimeAuthority);
      await RuntimeRun.bootstrapFork({
        sourceSessionId: options.sourceSessionId,
        targetSessionId: options.targetSessionId,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.operationCreatedAt ? { operationCreatedAt: options.operationCreatedAt } : {}),
        seedEntries: options.seedEntries,
        ...(options.modelCheckpoint ? { modelCheckpoint: options.modelCheckpoint } : {}),
        ...(options.sourceThroughEventId
          ? { sourceThroughEventId: options.sourceThroughEventId }
          : {}),
        ...(options.statePublication ? { statePublication: options.statePublication } : {}),
        ...(options.workflowEvents ? { workflowEvents: options.workflowEvents } : {}),
        workDir: options.workDir,
        store,
        writeGuard: {
          assertRuntimeEventWriteAllowed: () => options.publication.assertOwned(),
        },
      });
    },
    deriveBootstrapRunId: (options) => {
      const store = requireRuntimeEventStore(options.runtimeAuthority);
      return deriveRuntimeForkBootstrapRunId({
        sourceSessionId: options.sourceSessionId,
        targetSessionId: options.targetSessionId,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.operationCreatedAt ? { operationCreatedAt: options.operationCreatedAt } : {}),
        seedEntries: options.seedEntries,
        ...(options.modelCheckpoint ? { modelCheckpoint: options.modelCheckpoint } : {}),
        ...(options.sourceThroughEventId
          ? { sourceThroughEventId: options.sourceThroughEventId }
          : {}),
        ...(options.statePublication ? { statePublication: options.statePublication } : {}),
        workDir: options.workDir,
        store,
      });
    },
  };
}

function requireRuntimeEventStore(authority: object): SqliteRuntimeEventStore {
  if (!(authority instanceof SqliteRuntimeEventStore)) {
    throw new Error("Session fork Runtime authority is not a RuntimeEventStore");
  }
  return authority;
}
