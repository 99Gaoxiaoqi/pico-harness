import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { RuntimeProtocolError, RUNTIME_ERROR_CODES } from "../../src/daemon/protocol.js";
import { UserMcpConfigStore } from "../../src/mcp/user-config-store.js";
import { PluginRuntimeSnapshotRegistry } from "../../src/plugins/plugin-runtime-snapshot-registry.js";
import type { PluginRuntimeSnapshot } from "../../src/plugins/plugin-runtime-snapshot.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { WorkspaceRegistrationStore } from "../../src/daemon/workspace-registration.js";

test("Desktop scoped MCP management is global, CAS-safe, trust-gated and secret-free", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-capability-service-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const userMcpConfigStore = new UserMcpConfigStore({ picoHome });
  let pluginLoads = 0;
  const pluginSnapshot: PluginRuntimeSnapshot = {
    pluginIds: ["fixture-plugin"],
    skillSources: [],
    commandSources: [],
    agentSources: [],
    hookSources: [],
    mcpSources: [
      {
        id: "plugin:fixture-plugin:mcp",
        config: {
          mcpServers: {
            shared: {
              name: "shared",
              transport: "stdio",
              command: "shadowed-plugin-server",
            },
            "fixture-plugin__remote": {
              name: "fixture-plugin__remote",
              transport: "http",
              url: "https://plugin-user:PLUGIN_PASSWORD@example.test/plugin/PLUGIN_PATH_SECRET?token=PLUGIN_TOKEN#secret",
              headers: { Authorization: "Bearer PLUGIN_HEADER_SECRET" },
            },
            "fixture-plugin__invalid": {
              name: "fixture-plugin__invalid",
              transport: "http",
              url: "ftp://example.test/INVALID_PATH_SECRET",
            },
          },
        },
      },
    ],
    lspServers: [],
    capabilities: [],
    diagnostics: [],
    dispose: async () => undefined,
  };
  const pluginRuntimeSnapshotRegistry = new PluginRuntimeSnapshotRegistry({
    env,
    picoHome,
    loadSnapshot: async () => {
      pluginLoads++;
      return pluginSnapshot;
    },
  });
  const runtime = new WorkspaceRuntimeService({
    env,
    registrationStore,
    execute: async () => ({ ok: true }),
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env,
    trustStore,
    registrationStore,
    userMcpConfigStore,
    pluginRuntimeSnapshotRegistry,
    ownsPluginRuntimeSnapshotRegistry: true,
  });
  await registrationStore.register(workspace);
  let mcpConfigNotifications = 0;
  const unsubscribe = desktop.subscribe((notification) => {
    if (
      notification.topic === "config.updated" &&
      JSON.stringify(notification.payload).includes('"mcp"')
    ) {
      mcpConfigNotifications++;
    }
  });
  context.after(async () => {
    unsubscribe();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });

  const initial = asRecord(await desktop.handle(createRuntimeRequest("mcp.user.list", {})));
  const initialRevision = requiredString(initial["revision"]);
  assert.deepEqual(initial["servers"], []);
  assert.equal(pluginLoads, 0, "user scope must not materialize plugins");

  await assert.rejects(
    desktop.handle(createRuntimeRequest("mcp.effective.list", { workspacePath: workspace })),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.FORBIDDEN,
  );
  assert.equal(pluginLoads, 0, "untrusted lookup must fail before plugin resolution");

  const userServerInput = {
    name: "shared",
    transport: "stdio" as const,
    command: "/private/tools/node --token=COMMAND_SECRET",
    args: ["--token=ARG_SECRET"],
    env: { API_TOKEN: "ENV_SECRET" },
  };
  const upsertRequest = createRuntimeRequest("mcp.user.upsert", {
    server: userServerInput,
    expectedRevision: initialRevision,
    idempotencyKey: "mcp-upsert-shared",
  });
  const created = asRecord(await desktop.handle(upsertRequest));
  const createdText = JSON.stringify(created);
  assert.doesNotMatch(createdText, /ARG_SECRET|ENV_SECRET|COMMAND_SECRET|\/private\/tools/u);
  const createdServer = asRecord(created["server"]);
  assert.equal(createdServer["commandLabel"], "configured-command");
  assert.equal(createdServer["hasArguments"], true);
  assert.deepEqual(createdServer["envKeys"], ["API_TOKEN"]);
  const createdRevision = requiredString(created["revision"]);
  assert.notEqual(createdRevision, (await userMcpConfigStore.read()).revision);

  const replay = asRecord(await desktop.handle(upsertRequest));
  assert.equal(replay["revision"], createdRevision, "same idempotency key must replay safely");
  const deleted = asRecord(
    await desktop.handle(
      createRuntimeRequest("mcp.user.delete", {
        serverName: "shared",
        expectedRevision: createdRevision,
        idempotencyKey: "intervening-delete",
      }),
    ),
  );
  const afterDelete = asRecord(await desktop.handle(createRuntimeRequest("mcp.user.list", {})));
  assert.deepEqual(afterDelete["servers"], []);
  const replayAfterDelete = asRecord(await desktop.handle(upsertRequest));
  assert.equal(replayAfterDelete["revision"], createdRevision);
  assert.equal(asRecord(replayAfterDelete["server"])["name"], "shared");
  assert.deepEqual(
    asRecord(await desktop.handle(createRuntimeRequest("mcp.user.list", {})))["servers"],
    [],
    "replay must not undo a later delete",
  );
  const restored = asRecord(
    await desktop.handle(
      createRuntimeRequest("mcp.user.upsert", {
        server: userServerInput,
        expectedRevision: requiredString(afterDelete["revision"]),
        idempotencyKey: "restore-shared",
      }),
    ),
  );
  assert.notEqual(restored["revision"], deleted["revision"]);
  assert.equal(mcpConfigNotifications, 3, "idempotent replays must not republish config updates");
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("mcp.user.delete", {
        serverName: "shared",
        expectedRevision: initialRevision,
        idempotencyKey: "stale-delete",
      }),
    ),
    (error: unknown) =>
      error instanceof RuntimeProtocolError &&
      error.code === RUNTIME_ERROR_CODES.CONFLICT &&
      !/ENV_SECRET|ARG_SECRET/u.test(error.message),
  );

  await writeFile(
    join(workspace, ".pico", "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          shared: {
            transport: "http",
            url: "https://project-user:PROJECT_PASSWORD@example.test/project/PROJECT_PATH_SECRET?token=PROJECT_TOKEN#secret",
            headers: { Authorization: "Bearer PROJECT_HEADER_SECRET" },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await trustStore.trust(canonical);
  const effective = asRecord(
    await desktop.handle(createRuntimeRequest("mcp.effective.list", { workspacePath: workspace })),
  );
  const effectiveText = JSON.stringify(effective);
  assert.doesNotMatch(
    effectiveText,
    /PROJECT_PASSWORD|PROJECT_TOKEN|PROJECT_PATH_SECRET|PROJECT_HEADER_SECRET|PLUGIN_PASSWORD|PLUGIN_TOKEN|PLUGIN_PATH_SECRET|PLUGIN_HEADER_SECRET|INVALID_PATH_SECRET/u,
  );
  assert.doesNotMatch(effectiveText, /plugin-user|project-user/u);
  assert.equal(pluginLoads, 1);
  const servers = asArray(effective["servers"]).map(asRecord);
  assert.ok(
    servers.some(
      (server) =>
        server["name"] === "shared" &&
        asRecord(server["source"])["scope"] === "user" &&
        asRecord(server["source"])["effective"] === false,
    ),
  );
  assert.ok(
    servers.some(
      (server) =>
        server["name"] === "fixture-plugin__invalid" &&
        server["endpointLabel"] === "https://invalid.invalid",
    ),
  );
  assert.ok(
    servers.some(
      (server) =>
        server["name"] === "shared" &&
        asRecord(server["source"])["scope"] === "plugin" &&
        asRecord(server["source"])["effective"] === false &&
        asRecord(server["source"])["shadowedBy"] === "project",
    ),
  );
  assert.ok(
    servers.some(
      (server) =>
        server["name"] === "shared" &&
        server["endpointLabel"] === "https://example.test" &&
        asRecord(server["source"])["scope"] === "project",
    ),
  );
  assert.ok(
    servers.some(
      (server) =>
        server["name"] === "fixture-plugin__remote" &&
        server["endpointLabel"] === "https://example.test" &&
        asRecord(server["source"])["scope"] === "plugin",
    ),
  );

  await desktop.handle(
    createRuntimeRequest("workspace.trust", { workspacePath: workspace, trusted: false }),
  );
  await trustStore.trust(canonical);
  await desktop.handle(createRuntimeRequest("mcp.effective.list", { workspacePath: workspace }));
  assert.equal(pluginLoads, 2, "revoking trust must invalidate the active plugin generation");

  await desktop.handle(createRuntimeRequest("workspace.unregister", { workspacePath: workspace }));
  await desktop.handle(createRuntimeRequest("mcp.effective.list", { workspacePath: workspace }));
  assert.equal(pluginLoads, 3, "unregistering a workspace must invalidate its plugin generation");
});

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected string");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
