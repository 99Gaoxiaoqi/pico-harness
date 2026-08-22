import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";

test("engine runtime port preserves the canonical run and nested tool context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-engine-runtime-port-"));
  const port = createEngineRuntimePort();
  const session = new Session("engine-runtime-port", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: port,
  });
  try {
    await session.recover();
    const capability = session.runtimeEventCapability!;
    const run = await port.startRun({ capability });
    assert.strictEqual(run.runtimeCapability, capability);

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

test("durable Session rejects external message commits without an explicit RuntimePort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-engine-runtime-port-required-"));
  const session = new Session("engine-runtime-port-required", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  try {
    await session.recover();
    await assert.rejects(
      session.commitMessages({ role: "user", content: "must not be persisted" }),
      /requires an explicit RuntimePort/u,
    );
    await assert.rejects(
      session.commitMessageOnce("external:missing-port", {
        role: "user",
        content: "must not be persisted once",
      }),
      /requires an explicit RuntimePort/u,
    );
    await session.flushPersistence();
    assert.deepEqual(session.getHistory(), []);
    assert.deepEqual(
      (await session.runtimeEventStore!.readSession(session.id)).filter(
        (event) => event.kind === "message.committed",
      ),
      [],
    );
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("live RuntimeRun carries the owner fence through partial, tool T1/T2, and strict seal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-engine-runtime-fence-"));
  const port = createEngineRuntimePort();
  const session = new Session("engine-runtime-fence", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: port,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const fence = await session.assertRuntimeEventWriteAllowed();
  assert.ok(fence.epoch > 0);

  const run = await port.startRun({ capability: session.runtimeEventCapability! });
  const partial = await run.upsertPartialSnapshot("assistant", "assistant.delta", 0, {
    text: "hel",
  });
  assert.equal(partial.version, 1);
  await run.appendPartialSegment("assistant", 0, { text: "hel" });
  assert.equal((await run.readPartials()).segments.length, 1);

  await run.recordToolStarted("call:fenced", "read_file", '{"path":"README.md"}');
  await assert.rejects(
    run.recordToolStarted("call:fenced", "read_file", '{"path":"README.md"}'),
    /already bound|already prepared|conflicting dispatch/u,
  );
  const result = run.registerToolResult({
    toolCallId: "call:fenced",
    toolName: "read_file",
    status: "succeeded",
    body: {
      storage: "inline",
      content: "ok",
      sha256: "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
      sizeBytes: 2,
    },
    projection: {
      version: 1,
      mode: "full",
      text: "ok",
      strategy: "full",
      truncated: false,
    },
  });
  await run.commitMessages(session, [result]);
  assert.equal(
    (await session.runtimeEventStore!.readToolOperation(session.id, run.runId, "call:fenced"))
      ?.state,
    "settled",
  );

  await run.run(async () => undefined);
  assert.deepEqual(await run.readPartials(), { snapshots: [], segments: [] });
  await assert.rejects(
    run.upsertPartialSnapshot("late", "assistant.delta", 0, { text: "late" }),
    /already terminal/u,
  );
});

test("Session fails closed when its cached owner fence is superseded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-engine-runtime-stale-fence-"));
  const session = new Session("engine-runtime-stale-fence", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const fence = await session.assertRuntimeEventWriteAllowed();
  await session.runtimeEventStore!.advanceOwnerFence(session.id, fence.epoch);
  await assert.rejects(session.assertRuntimeEventWriteAllowed(), /owner fence validation failed/u);
  await assert.rejects(
    session.commitMessages({ role: "user", content: "stale owner must not write" }),
    /owner fence validation failed|owner fence changed/u,
  );
});
