import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";

test("session fork runtime port preserves the durable fork lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-fork-port-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const source = new Session("fork-port-source", workDir, { persistence: true, picoHome });
  try {
    await source.recover();
    await source.commitMessages({ role: "user", content: "seed" });
    const store = source.runtimeEventStore!;
    const port = createSessionForkRuntimePort();
    await port.reconcileIncompleteRuns({
      sessionId: source.id,
      workDir,
      store,
      writeGuard: source,
    });

    const messages = source.getHistory();
    const runId = port.deriveBootstrapRunId({
      sourceSessionId: source.id,
      targetSessionId: "fork-port-target",
      operationId: "fork-port-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      messages,
      workDir,
      store,
    });
    assert.match(runId, /^fork-bootstrap:/u);

    await port.bootstrapFork({
      sourceSessionId: source.id,
      targetSessionId: "fork-port-target",
      operationId: "fork-port-operation",
      operationCreatedAt: "2026-01-01T00:00:00.000Z",
      messages,
      workDir,
      store,
    });
    const targetEvents = await store.readSession("fork-port-target");
    assert.equal(
      targetEvents.some((event) => event.kind === "session.forked"),
      true,
    );
    assert.equal(
      targetEvents.some((event) => event.kind === "run.terminal"),
      true,
    );
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
