import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBuiltinPluginCapabilityRegistry,
  defineTrustedPluginCapabilityFactory,
  PluginCapabilityActivationScope,
  PluginCapabilityRegistry,
} from "../../src/plugins/plugin-capability.js";
import type { PluginManagementService } from "../../src/plugins/plugin-management-service.js";
import {
  createPluginCommand,
  type PluginManagementCommandService,
} from "../../src/plugins/plugin-commands.js";
import { resolvePluginContributions } from "../../src/plugins/plugin-resolver.js";
import {
  loadPluginRuntimeSnapshot,
  type PluginRuntimeSnapshotOptions,
} from "../../src/plugins/plugin-runtime-snapshot.js";
import type {
  PluginContributionSet,
  PluginManifest,
  ResolvedPluginIdentity,
} from "../../src/plugins/plugin-types.js";

test("plugin capability manifest is declarative and rejects executable-shaped fields", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plugin-capability-manifest-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pico"), { recursive: true });
  await writeFile(
    join(root, ".pico", "plugin.json"),
    JSON.stringify({
      name: "fixture-capability",
      capabilities: [
        {
          id: "provider",
          version: "1",
          module: "./provider.mjs",
          config: { model: "fixture" },
        },
      ],
    }),
  );

  const resolved = await resolvePluginContributions(root);
  assert.equal(resolved.compatibility, "blocked");
  assert.ok(
    resolved.diagnostics.some((item) => item.code === "manifest_capability_fields_invalid"),
  );
  assert.equal(resolved.skills.length, 0);
});

test("capability registry only resolves trusted host factories and fails closed", () => {
  const empty = createBuiltinPluginCapabilityRegistry();
  assert.equal(empty.has("provider"), false);
  const unknown = empty.resolve({ id: "fixture-plugin" }, [
    { id: "provider", version: "1", config: { model: "fixture" } },
  ]);
  assert.deepEqual(unknown.capabilities, []);
  assert.equal(unknown.diagnostics[0]?.code, "plugin_capability_unknown");

  const registry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "provider",
      versions: ["1"],
      kind: "provider",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "provider",
        config: { ...declaration.config, hostOwned: true },
      }),
      activate: ({ provider }) => activation(provider),
    }),
  ]);
  const resolved = registry.resolve(
    { id: "fixture-plugin", version: "0.1.0" },
    [{ id: "provider", version: "1", config: { model: "fixture" } }],
    { resourceDigest: "digest" },
  );
  assert.deepEqual(resolved.diagnostics, []);
  assert.deepEqual(resolved.capabilities[0], {
    id: "provider",
    version: "1",
    kind: "provider",
    config: { model: "fixture", hostOwned: true },
    pluginId: "fixture-plugin",
    pluginVersion: "0.1.0",
    resourceDigest: "digest",
  });
  assert.equal(Object.isFrozen(resolved.capabilities[0]?.config), true);
});

