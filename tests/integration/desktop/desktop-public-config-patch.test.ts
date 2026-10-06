import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createRuntimeRequest,
  publicProviderEndpoint,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonObject,
} from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import { UserMcpConfigStore } from "@pico/pico-host/user-mcp-config-store";

test("Host MCP public patches keep secrets atomically, replay the original patch before CAS, and expose only public results", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-public-mcp-patch-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome);
  const store = new UserMcpConfigStore({ picoHome });
  const fullUrl =
    "https://username:password@docs.invalid/private/mcp?access_token=query-secret#fragment-secret";
  const initial = await store.upsert(
    {
      name: "docs",
      transport: "http",
      url: fullUrl,
      headers: { Authorization: "header-secret", Remove: "remove-secret" },
      startupTimeoutMs: 321,
      enabled: true,
    },
    { expectedRevision: (await store.read()).revision, idempotencyKey: "seed" },
  );
  const runtime = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env: { PICO_HOME: picoHome },
    userMcpConfigStore: store,
  });
  context.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  const before = (await desktop.handle(createRuntimeRequest("mcp.user.list", {}))) as JsonObject;
  const patch = {
    inputMode: "public-patch" as const,
    server: { name: "docs", transport: "http" as const, enabled: false },
    secretEdits: {
      headers: {
        Authorization: { action: "keep" as const },
        Remove: { action: "remove" as const },
        Added: { action: "set" as const, value: "new-secret" },
      },
      url: { action: "keep" as const },
    },
    expectedRevision: before["revision"] as string,
    idempotencyKey: "patch",
  };
  const result = (await desktop.handle(
    createRuntimeRequest("mcp.user.upsert", patch),
  )) as JsonObject;
  const current = await store.read();
  assert.equal(current.config.mcpServers.docs?.url, fullUrl);
  assert.equal(current.config.mcpServers.docs?.startupTimeoutMs, 321);
  assert.deepEqual(current.config.mcpServers.docs?.headers, {
    Authorization: "header-secret",
    Added: "new-secret",
  });
  assert.equal(current.config.mcpServers.docs?.enabled, false);
  const replay = await desktop.handle(createRuntimeRequest("mcp.user.upsert", patch));
  assert.deepEqual(replay, result);
  const publicJson = JSON.stringify([before, result, replay]);
  for (const secret of [
    "username",
    "password",
    "query-secret",
    "fragment-secret",
    "header-secret",
    "remove-secret",
    "new-secret",
  ])
    assert.equal(publicJson.includes(secret), false);
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("mcp.user.upsert", {
        ...patch,
        server: { ...patch.server, enabled: true },
      }),
    ),
    isConflict,
  );
  const otherStore = new UserMcpConfigStore({ picoHome });
  await otherStore.upsertPublicPatch(
    { name: "docs", transport: "http" },
    { headers: { Authorization: { action: "set", value: "rotated-secret" } } },
    { expectedRevision: current.revision, idempotencyKey: "rotate" },
  );
  await desktop.handle(createRuntimeRequest("mcp.user.upsert", patch));
  assert.equal(
    (await store.read()).config.mcpServers.docs?.headers?.Authorization,
    "rotated-secret",
    "replay must not rebuild a patch against later secrets",
  );
  const stalePatch = {
    ...patch,
    idempotencyKey: "stale",
    secretEdits: { headers: { Added: { action: "set" as const, value: "never-written-secret" } } },
  };
  await assert.rejects(
    desktop.handle(createRuntimeRequest("mcp.user.upsert", stalePatch)),
    isConflict,
  );
  assert.equal((await readFile(store.filePath, "utf8")).includes("never-written-secret"), false);
  const fresh = (await desktop.handle(createRuntimeRequest("mcp.user.list", {}))) as JsonObject;
  const invalidEdits: readonly JsonObject[] = [
    { url: { action: "remove" as const } },
    { headers: { Missing: { action: "keep" as const } } },
    { env: { KEY: { action: "set" as const, value: "invalid-transport-secret" } } },
    { url: { action: "set" as const, value: "invalid-url-secret" } },
  ];
  for (const secretEdits of invalidEdits) {
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("mcp.user.upsert", {
          ...patch,
          expectedRevision: fresh["revision"] as string,
          idempotencyKey: JSON.stringify(secretEdits),
          secretEdits,
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeProtocolError &&
        error.code === RUNTIME_ERROR_CODES.INVALID_PARAMS &&
        !error.message.includes("secret"),
    );
  }
  assert.equal((await store.read()).revision, (await otherStore.read()).revision);
  assert.notEqual(initial.resultRevision, current.revision);
  const ping = (await desktop.handle(createRuntimeRequest("runtime.ping", {}))) as JsonObject;
  assert.ok((ping["capabilities"] as string[]).includes("config-secret-patch-v1"));
});

