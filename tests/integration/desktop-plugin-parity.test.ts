import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { PluginRuntimeSnapshotRegistry } from "../../src/plugins/plugin-runtime-snapshot-registry.js";
import type { PluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";
import { PluginCapabilityRegistry } from "../../src/plugins/plugin-capability.js";
import { createProductionLocalDaemonHost } from "../../src/daemon/production-host.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import {
  createTrustedDesktopAutomation,
  type DesktopAutomationAuthorityDependencies,
  type DesktopAutomationService,
} from "../../src/daemon/desktop-automation-service.js";

test("Desktop catalog and session activation share one Plugin snapshot", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-plugin-parity-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const skillRoot = join(root, "plugin-skills");
  const agentFile = join(root, "plugin-agents.yaml");
  const mcpMarker = join(root, "mcp-connected");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(join(skillRoot, "plugin-skill"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeFile(
    join(skillRoot, "plugin-skill", "SKILL.md"),
    [
      "---",
      "name: plugin-skill",
      "description: Skill contributed by a plugin",
      "---",
      "Follow the plugin skill instructions.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    agentFile,
    [
      "agents:",
      "  - name: plugin-agent",
      "    description: Agent contributed by a plugin",
      "    systemPrompt: Follow the plugin agent instructions.",
      "    tools: [read_file]",
      "",
    ].join("\n"),
    "utf8",
  );
  const canonicalWorkspace = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonicalWorkspace);

  let loadCount = 0;
  let disposeCount = 0;
  const snapshot: PluginRuntimeSnapshot = {
    pluginIds: ["fixture-plugin"],
    skillSources: [
      {
        id: "fixture-plugin:skill",
        scope: "external",
        format: "pico-native",
        root: skillRoot,
        priority: 60,
      },
    ],
    commandSources: [],
    agentSources: [
      {
        id: "fixture-plugin:agent",
        scope: "external",
        format: "external",
        root: agentFile,
        priority: 60,
        adapter: "pico-agent-yaml",
      },
    ],
    hookSources: [],
    mcpSources: [
      {
        id: "fixture-plugin:mcp",
        config: {
          mcpServers: {
            "fixture-plugin__server": {
              name: "fixture-plugin__server",
              transport: "stdio",
              command: process.execPath,
              args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)}, '1')`],
            },
          },
        },
      },
    ],
    lspServers: [],
    capabilities: [],
    diagnostics: [
      {
        pluginId: "fixture-plugin",
        sourcePath: join(root, "plugin-mcp.json"),
        message: "fixture diagnostic",
      },
    ],
    dispose: async () => {
      disposeCount++;
    },
  };
  const registry = new PluginRuntimeSnapshotRegistry({
    env,
    picoHome,
    loadSnapshot: async (workDir) => {
      assert.equal(workDir, canonicalWorkspace);
      loadCount++;
      return snapshot;
    },
  });

  const prompts: string[] = [];
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ prompt }) => {
      prompts.push(prompt);
      return { ok: true };
    },
  });
  const sessionIds = ["plugin-skill-session", "plugin-agent-session"];
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    pluginRuntimeSnapshotRegistry: registry,
    ownsPluginRuntimeSnapshotRegistry: true,
    createSessionId: () => sessionIds.shift() ?? "fallback-session",
  });
  context.after(async () => {
    await desktop.close();
    for (const sessionId of ["plugin-skill-session", "plugin-agent-session"]) {
      const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
      await session?.close();
    }
    await rm(root, { recursive: true, force: true });
  });

  const diagnostics = asRecord(
    await desktop.handle(
      createRuntimeRequest("diagnostics.resources", { workspacePath: workspace }),
    ),
  );
  assert.match(String(diagnostics["output"]), /fixture diagnostic/u);
  assert.equal(asArray(diagnostics["pluginDiagnostics"]).length, 1);

  const skills = asRecord(
    await desktop.handle(createRuntimeRequest("catalog.skills", { workspacePath: workspace })),
  );
  assert.ok(asArray(skills["skills"]).some((item) => asRecord(item)["name"] === "plugin-skill"));
  const agents = asRecord(
    await desktop.handle(createRuntimeRequest("catalog.agents", { workspacePath: workspace })),
  );
  assert.ok(asArray(agents["agents"]).some((item) => asRecord(item)["name"] === "plugin-agent"));
  const mcpServers = asRecord(
    await desktop.handle(createRuntimeRequest("config.mcpServers", { workspacePath: workspace })),
  );
  assert.ok(
    asArray(mcpServers["servers"]).some(
      (item) =>
        asRecord(item)["name"] === "fixture-plugin__server" &&
        asRecord(item)["sourceId"] === "fixture-plugin:mcp",
    ),
  );
  assert.equal(
    asRecord(
      asArray(mcpServers["servers"]).find(
        (item) => asRecord(item)["name"] === "fixture-plugin__server",
      ),
    )["status"],
    "pending",
  );
  await assert.rejects(access(mcpMarker));

  const skillSend = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath: workspace,
        input: { kind: "skill", name: "plugin-skill", args: "--from-plugin" },
        idempotencyKey: "plugin-skill-send",
      }),
    ),
  );
  assert.equal(asRecord(skillSend["session"])["sessionId"], "plugin-skill-session");

  const agentSend = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath: workspace,
        input: { kind: "agent", name: "plugin-agent", task: "Inspect plugin" },
        idempotencyKey: "plugin-agent-send",
      }),
    ),
  );
  assert.equal(asRecord(agentSend["session"])["sessionId"], "plugin-agent-session");
  assert.equal(loadCount, 1, "catalog and both activation requests must reuse one snapshot");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /Follow the plugin skill instructions/u);
  assert.match(prompts[1]!, /plugin-agent/u);

  await desktop.close();
  assert.equal(disposeCount, 1, "Desktop service owns and disposes the shared snapshot once");
});

test("Production host rejects different Plugin resolution and activation registries", () => {
  const snapshotCapabilities = new PluginCapabilityRegistry();
  const activationCapabilities = new PluginCapabilityRegistry();
  const snapshots = new PluginRuntimeSnapshotRegistry({
    capabilityRegistry: snapshotCapabilities,
  });
  assert.throws(
    () =>
      createProductionLocalDaemonHost({
        pluginRuntimeSnapshotRegistry: snapshots,
        pluginCapabilityRegistry: activationCapabilities,
      }),
    /must share the exact capability registry/u,
  );
});

test("Plugin snapshot registry reports disposal failures after attempting every snapshot", async () => {
  const disposed: string[] = [];
  const registry = new PluginRuntimeSnapshotRegistry({
    loadSnapshot: async (workDir) => ({
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
        disposed.push(workDir);
        if (workDir.endsWith("failing")) throw new Error("dispose boom");
      },
    }),
  });
  await Promise.all([registry.get("/workspace/failing"), registry.get("/workspace/succeeding")]);

  await assert.rejects(
    registry.dispose(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some((failure) => String(failure).includes("dispose boom")),
  );
  assert.deepEqual(disposed.sort(), ["/workspace/failing", "/workspace/succeeding"]);
  assert.throws(() => registry.get("/workspace/later"), /disposed/u);
});

test("Desktop rejects foreground-only Plugin tools before persisting an Automation", async () => {
  await assert.rejects(
    createTrustedDesktopAutomation(
      {} as DesktopAutomationService,
      "/workspace",
      {
        prompt: "run plugin",
        schedule: "* * * * *",
        modelRouteId: "provider/model",
        expectedCredentialRef: "provider:fixture",
        allowedTools: ["plugin_fixture"],
        toolNetworkPolicy: "disabled",
      },
      {
        foregroundOnlyTools: new Set(["plugin_fixture"]),
      } as unknown as DesktopAutomationAuthorityDependencies,
    ),
    /does not support foreground Plugin tools|Automation 不支持前台 Plugin 工具/u,
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected object");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected array");
  return value;
}
