import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../../src/engine/session.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime.js";

test("SessionRuntime reaches a terminal released state after owned cleanup fails", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-session-runtime-dispose-"));
  const session = new Session("runtime-dispose-retry", workDir, { persistence: false });
  let releases = 0;
  const runtime = await createSessionRuntime({
    session,
    sessionLease: {
      session,
      release: () => {
        releases++;
      },
    },
    hooks: false,
    lspServers: [],
  });
  context.after(async () => {
    await runtime.dispose().catch(() => undefined);
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  });
  const originalClose = runtime.codeIntelligenceManager.close.bind(runtime.codeIntelligenceManager);
  let closes = 0;
  runtime.codeIntelligenceManager.close = async () => {
    closes++;
    if (closes === 1) throw new Error("fixture close failure");
    await originalClose();
  };

  await assert.rejects(runtime.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors.map(String).join("\n"), /fixture close failure/u);
    return true;
  });
  assert.equal(releases, 1);
  assert.equal(runtime.hookRewakeQueue.enqueue("closed after terminal dispose"), false);
  await assert.rejects(runtime.dispose(), /cleanup failed/u);
  assert.equal(closes, 1);
  assert.equal(releases, 1);
});