test("runtime snapshot is the capability factory connection point", async () => {
  const identity: ResolvedPluginIdentity = {
    id: "fixture-plugin",
    name: "fixture-plugin",
    displayName: "fixture-plugin",
    root: "/tmp/fixture-plugin",
    manifestPath: "/tmp/fixture-plugin/.pico/plugin.json",
    manifestSource: "pico-native",
  };
  const manifest: PluginManifest = {
    name: "fixture-plugin",
    capabilities: [{ id: "provider", version: "1", config: { model: "fixture" } }],
  };
  const contributions: PluginContributionSet = {
    plugin: identity,
    manifest,
    compatibility: "compatible",
    diagnostics: [],
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcpServers: [],
    lspServers: [],
  };
  const installed = {
    id: identity.id,
    scope: "local" as const,
    manifest,
    installPath: identity.root,
    enabled: true,
    manifestSource: "pico-native" as const,
    compatibility: "compatible" as const,
    diagnostics: [],
    resourceFingerprint: {
      algorithm: "sha256" as const,
      digest: "digest",
      fileCount: 1,
      totalBytes: 1,
    },
  };
  let disposed = 0;
  const service = {
    materializeRuntimePlugins: async () => ({
      plugins: [{ installed, contributions }],
      diagnostics: [],
      dispose: async () => {
        disposed++;
      },
    }),
  } as unknown as PluginManagementService;

  const options: PluginRuntimeSnapshotOptions = {
    workDir: "/tmp/workspace",
    service,
  };
  const blocked = await loadPluginRuntimeSnapshot(options);
  assert.deepEqual(blocked.capabilities, []);
  assert.ok(blocked.diagnostics.some((item) => item.code === "plugin_capability_unknown"));
  await blocked.dispose();

  const trustedRegistry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "provider",
      versions: ["1"],
      kind: "provider",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "provider",
        config: declaration.config ?? {},
      }),
      activate: ({ provider }) => activation(provider),
    }),
  ]);
  const accepted = await loadPluginRuntimeSnapshot({
    ...options,
    capabilityRegistry: trustedRegistry,
  });
  assert.equal(accepted.capabilities.length, 1);
  assert.equal(accepted.capabilities[0]?.kind, "provider");
  assert.deepEqual(accepted.diagnostics, []);
  const inspectCommand = createPluginCommand({
    workDir: "/tmp/workspace",
    service: {
      inspect: async () => ({
        installed,
        contributions,
        trust: "active",
        changedSinceInstall: false,
        active: true,
      }),
    } as unknown as PluginManagementCommandService,
    runtimeDiagnostics: [
      {
        pluginId: installed.id,
        sourcePath: installed.installPath,
        code: "plugin_capability_unknown",
        message: "fixture runtime diagnostic",
        scope: "local",
      },
      {
        pluginId: installed.id,
        sourcePath: "/tmp/project-copy",
        code: "plugin_capability_factory_failed",
        message: "wrong scope diagnostic",
        scope: "project",
      },
    ],
    runtimeCapabilities: [
      ...accepted.capabilities,
      { ...accepted.capabilities[0]!, pluginScope: "project" },
    ],
  });
  const inspection = await inspectCommand.execute(
    {
      raw: "/plugin inspect fixture-plugin --scope local",
      name: "plugin",
      args: "inspect fixture-plugin --scope local",
      argv: ["inspect", "fixture-plugin", "--scope", "local"],
    },
    {},
  );
  assert.equal(inspection.type, "local");
  assert.match(
    inspection.type === "local" ? (inspection.message ?? "") : "",
    /plugin_capability_unknown/u,
  );
  assert.match(
    inspection.type === "local" ? (inspection.message ?? "") : "",
    /Active capabilities: 1\. provider:provider@1/u,
  );
  assert.doesNotMatch(
    inspection.type === "local" ? (inspection.message ?? "") : "",
    /wrong scope diagnostic/u,
  );
  await accepted.dispose();
  assert.equal(disposed, 2);
});

test("trusted capability registry activates provider decorators and concrete tools", async () => {
  const activationOrder: string[] = [];
  const baseProvider = {
    async generate() {
      return { role: "assistant" as const, content: "base" };
    },
  };
  const registry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "provider-observer",
      versions: ["1"],
      kind: "provider",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "provider",
        config: declaration.config ?? {},
      }),
      activate: ({ descriptor, provider }) =>
        activation({
          async generate(messages, tools, options) {
            activationOrder.push(String(descriptor.config.label));
            return provider.generate(messages, tools, options);
          },
        }),
    }),
    defineTrustedPluginCapabilityFactory({
      id: "fixture-tool",
      versions: ["1"],
      kind: "tool",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "tool",
        config: declaration.config ?? {},
      }),
      toolNames: () => ["fixture_echo"],
      activate: ({ descriptor, workDir }) =>
        activation([
          {
            name: () => "fixture_echo",
            definition: () => ({
              name: "fixture_echo",
              description: "host-owned fixture tool",
              inputSchema: { type: "object" },
            }),
            execute: async () => `${workDir}:${String(descriptor.config.value)}`,
            readOnly: true,
          },
        ]),
    }),
  ]);
  const resolved = registry.resolve({ id: "fixture-plugin", version: "1.0.0" }, [
    { id: "provider-observer", version: "1", config: { label: "observed" } },
    { id: "fixture-tool", version: "1", config: { value: "ready" } },
  ]);
  assert.deepEqual(resolved.diagnostics, []);

  const scope = new PluginCapabilityActivationScope();
  const provider = registry.activateProvider(resolved.capabilities, baseProvider, scope);
  assert.equal((await provider.generate([], [])).content, "base");
  assert.deepEqual(activationOrder, ["observed"]);
  const invalidScope = new PluginCapabilityActivationScope();
  assert.throws(
    () =>
      registry.activateProvider(
        resolved.capabilities,
        {
          ...baseProvider,
          async generateStream() {
            return baseProvider.generate();
          },
        },
        invalidScope,
      ),
    /removed generateStream/u,
  );
  await invalidScope.dispose();

  const [tool] = registry.activateTools(resolved.capabilities, { workDir: "/workspace" }, scope);
  assert.equal(tool?.name(), "fixture_echo");
  assert.equal(await tool?.execute("{}"), "/workspace:ready");
  assert.deepEqual(registry.toolNames(resolved.capabilities), ["fixture_echo"]);
  await scope.dispose();
});

