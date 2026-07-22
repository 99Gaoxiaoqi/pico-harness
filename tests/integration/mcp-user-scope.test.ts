import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  McpWorkspaceNotTrustedError,
  resolveTrustedEffectiveMcpSources,
  userMcpDefinitions,
} from "../../src/mcp/effective-config.js";
import {
  EMPTY_USER_MCP_REVISION,
  UserMcpConfigStore,
  UserMcpIdempotencyConflictError,
  UserMcpRevisionConflictError,
} from "../../src/mcp/user-config-store.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
} from "../../src/safety/background-yolo-policy.js";

test("user MCP store enforces private permissions, CAS and durable idempotency", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-mcp-store-"));
  const picoHome = join(root, "pico-home");
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMcpConfigStore({ picoHome });

  const initial = await store.read();
  assert.equal(initial.revision, EMPTY_USER_MCP_REVISION);
  const configured = await store.upsert(
    { name: "docs", transport: "stdio", command: "node", args: ["server.js"] },
    { expectedRevision: initial.revision, idempotencyKey: "add-docs" },
  );
  assert.equal(configured.config.mcpServers.docs?.command, "node");
  assert.equal((await stat(picoHome)).mode & 0o777, 0o700);
  assert.equal((await stat(join(picoHome, "mcp.json"))).mode & 0o777, 0o600);

  const replayedAfterRestart = await new UserMcpConfigStore({ picoHome }).upsert(
    { name: "docs", transport: "stdio", command: "node", args: ["server.js"] },
    { expectedRevision: initial.revision, idempotencyKey: "add-docs" },
  );
  assert.equal(replayedAfterRestart.revision, configured.revision);
  await assert.rejects(
    store.upsert(
      { name: "other", transport: "stdio", command: "node" },
      { expectedRevision: configured.revision, idempotencyKey: "add-docs" },
    ),
    UserMcpIdempotencyConflictError,
  );
  await assert.rejects(
    store.delete("docs", { expectedRevision: initial.revision, idempotencyKey: "delete-stale" }),
    UserMcpRevisionConflictError,
  );

  const deleted = await store.delete("docs", {
    expectedRevision: configured.revision,
    idempotencyKey: "delete-docs",
  });
  assert.deepEqual(deleted.config.mcpServers, {});
});

test("MCP catalogs never spawn servers and untrusted effective lookup never reads project config", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-mcp-no-spawn-"));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  const marker = join(root, "spawned");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserMcpConfigStore({ picoHome });
  const configured = await store.upsert(
    {
      name: "dangerous",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
    },
    { expectedRevision: EMPTY_USER_MCP_REVISION, idempotencyKey: "dangerous" },
  );
  assert.equal(userMcpDefinitions(configured).length, 1);
  await assert.rejects(access(marker));

  await writeFile(join(workspace, ".pico", "mcp.json"), "{ definitely-invalid-json", "utf8");
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await assert.rejects(
    resolveTrustedEffectiveMcpSources(workspace, { picoHome, trustStore, userStore: store }),
    McpWorkspaceNotTrustedError,
  );
  await assert.rejects(access(marker));
});

test("concurrent user MCP writers serialize and only one stale revision commits", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-user-mcp-concurrency-"));
  const picoHome = join(root, "pico-home");
  context.after(() => rm(root, { recursive: true, force: true }));
  const left = new UserMcpConfigStore({ picoHome });
  const right = new UserMcpConfigStore({ picoHome });
  const revision = (await left.read()).revision;
  const writes = await Promise.allSettled([
    left.upsert(
      { name: "left", transport: "stdio", command: "left" },
      { expectedRevision: revision, idempotencyKey: "left" },
    ),
    right.upsert(
      { name: "right", transport: "stdio", command: "right" },
      { expectedRevision: revision, idempotencyKey: "right" },
    ),
  ]);
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = writes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof UserMcpRevisionConflictError);
  assert.equal(Object.keys((await left.read()).config.mcpServers).length, 1);
});

