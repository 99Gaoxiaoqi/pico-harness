import type { EngineRuntimePort } from "./engine-runtime-port.js";
import type { SessionForkRuntimePort } from "./session-fork-runtime-port.js";
import { SessionForkService } from "./session-fork-service.js";
import type { Session } from "./session.js";
import type { FileHistoryRewindTransactionHooks } from "@pico/pico-host/file-history-runtime";
import { createRuntimeSessionForkLifecycle } from "@pico/runtime/session-fork-runtime-lifecycle";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";

/**
 * Host compatibility adapter for Runtime's durable fork lifecycle. Only the
 * physical Session/FileHistory transaction remains outside the Runtime package.
 */
export function createSessionForkRuntimePort(): SessionForkRuntimePort {
  const runtimePort: SessionForkRuntimePort = createRuntimeSessionForkLifecycle<
    Session,
    EngineRuntimePort,
    FileHistoryRewindTransactionHooks
  >({
    engineRuntimePort: createEngineRuntimePort(),
    forkSession: async (input) => {
      const service = new SessionForkService({
        workDir: input.workDir,
        ...(input.picoHome === undefined ? {} : { picoHome: input.picoHome }),
        ...(input.fileHistoryBaseDir === undefined
          ? {}
          : { fileHistoryBaseDir: input.fileHistoryBaseDir }),
        runtimePort,
      });
      try {
        try {
          await service.fork({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            ...(input.operationId ? { operationId: input.operationId } : {}),
            ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
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
  });
  return runtimePort;
}
