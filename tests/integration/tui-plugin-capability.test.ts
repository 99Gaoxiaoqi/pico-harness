import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  defineTrustedPluginCapabilityFactory,
  PluginCapabilityActivationScope,
  PluginCapabilityRegistry,
} from "../../src/plugins/plugin-capability.js";
import type { PluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";
import { registerPluginCapabilityTools } from "../../src/plugins/plugin-tool-activation.js";
import type { RunAgentCliDependencies } from "../../src/runtime/agent-runtime.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { mergeTuiToolSnapshot, runTuiAgentPrompt, startTuiRepl } from "../../src/tui/repl.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

test("TUI forwards the exact host capability registry into AgentRuntime", async () => {
  const capabilityRegistry = new PluginCapabilityRegistry();
  const reporter = new TuiReporter(() => undefined);
  let captured: RunAgentCliDependencies | undefined;

  await runTuiAgentPrompt(
    {
      prompt: "hello",
      dir: "/tmp/tui-plugin-capability",
      sessionSelection: { mode: "new", sessionId: "tui-plugin-capability" },
    },
    {
      reporter,
      pluginCapabilityRegistry: capabilityRegistry,
      async runAgent(_options, dependencies) {
        captured = dependencies;
        return {
          sessionId: "tui-plugin-capability",
          sessionSelection: { mode: "new", sessionId: "tui-plugin-capability" },
          workDir: "/tmp/tui-plugin-capability",
          finalMessage: "ok",
          usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
          messages: [],
        };
      },
    },
  );

  assert.strictEqual(captured?.pluginCapabilityRegistry, capabilityRegistry);
});

test("TUI startup registry can project Plugin tools before the first Agent run", async () => {
  const capabilityRegistry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "fixture-tool",
      versions: ["1"],
      kind: "tool",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "tool",
        config: {},
      }),
      toolNames: () => ["plugin_fixture"],
      activate: () =>
        activation([
          {
            name: () => "plugin_fixture",
            definition: () => ({
              name: "plugin_fixture",
              description: "fixture",
              inputSchema: { type: "object" },
            }),
            execute: async () => "ok",
          },
        ]),
    }),
  ]);
  const resolution = capabilityRegistry.resolve({ id: "fixture-plugin", version: "1.0.0" }, [
    { id: "fixture-tool", version: "1", config: {} },
  ]);
  const snapshot = {
    pluginIds: ["fixture-plugin"],
    skillSources: [],
    commandSources: [],
    agentSources: [],
    hookSources: [],
    mcpSources: [],
    lspServers: [],
    capabilities: resolution.capabilities,
    diagnostics: [],
    dispose: async () => undefined,
  } satisfies PluginRuntimeSnapshot;
  const registry = new ToolRegistry();

  const activationScope = new PluginCapabilityActivationScope();
  registerPluginCapabilityTools(
    registry,
    snapshot,
    capabilityRegistry,
    "/workspace",
    activationScope,
  );

  assert.equal(registry.getTool("plugin_fixture")?.name(), "plugin_fixture");
  await activationScope.dispose();
});

test("TUI releases its Plugin snapshot when the initial Session bundle fails", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tui-startup-cleanup-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sessionId = "tui-startup-cleanup";
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const previousEnv = {
    PICO_HOME: process.env.PICO_HOME,
    TERM: process.env.TERM,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  Object.assign(process.env, {
    PICO_HOME: picoHome,
    TERM: "xterm-256color",
    LLM_BASE_URL: "http://127.0.0.1:9/v1",
    LLM_API_KEY: "test",
    LLM_MODEL: "fixture-model",
  });
  context.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const session = globalSessionManager.delete(sessionId, workDir, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  });
  let disposeCount = 0;
  const snapshot: PluginRuntimeSnapshot = {
    pluginIds: [],
    skillSources: [],
    commandSources: [],
    agentSources: [],
    hookSources: [],
    mcpSources: [],
    lspServers: [],
    capabilities: [],
    diagnostics: [],
    dispose: async () => {
      disposeCount++;
    },
  };

  await assert.rejects(
    startTuiRepl(
      {
        workDir,
        model: "fixture-model",
        addDirs: [join(root, "missing")],
        sessionSelection: { mode: "new", sessionId },
      },
      { loadPluginSnapshot: async () => snapshot },
    ),
    /working directory does not exist|工作区目录不存在/u,
  );
  assert.equal(disposeCount, 1);
});

