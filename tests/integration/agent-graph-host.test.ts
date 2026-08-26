import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import { createAgentGraphWorkspaceHost } from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";

test("workspace Graph host exposes one root binding and owns application lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-host-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const manager = new SessionManager({
    createSession: (id, targetWorkDir, options) =>
      new Session(id, targetWorkDir, {
        ...options,
        persistence: true,
        picoHome,
        runtimePort,
      }),
  });
  const owner = await manager.getOrCreatePinned("root-session", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const host = createAgentGraphWorkspaceHost({
    workDir,
    storageRoot: owner.session.runtimeEventStore!.storageRoot,
    runtimeEventStore: owner.session.runtimeEventStore!,
    sessionManager: manager,
    sessionOptions: { persistence: true, picoHome, runtimePort },
    execute: async () => undefined,
  });
  try {
    await host.start();
    const binding = host.rootBinding({
      graphId: "graph:root-session",
      rootSessionId: "root-session",
      rootTurnId: "root-turn",
      rootRunId: "root-run",
    });
    assert.equal(binding.kind, "root");
    if (binding.kind !== "root") return;
    assert.deepEqual(binding.getRootContext(), {
      kind: "graph_root_supervisor",
      graphId: "graph:root-session",
      rootSessionId: "root-session",
      rootTurnId: "root-turn",
      rootRunId: "root-run",
    });
    const projection = await binding.toolPort.readProjection({
      graphId: "graph:root-session",
      rootSessionId: "root-session",
    });
    assert.equal(projection.graph.headRevision, 0);
    assert.equal(host.store.listGraphs("root-session").length, 1);
  } finally {
    await host.close();
    owner.release();
    await manager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace runtime idempotently installs a trusted exact Run id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-exact-workspace-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtime = await WorkspaceTaskRuntime.create({ workDir });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = runtime.startExactRun(
      "exact-run-1",
      { description: "Graph root wake", sessionId: "root-session" },
      async () => gate,
    );
    const replay = runtime.startExactRun(
      "exact-run-1",
      { description: "Graph root wake", sessionId: "root-session" },
      async () => {
        throw new Error("replay must not install a second executor");
      },
    );
    assert.equal(first.runId, "exact-run-1");
    assert.equal(replay.version, first.version);
    assert.throws(
      () =>
        runtime.startExactRun(
          "exact-run-1",
          { description: "another request", sessionId: "root-session" },
          async () => undefined,
        ),
      /其他请求/,
    );
    release();
    assert.equal((await runtime.waitForRun("exact-run-1")).status, "succeeded");
  } finally {
    release();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