test("tool metadata lookup does not activate Plugin tools", () => {
  let activations = 0;
  const registry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "metadata-only-tool",
      versions: ["1"],
      kind: "tool",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "tool",
        config: {},
      }),
      toolNames: () => ["metadata_only"],
      activate: () => {
        activations++;
        return activation([
          {
            name: () => "metadata_only",
            definition: () => ({
              name: "metadata_only",
              description: "metadata-only fixture",
              inputSchema: { type: "object" },
            }),
            execute: async () => "ok",
          },
        ]);
      },
    }),
  ]);
  const resolution = registry.resolve({ id: "fixture-plugin" }, [
    { id: "metadata-only-tool", version: "1", config: {} },
  ]);

  assert.deepEqual(registry.toolNames(resolution.capabilities), ["metadata_only"]);
  assert.equal(activations, 0);
});

test("Plugin activation scope releases earlier capabilities after a later activation fails", async () => {
  const disposed: string[] = [];
  const registry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "leased-provider",
      versions: ["1"],
      kind: "provider",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "provider",
        config: {},
      }),
      activate: ({ provider }) => ({
        value: provider,
        dispose: async () => void disposed.push("leased-provider"),
      }),
    }),
    defineTrustedPluginCapabilityFactory({
      id: "failing-provider",
      versions: ["1"],
      kind: "provider",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "provider",
        config: {},
      }),
      activate: () => {
        throw new Error("fixture activation failure");
      },
    }),
  ]);
  const resolved = registry.resolve({ id: "fixture-plugin" }, [
    { id: "leased-provider", version: "1", config: {} },
    { id: "failing-provider", version: "1", config: {} },
  ]);
  const scope = new PluginCapabilityActivationScope();

  assert.throws(
    () =>
      registry.activateProvider(
        resolved.capabilities,
        {
          async generate() {
            return { role: "assistant", content: "base" };
          },
        },
        scope,
      ),
    /fixture activation failure/u,
  );
  await scope.dispose();
  await scope.dispose();
  assert.deepEqual(disposed, ["leased-provider"]);
});

test("disposed Plugin activation scope rejects before allocating another capability", async () => {
  let activations = 0;
  const registry = new PluginCapabilityRegistry([
    defineTrustedPluginCapabilityFactory({
      id: "scoped-provider",
      versions: ["1"],
      kind: "provider",
      resolve: ({ declaration }) => ({
        id: declaration.id,
        version: declaration.version,
        kind: "provider",
        config: {},
      }),
      activate: ({ provider }) => {
        activations++;
        return activation(provider);
      },
    }),
  ]);
  const resolved = registry.resolve({ id: "fixture-plugin" }, [
    { id: "scoped-provider", version: "1", config: {} },
  ]);
  const scope = new PluginCapabilityActivationScope();
  await scope.dispose();

  assert.throws(
    () =>
      registry.activateProvider(
        resolved.capabilities,
        {
          async generate() {
            return { role: "assistant", content: "base" };
          },
        },
        scope,
      ),
    /already disposing/u,
  );
  assert.equal(activations, 0);
});

test("Plugin activation scope fences reentrant dispose and registration before cleanup", async () => {
  const scope = new PluginCapabilityActivationScope();
  let disposals = 0;
  let reentrantDispose: Promise<void> | undefined;
  scope.register("first", {
    value: undefined,
    dispose: () => {
      disposals++;
      reentrantDispose = scope.dispose();
      assert.throws(() => scope.register("late", activation(undefined)), /already disposing/u);
    },
  });

  const initialDispose = scope.dispose();
  await initialDispose;
  await reentrantDispose;
  assert.equal(disposals, 1);
  assert.equal(reentrantDispose, initialDispose);
});

test("capability descriptors can only be activated by the registry that issued them", () => {
  const createRegistry = (label: string) =>
    new PluginCapabilityRegistry([
      defineTrustedPluginCapabilityFactory({
        id: "provider-owner",
        versions: ["1"],
        kind: "provider",
        resolve: ({ declaration }) => ({
          id: declaration.id,
          version: declaration.version,
          kind: "provider",
          config: { label },
        }),
        activate: ({ descriptor, provider }) =>
          activation({
            async generate(messages, tools, options) {
              const result = await provider.generate(messages, tools, options);
              return { ...result, content: `${String(descriptor.config.label)}:${result.content}` };
            },
          }),
      }),
    ]);
  const first = createRegistry("first");
  const second = createRegistry("second");
  const resolved = first.resolve({ id: "fixture-plugin" }, [
    { id: "provider-owner", version: "1", config: {} },
  ]);
  const baseProvider = {
    async generate() {
      return { role: "assistant" as const, content: "base" };
    },
  };

  assert.throws(
    () =>
      second.activateProvider(
        resolved.capabilities,
        baseProvider,
        new PluginCapabilityActivationScope(),
      ),
    /was not issued by this registry/u,
  );
});

function activation<Value>(value: Value) {
  return { value, dispose: async () => undefined };
}
