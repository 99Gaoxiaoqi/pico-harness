import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli, type CliRuntime } from "../../../src/cli/main.js";
import {
  normalizeSessionRuntimeStatePatch,
  createEmptyUsageSnapshot,
  type SessionRuntimePersistence,
} from "../../../src/engine/session-runtime.js";
import {
  createDefaultSessionSettings,
  getOrCreateSessionSettings,
  snapshotSessionSettings,
} from "../../../src/input/session-settings.js";
import {
  createClientCommandRegistry,
  processClientInput,
} from "../../../src/tui/client-commands.js";
import {
  ClientSessionRuntime,
  type DaemonSessionClient,
} from "../../../src/tui/client-session-runtime.js";
import { TuiReporter } from "../../../src/tui/tui-reporter.js";
import { buildStatusBarText } from "../../../src/tui/status-bar.js";

test("Swarm session settings survive durable hydration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pico-swarm-settings-"));
  try {
    const settings = createDefaultSessionSettings({
      sessionId: "persist",
      cwd,
      provider: "openai",
      model: "model",
      modelRouteId: "provider/model",
      orchestrationMode: "swarm",
    });
    const persisted = normalizeSessionRuntimeStatePatch({
      settings: snapshotSessionSettings(settings),
    })?.settings;
    assert.equal(persisted?.orchestrationMode, "swarm");
    assert.ok(persisted);
    let savedMode: string | undefined;
    const persistence: SessionRuntimePersistence = {
      getRuntimeStateSnapshot: () => ({
        stateVersion: 3,
        settings: persisted,
        usage: createEmptyUsageSnapshot(),
      }),
      updateRuntimeState: (patch) => {
        savedMode = patch.settings?.orchestrationMode;
      },
    };
    const restored = getOrCreateSessionSettings(
      {
        sessionId: "restored",
        cwd,
        provider: "openai",
        model: "model",
        modelRouteId: "provider/model",
        orchestrationMode: "graph",
      },
      { persistence },
    );
    assert.equal(restored.orchestrationMode, "swarm");
    assert.equal(savedMode, "swarm");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Swarm TUI commands send one-run overrides without changing persistent Graph, and start new sessions in Swarm", async () => {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let orchestrationMode = "graph";
  const client = {
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "session.settings.get") return { settings: { orchestrationMode } };
      if (method === "session.settings.update") {
        orchestrationMode = String(params.orchestrationMode);
        return { settings: { orchestrationMode } };
      }
      if (method === "session.send")
        return { session: { sessionId: "session" }, run: { runId: "run" }, disposition: "started" };
      if (method === "config.effective.get")
        return { config: { defaults: { orchestrationMode: "default" } } };
      if (method === "session.subscription.open")
        throw new Error("No hydration in this transport fixture");
      return {};
    },
    subscribeSessionFrames: () => ({ dispose: () => undefined }),
  } as unknown as DaemonSessionClient;
  const reporter = new TuiReporter({ onProjectionUpdate: () => undefined });
  const runtime = new ClientSessionRuntime({
    client,
    workspacePath: "/workspace",
    sessionId: "session",
    reporter,
  });
  const registry = createClientCommandRegistry({ runtime, workspacePath: "/workspace" });
  await processClientInput("/swarm off", registry, runtime);
  assert.equal(orchestrationMode, "graph");
  await processClientInput("/swarm implement API", registry, runtime);
  const sent = requests.find((entry) => entry.method === "session.send");
  assert.deepEqual(sent?.params.input, {
    kind: "text",
    text: "implement API",
    orchestrationMode: "swarm",
  });
  assert.equal(requests.filter((entry) => entry.method === "session.settings.update").length, 0);
  assert.equal(orchestrationMode, "graph");
  await processClientInput("/swarm on", registry, runtime);
  assert.equal(orchestrationMode, "swarm");
  await processClientInput("/swarm status", registry, runtime);
  assert.equal(orchestrationMode, "swarm");
  assert.match(buildStatusBarText({ orchestrationMode: "swarm", renderWidth: 120 }), /编排 swarm/u);
  await processClientInput("/swarm off", registry, runtime);
  assert.equal(orchestrationMode, "default");
  const fresh = new ClientSessionRuntime({
    client,
    workspacePath: "/workspace",
    reporter,
    orchestrationModeOverride: "swarm",
  });
  assert.equal(fresh.preSessionSettings.orchestrationMode, "swarm");
  await fresh.sendText("first message");
  assert.deepEqual(
    requests.filter((entry) => entry.method === "session.send").at(-1)?.params.initialSettings,
    { collaborationMode: "agent", permissionMode: "ask", orchestrationMode: "swarm" },
  );
  await fresh.dispose();
  await runtime.dispose();
});

test("CLI --swarm is passed to the TUI and rejects --graph together", async () => {
  const calls: unknown[] = [];
  const errors: string[] = [];
  const runtime: CliRuntime = {
    env: {},
    version: "test",
    writeStdout: () => undefined,
    writeStderr: (value) => {
      errors.push(value);
    },
    primeTokenizer: async () => undefined,
    resolveCliWorkDir: async () => "/workspace",
    ensureWorkspaceTrusted: async () => undefined,
    resolveCliStartupSession: async () => ({
      workDir: "/workspace",
      sessionSelection: { mode: "new", sessionId: "new" },
    }),
    startClientRepl: async (options) => {
      calls.push(options);
    },
  };
  assert.equal(await runCli(["--swarm"], runtime), 0);
  assert.deepEqual(calls, [{ workDir: "/workspace", swarmMode: true }]);
  assert.equal(await runCli(["--swarm", "--graph"], runtime), 1);
  assert.equal(calls.length, 1);
  assert.match(errors.join(""), /不能同时使用/u);
});
