import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defineTrustedPluginCapabilityFactory,
  PluginCapabilityActivationScope,
  PluginCapabilityRegistry,
} from "../../src/plugins/plugin-capability.js";
import type { PluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";
import { registerPluginCapabilityTools } from "../../src/plugins/plugin-tool-activation.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

// 注：原 5 个 in-process TUI 生命周期用例（runTuiAgentPrompt 依赖转发 /
// startTuiRepl 快照释放 / storage 与 endpoint 预检 / mergeTuiToolSnapshot）随
// in-process TUI 路径退役删除（Phase 5，2026-08-16）。保留的用例只测 plugins
// 模块自身的工具投影语义，与宿主形态无关。

function pluginToolSnapshotFixture(input: {
  toolNames: () => string[];
  defs: { name: string; description: string }[];
  onActivate?: () => void;
}) {
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
      toolNames: input.toolNames,
      activate: () => {
        input.onActivate?.();
        return activation(
          input.defs.map((def) => ({
            name: () => def.name,
            definition: () => ({
              name: def.name,
              description: def.description,
              inputSchema: { type: "object" },
            }),
            execute: async () => "ok",
          })),
        );
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
  return { capabilityRegistry, snapshot };
}

test("startup registry can project Plugin tools before the first run", async () => {
  const { capabilityRegistry, snapshot } = pluginToolSnapshotFixture({
    toolNames: () => ["plugin_fixture"],
    defs: [{ name: "plugin_fixture", description: "fixture" }],
  });
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

test("Plugin tool projection checks host conflicts before activation", async () => {
  let activations = 0;
  const { capabilityRegistry, snapshot } = pluginToolSnapshotFixture({
    toolNames: () => ["plugin_first", "host_conflict"],
    defs: [
      { name: "plugin_first", description: "first" },
      { name: "host_conflict", description: "conflict" },
    ],
    onActivate: () => {
      activations += 1;
    },
  });
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

function activation<Value>(value: Value) {
  return { value, dispose: async () => undefined };
}
