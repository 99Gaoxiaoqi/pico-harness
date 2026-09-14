import type { RuntimeEvent } from "@pico/storage/runtime-event";
import {
  RuntimeEventStoreOwnerFenceError,
  type RuntimeOwnerFence,
} from "@pico/storage/runtime-event-store-contracts";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { materializeRuntimeHistory } from "./session-runtime-read-model.js";
import type { RuntimeProjectionSession } from "./runtime-projection-session.js";
import { deriveRuntimeForkBootstrapRunId, RuntimeRun } from "./runtime-run.js";
import type { RuntimeSessionForkPort } from "./session-fork-runtime-port.js";

type ForkSessionInput<Session, EnginePort, RewindHooks> = Parameters<
  RuntimeSessionForkPort<Session, EnginePort, RuntimeEvent, RewindHooks>["forkSession"]
>[0];

export interface CreateRuntimeSessionForkLifecycleOptions<
  Session,
  EnginePort,
  RewindHooks,
> {
  readonly engineRuntimePort: EnginePort;
  /** Host-owned filesystem/Session fork transaction and settlement. */
  forkSession(input: ForkSessionInput<Session, EnginePort, RewindHooks>): Promise<void>;
}

/**
 * Runtime-owned durable fork lifecycle. The Host injects only the physical fork
 * transaction; history validation, repair, bootstrap identity and owner fencing
 * remain canonical Runtime behavior.
 */
export function createRuntimeSessionForkLifecycle<
  Session extends RuntimeProjectionSession,
  EnginePort,
  RewindHooks,
>(
  options: CreateRuntimeSessionForkLifecycleOptions<Session, EnginePort, RewindHooks>,
): RuntimeSessionForkPort<Session, EnginePort, RuntimeEvent, RewindHooks> {
  return {
    engineRuntimePort: options.engineRuntimePort,
    forkSession: options.forkSession,
    validateModelHistory: (events) => {
      void materializeRuntimeHistory(events);
    },
    reconcileIncompleteRuns: (input) =>
      RuntimeRun.reconcileIncompleteRuns({ capability: input.capability }),
    repairSessionProjection: (session, input) =>
      RuntimeRun.repairSessionProjection(session, { capability: input.capability }),
    bootstrapFork: async (input) => {
      const store = requireRuntimeEventStore(input.runtimeAuthority);
      let ownerFence: RuntimeOwnerFence | undefined;
      const writeGuard = {
        assertRuntimeEventWriteAllowed: async (): Promise<RuntimeOwnerFence> => {
          await input.publication.assertOwned();
          if (!ownerFence) {
            await store.initializeSession({
              sessionId: input.targetSessionId,
              workDir: input.workDir,
            });
            const current = await store.readOwnerFence(input.targetSessionId);
            ownerFence = await store.advanceOwnerFence(input.targetSessionId, current.epoch);
            return ownerFence;
          }
          const current = await store.readOwnerFence(input.targetSessionId);
          if (current.epoch !== ownerFence.epoch) {
            throw new RuntimeEventStoreOwnerFenceError(
              input.targetSessionId,
              ownerFence.epoch,
              current.epoch,
            );
          }
          return ownerFence;
        },
      };
      await RuntimeRun.bootstrapFork({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.operationCreatedAt ? { operationCreatedAt: input.operationCreatedAt } : {}),
        seedEntries: input.seedEntries,
        ...(input.modelCheckpoint ? { modelCheckpoint: input.modelCheckpoint } : {}),
        ...(input.sourceThroughEventId
          ? { sourceThroughEventId: input.sourceThroughEventId }
          : {}),
        ...(input.statePublication ? { statePublication: input.statePublication } : {}),
        ...(input.workflowEvents ? { workflowEvents: input.workflowEvents } : {}),
        workDir: input.workDir,
        store,
        writeGuard,
      });
    },
    deriveBootstrapRunId: (input) => {
      const store = requireRuntimeEventStore(input.runtimeAuthority);
      return deriveRuntimeForkBootstrapRunId({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.operationCreatedAt ? { operationCreatedAt: input.operationCreatedAt } : {}),
        seedEntries: input.seedEntries,
        ...(input.modelCheckpoint ? { modelCheckpoint: input.modelCheckpoint } : {}),
        ...(input.sourceThroughEventId
          ? { sourceThroughEventId: input.sourceThroughEventId }
          : {}),
        ...(input.statePublication ? { statePublication: input.statePublication } : {}),
        workDir: input.workDir,
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
