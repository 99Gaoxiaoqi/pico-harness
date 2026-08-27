import { globalSessionManager } from "../../src/engine/session.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";

interface Input {
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
  readonly checkpointId: string;
  readonly targetSessionId: string;
  readonly operationId: string;
}

const encoded = process.argv[2];
if (!encoded) throw new Error("rewind SIGKILL child input is required");
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Input;
const lease = await globalSessionManager.getOrCreatePinned(input.sessionId, input.workDir, {
  persistence: true,
  picoHome: input.picoHome,
  runtimePort: createEngineRuntimePort(),
});

await lease.session.forkFromCheckpoint(
  input.checkpointId,
  "both",
  createSessionForkRuntimePort(),
  () => input.targetSessionId,
  undefined,
  {
    operationId: input.operationId,
    fileTransactionHooks: {
      afterApplyFile: (_file, index) => {
        if (index === 1) process.kill(process.pid, "SIGKILL");
      },
    },
  },
);

throw new Error("rewind SIGKILL child unexpectedly survived the crash cut");
