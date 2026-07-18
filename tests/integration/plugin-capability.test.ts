import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createBuiltinPluginCapabilityRegistry,
  defineTrustedPluginCapabilityFactory,
  PluginCapabilityRegistry,
} from "../../src/plugins/plugin-capability.js";
import type { PluginManagementService } from "../../src/plugins/plugin-management-service.js";
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
    }),
  ]);
  const accepted = await loadPluginRuntimeSnapshot({
    ...options,
    capabilityRegistry: trustedRegistry,
  });
  assert.equal(accepted.capabilities.length, 1);
  assert.equal(accepted.capabilities[0]?.kind, "provider");
  assert.deepEqual(accepted.diagnostics, []);
  await accepted.dispose();
  assert.equal(disposed, 2);
});