test("trusted effective MCP applies whole project overrides and isolates workspaces", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-effective-mcp-"));
  const picoHome = join(root, "pico-home");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  await Promise.all([
    mkdir(join(workspaceA, ".pico"), { recursive: true }),
    mkdir(join(workspaceB, ".pico"), { recursive: true }),
  ]);
  context.after(() => rm(root, { recursive: true, force: true }));

  const userStore = new UserMcpConfigStore({ picoHome });
  const first = await userStore.upsert(
    { name: "shared", transport: "http", url: "https://user.invalid/mcp" },
    { expectedRevision: EMPTY_USER_MCP_REVISION, idempotencyKey: "user-shared" },
  );
  await userStore.upsert(
    { name: "user-only", transport: "http", url: "https://user-only.invalid/mcp" },
    { expectedRevision: first.revision, idempotencyKey: "user-only" },
  );
  await writeProjectConfig(workspaceA, {
    shared: { name: "shared", transport: "http", url: "https://project-a.invalid/mcp" },
    "a-only": { name: "a-only", transport: "http", url: "https://a.invalid/mcp" },
  });
  await writeProjectConfig(workspaceB, {
    "b-only": { name: "b-only", transport: "http", url: "https://b.invalid/mcp" },
  });
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(await trustStore.canonicalize(workspaceA));
  await trustStore.trust(await trustStore.canonicalize(workspaceB));

  const [effectiveA, effectiveB] = await Promise.all([
    resolveTrustedEffectiveMcpSources(workspaceA, { picoHome, trustStore, userStore }),
    resolveTrustedEffectiveMcpSources(workspaceB, { picoHome, trustStore, userStore }),
  ]);
  const sourceA = Object.fromEntries(
    effectiveA.sources.flatMap((source) =>
      Object.entries(source.config?.mcpServers ?? {}).map(([name, config]) => [name, config]),
    ),
  );
  assert.equal(sourceA.shared?.url, "https://project-a.invalid/mcp");
  assert.equal(sourceA["user-only"]?.url, "https://user-only.invalid/mcp");
  assert.equal(sourceA["a-only"]?.url, "https://a.invalid/mcp");
  assert.equal(sourceA["b-only"], undefined);
  assert.equal(
    effectiveA.definitions.find((item) => item.name === "shared" && item.scope === "user")
      ?.shadowedBy,
    "project",
  );
  assert.ok(effectiveB.definitions.some((item) => item.name === "b-only"));
  assert.ok(!effectiveB.definitions.some((item) => item.name === "a-only"));
});

test("background runs reject injected user MCP sources before model or tool execution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-background-user-mcp-"));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const canonical = await trustStore.canonicalize(workspace);
  await trustStore.trust(canonical);

  await assert.rejects(
    executeAgentRuntime(
      {
        prompt: "must not run",
        dir: workspace,
        provider: "openai",
        execution: {
          kind: "background",
          policy: {
            mode: "yolo",
            backgroundEnabled: true,
            trustedWorkspace: true,
            toolNetworkPolicy: "disabled",
            allowedTools: [],
            hardlineVersion: BACKGROUND_HARDLINE_VERSION,
            hookVersion: BACKGROUND_HOOK_VERSION,
            createdAt: Date.now(),
          },
        },
      },
      {
        picoHome,
        backgroundTrustStore: trustStore,
        mcpConfigSources: [
          {
            id: "user",
            config: {
              mcpServers: {
                forbidden: { name: "forbidden", transport: "stdio", command: "never-run" },
              },
            },
          },
        ],
      },
    ),
    /\u540e\u53f0\u6267\u884c\u4e0d\u5f97\u590d\u7528\u524d\u53f0 MCP/u,
  );
});

async function writeProjectConfig(
  workspace: string,
  mcpServers: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(workspace, ".pico", "mcp.json"),
    `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    "utf8",
  );
  assert.match(await readFile(join(workspace, ".pico", "mcp.json"), "utf8"), /mcpServers/u);
}
