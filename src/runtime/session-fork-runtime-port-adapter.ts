import type { SessionForkRuntimePort } from "../engine/session-fork-runtime-port.js";
import { materializeRuntimeHistory } from "./runtime-event-read-model.js";
import { deriveRuntimeForkBootstrapRunId, RuntimeRun } from "./runtime-run.js";
import { projectRuntimeSessionMessageEntries } from "./runtime-session-projection.js";
import { RuntimeEventStore } from "./runtime-event-store.js";

/** Runtime-owned implementation of the narrow fork lifecycle contract. */
export function createSessionForkRuntimePort(): SessionForkRuntimePort {
  return {
    validateModelHistory: (events) => {
      void materializeRuntimeHistory(events);
    },
    projectModelMessages: (events) => projectRuntimeSessionMessageEntries(events),
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
        messages: options.messages,
        ...(options.modelCheckpoint ? { modelCheckpoint: options.modelCheckpoint } : {}),
        ...(options.sourceThroughEventId
          ? { sourceThroughEventId: options.sourceThroughEventId }
          : {}),
        workDir: options.workDir,
        store,
        writeGuard: {
          assertRuntimeEventWriteAllowed: () => options.publication.assertOwned(),
        },
        ...(options.statePublication ? { statePublication: options.statePublication } : {}),
      });
    },
    deriveBootstrapRunId: (options) => {
      const store = requireRuntimeEventStore(options.runtimeAuthority);
      return deriveRuntimeForkBootstrapRunId({
        sourceSessionId: options.sourceSessionId,
        targetSessionId: options.targetSessionId,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        ...(options.operationCreatedAt ? { operationCreatedAt: options.operationCreatedAt } : {}),
        messages: options.messages,
        ...(options.modelCheckpoint ? { modelCheckpoint: options.modelCheckpoint } : {}),
        ...(options.sourceThroughEventId
          ? { sourceThroughEventId: options.sourceThroughEventId }
          : {}),
        workDir: options.workDir,
        store,
      });
    },
  };
}

function requireRuntimeEventStore(authority: object): RuntimeEventStore {
  if (!(authority instanceof RuntimeEventStore)) {
    throw new Error("Session fork Runtime authority is not a RuntimeEventStore");
  }
  return authority;
}