test("MCP public patch writers perform merge and CAS within one store lock, including transport changes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-public-mcp-cas-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const left = new UserMcpConfigStore({ picoHome: root });
  const right = new UserMcpConfigStore({ picoHome: root });
  const seed = await left.upsert(
    {
      name: "local",
      transport: "stdio",
      command: "node",
      args: ["private-argument"],
      env: { TOKEN: "private-env" },
      cwd: "/private/cwd",
    },
    { expectedRevision: (await left.read()).revision, idempotencyKey: "seed" },
  );
  const race = await Promise.allSettled([
    left.upsertPublicPatch(
      { name: "local", transport: "stdio", enabled: false },
      { env: { TOKEN: { action: "keep" } } },
      { expectedRevision: seed.resultRevision, idempotencyKey: "left" },
    ),
    right.upsertPublicPatch(
      { name: "local", transport: "stdio", toolTimeoutMs: 555 },
      { env: { TOKEN: { action: "set", value: "right-env" } } },
      { expectedRevision: seed.resultRevision, idempotencyKey: "right" },
    ),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  const latest = await left.read();
  const local = latest.config.mcpServers.local!;
  assert.equal(local.command, "node");
  assert.deepEqual(local.args, ["private-argument"]);
  assert.equal(local.cwd, "/private/cwd");
  await assert.rejects(
    left.upsertPublicPatch({ name: "local", transport: "http" }, undefined, {
      expectedRevision: latest.revision,
      idempotencyKey: "missing-url",
    }),
  );
  const switched = await left.upsertPublicPatch(
    { name: "local", transport: "http" },
    { url: { action: "set", value: "https://remote.invalid/mcp?token=new-token" } },
    { expectedRevision: latest.revision, idempotencyKey: "switch" },
  );
  const remote = switched.snapshot.config.mcpServers.local!;
  assert.equal(remote.command, undefined);
  assert.equal(remote.env, undefined);
  assert.equal(remote.args, undefined);
  assert.equal(remote.cwd, undefined);
});

test("Provider public patch restores a matching public endpoint before authority and credential checks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-public-provider-patch-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome);
  const store = new UserConfigStore({ picoHome });
  const baseURL = "https://provider.invalid/v1?access_token=url-secret";
  const provider = {
    protocol: "openai" as const,
    baseURL,
    apiKeyEnv: "TOKEN",
    models: ["coder"],
    discoverModels: false,
    apiKey: "configured-secret",
  };
  await store.write(
    { version: 1, providers: { custom: provider } },
    { expectedRevision: (await store.read()).revision },
  );
  const runtime = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env: { PICO_HOME: picoHome },
    userConfigStore: store,
  });
  context.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  const before = (await desktop.handle(createRuntimeRequest("config.user.get", {}))) as JsonObject;
  const { apiKey: _secret, ...input } = provider;
  const result = (await desktop.handle(
    createRuntimeRequest("provider.upsert", {
      provider: {
        ...input,
        id: "custom",
        baseURL: publicProviderEndpoint(baseURL),
        models: ["coder", "added"],
      },
      inputMode: "public-patch",
      expectedRevision: before["revision"] as string,
    }),
  )) as JsonObject;
  assert.equal((await store.read()).config.providers.custom?.baseURL, baseURL);
  assert.equal((await store.read()).config.providers.custom?.apiKey, "configured-secret");
  assert.equal(JSON.stringify(result).includes("configured-secret"), false);
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("provider.upsert", {
        provider: { ...input, id: "custom", baseURL: "https://other.invalid/v1" },
        inputMode: "public-patch",
        expectedRevision: result["revision"] as string,
      }),
    ),
    isConflict,
  );
});

function isConflict(error: unknown): boolean {
  return error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT;
}
