import type { SessionForkRuntimePort } from "../engine/session-fork-runtime-port.js";
import { SessionForkService } from "../engine/session-fork-service.js";
import { materializeRuntimeHistory } from "../engine/session-runtime-read-model.js";
import { deriveRuntimeForkBootstrapRunId, RuntimeRun } from "./runtime-run.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";

/** Runtime-owned implementation of the narrow fork lifecycle contract. */
export function createSessionForkRuntimePort(): SessionForkRuntimePort {
  const runtimePort: SessionForkRuntimePort = {
    engineRuntimePort: createEngineRuntimePort(),
    forkSession: async (input) => {
      const service = new SessionForkService({
        workDir: input.workDir,
        picoHome: input.picoHome,
        fileHistoryBaseDir: input.fileHistoryBaseDir,
        runtimePort,
      });
      try {
        try {
          await service.fork({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            ...(input.operationId ? { operationId: input.operationId } : {}),
            ...(input.targetMode !== undefined ? { targetMode: input.targetMode } : {}),
            ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
            ...(input.fallbackSettings ? { fallbackSettings: input.fallbackSettings } : {}),
            ...(input.rewind ? { rewind: input.rewind } : {}),
          });
        } catch (error) {
          const settlement = await service.settleFailedFork({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            ...(input.cleanupOnlyOnFailure ? { cleanupOnly: true } : {}),
          });
          if (settlement !== "committed") throw error;
        }
      } finally {
        service.close();
      }
    },
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
  return runtimePort;
}

function requireRuntimeEventStore(authority: object): SqliteRuntimeEventStore {
  if (!(authority instanceof SqliteRuntimeEventStore)) {
    throw new Error("Session fork Runtime authority is not a RuntimeEventStore");
  }
  return authority;
}