test("TUI validates Runtime storage before acquiring host resources", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tui-storage-preflight-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeFile(join(picoHome, "workspaces"), "not-a-directory", "utf8");
  const previousEnv = {
    PICO_HOME: process.env.PICO_HOME,
    TERM: process.env.TERM,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  Object.assign(process.env, {
    PICO_HOME: picoHome,
    TERM: "xterm-256color",
    LLM_BASE_URL: "http://127.0.0.1:9/v1",
    LLM_API_KEY: "test",
    LLM_MODEL: "fixture-model",
  });
  context.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  let snapshotLoads = 0;

  await assert.rejects(
    startTuiRepl(
      { workDir, model: "fixture-model" },
      {
        loadPluginSnapshot: async () => {
          snapshotLoads++;
          throw new Error("snapshot loader must not run");
        },
      },
    ),
    /ENOTDIR|not a directory/u,
  );
  assert.equal(snapshotLoads, 0);
});

test("TUI validates the daemon endpoint before acquiring host resources", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-tui-endpoint-preflight-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const previousEnv = {
    PICO_HOME: process.env.PICO_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    TERM: process.env.TERM,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  Object.assign(process.env, {
    PICO_HOME: picoHome,
    XDG_RUNTIME_DIR: join(root, "x".repeat(160)),
    TERM: "xterm-256color",
    LLM_BASE_URL: "http://127.0.0.1:9/v1",
    LLM_API_KEY: "test",
    LLM_MODEL: "fixture-model",
  });
  context.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  let snapshotLoads = 0;

  await assert.rejects(
    startTuiRepl(
      { workDir, model: "fixture-model" },
      {
        loadPluginSnapshot: async () => {
          snapshotLoads++;
          throw new Error("snapshot loader must not run");
        },
      },
    ),
    /Runtime 目录过长|Unix Socket/u,
  );
  assert.equal(snapshotLoads, 0);
});

test("Plugin tool projection checks host conflicts before activation", async () => {
  let activations = 0;
  const capabilityRegistry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "fixture-tools",
      versions: ["1"],
      kind: "tool",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "tool",
        config: {},
      }),
      toolNames: () => ["plugin_first", "host_conflict"],
      activate: () => {
        activations++;
        return activation([
          {
            name: () => "plugin_first",
            definition: () => ({
              name: "plugin_first",
              description: "first",
              inputSchema: { type: "object" },
            }),
            execute: async () => "first",
          },
          {
            name: () => "host_conflict",
            definition: () => ({
              name: "host_conflict",
              description: "conflict",
              inputSchema: { type: "object" },
            }),
            execute: async () => "conflict",
          },
        ]);
      },
    }),
  ]);
  const resolution = capabilityRegistry.resolve({ id: "fixture-plugin" }, [
    { id: "fixture-tools", version: "1", config: {} },
  ]);
  const snapshot = {
    pluginIds: ["fixture-plugin"],
    skillSources: [],
    commandSources: [],
    agentSources: [],
    hookSources: [],
    mcpSources: [],
    lspServers: [],
    capabilities: resolution.capabilities,
    diagnostics: [],
    dispose: async () => undefined,
  } satisfies PluginRuntimeSnapshot;
  const registry = new ToolRegistry();
  registry.register({
    name: () => "host_conflict",
    definition: () => ({
      name: "host_conflict",
      description: "host",
      inputSchema: { type: "object" },
    }),
    execute: async () => "host",
  });

  const activationScope = new PluginCapabilityActivationScope();
  assert.throws(
    () =>
      registerPluginCapabilityTools(
        registry,
        snapshot,
        capabilityRegistry,
        "/workspace",
        activationScope,
      ),
    /conflicts/u,
  );
  assert.equal(activations, 0);
  assert.equal(registry.getTool("plugin_first"), undefined);
  await activationScope.dispose();
});

test("TUI per-run tool pruning cannot overwrite the foreground non-MCP inventory", () => {
  const baseline = [
    { name: "read_file", readOnly: true },
    { name: "plugin_fixture", readOnly: true },
    { name: "mcp__old__echo", readOnly: false },
  ];
  const prunedRun = [
    { name: "read_file", readOnly: true },
    { name: "mcp__new__echo", readOnly: false },
  ];

  assert.deepEqual(mergeTuiToolSnapshot(baseline, prunedRun), [
    { name: "read_file", readOnly: true },
    { name: "plugin_fixture", readOnly: true },
    { name: "mcp__new__echo", readOnly: false },
  ]);
});

function activation<Value>(value: Value) {
  return { value, dispose: async () => undefined };
}
