import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";

test("engine runtime port preserves the canonical run and nested tool context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-engine-runtime-port-"));
  const session = new Session("engine-runtime-port", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  try {
    await session.recover();
    const port = createEngineRuntimePort();
    const run = await port.startRun({
      sessionId: session.id,
      workDir: session.workDir,
      store: session.runtimeEventStore,
      writeGuard: session,
    });

    const result = await run.run(async () => {
      assert.equal(port.currentRun(), run);
      assert.equal(port.currentToolCallId(), undefined);
      const nestedToolCallId = port.runWithToolCall("tool-1", () => port.currentToolCallId());
      assert.equal(nestedToolCallId, "tool-1");
      assert.equal(port.currentRun(), run);
      await session.commitMessages({ role: "assistant", content: "through-port" });
      return run.claimsSession(session);
    });

    assert.equal(result, true);
    assert.equal(port.currentRun(), undefined);
    assert.deepEqual(session.getHistory(), [{ role: "assistant", content: "through-port" }]);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
