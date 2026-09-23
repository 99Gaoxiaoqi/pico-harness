import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest, type RuntimeResult } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { EffectiveConfigResolver } from "@pico/pico-host/input/effective-config";
import {
  OPENCODE_FREE_PROVIDER,
  OPENCODE_FREE_ROUTE_ID,
} from "../../fixtures/anonymous-provider.js";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import { loadEffectiveModelRuntime } from "@pico/pico-host/provider/effective-model-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { loadModelRouter } from "@pico/pico-host/provider/model-router";
import type { CredentialVault } from "@pico/pico-host/provider/credential-vault";
import { runHeadlessOneShotJson } from "@pico/pico-host/internal/headless-one-shot-runner";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { closeAllOperationalDatabasesForTest } from "@pico/storage";

const noVault: CredentialVault = {
  capability: () => {
    throw new Error("anonymous provider must not inspect the vault");
  },
  has: async () => {
    throw new Error("unexpected vault lookup");
  },
  resolve: async () => {
    throw new Error("unexpected credential resolution");
  },
  put: async () => {
    throw new Error("unexpected credential write");
  },
  delete: async () => {
    throw new Error("unexpected credential delete");
  },
};

test("production startup leaves a fresh config empty; a local anonymous connection still works", async (context) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-opencode-free-"));
  const userConfigStore = new UserConfigStore({ picoHome });
  const env = {
    PICO_HOME: picoHome,
    get OPENCODE_API_KEY(): string {
      throw new Error("anonymous provider must not read its credential environment");
    },
  };
  const workspaceRuntime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService: workspaceRuntime,
    userConfigStore,
    env,
    credentialVault: noVault,
  });
  context.after(async () => {
    await desktop.close();
    await workspaceRuntime.close();
    await rm(picoHome, { recursive: true, force: true });
  });
  const projected = (await desktop.handle(
    createRuntimeRequest("config.user.get", {}),
  )) as RuntimeResult<"config.user.get">;
  assert.equal(projected.config.defaults.modelRouteId, undefined);
  assert.deepEqual(projected.config.providers, []);
  const listed = (await desktop.handle(
    createRuntimeRequest("provider.list", {}),
  )) as RuntimeResult<"provider.list">;
  assert.deepEqual(listed.providers, []);
  const seen: { url: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url!, authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/v1/models"
          ? { data: [{ id: "local-model" }] }
          : {
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content: "anonymous works" },
                },
              ],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const localURL = `http://127.0.0.1:${address.port}/v1`;
  const upserted = (await desktop.handle(
    createRuntimeRequest("provider.upsert", {
      provider: {
        id: "opencode-free",
        protocol: "openai",
        auth: "none",
        apiKeyEnv: "OPENCODE_API_KEY",
        models: [...OPENCODE_FREE_PROVIDER.models],
        discoverModels: false,
        baseURL: localURL,
      },
      expectedRevision: projected.revision,
    }),
  )) as RuntimeResult<"provider.upsert">;
  assert.equal(upserted.provider.auth, "none");
  const afterUpsert = (await desktop.handle(
    createRuntimeRequest("provider.list", {}),
  )) as RuntimeResult<"provider.list">;
  assert.equal(afterUpsert.providers[0]!.credentialStatus, "ready");
  assert.equal(afterUpsert.providers[0]!.credentialSource, "none");
  assert.equal(afterUpsert.providers[0]!.storedCredentialPresent, false);
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: "opencode-free",
        secret: "synthetic-not-a-real-key",
        expectedRevision: upserted.revision,
      }),
    ),
    /免密钥/,
  );
  const effective = await loadEffectiveModelRuntime({
    workDir: picoHome,
    projectTrusted: false,
    env,
    credentialVault: noVault,
    userConfigStore,
    configResolver: new EffectiveConfigResolver({ userConfigStore }),
  });
  assert.equal(effective.credentials["opencode-free"]?.state, "none");
  const selected = effective.router.providerConfig(undefined);
  assert.equal(selected.config.apiKey, "");
  assert.deepEqual(effective.router.credentialCandidates(selected.route.id), []);
  assert.equal(effective.router.validate(selected.route.id).ok, true);
  const answer = await createProvider(selected.provider, selected.config).generate(
    [{ role: "user", content: "synthetic hello" }],
    [],
  );
  assert.equal(answer.content, "anonymous works");
  assert.deepEqual(seen, [{ url: "/v1/chat/completions", authorization: undefined }]);
  const discovered = await loadModelRouter({
    config: {
      providers: {
        local: { ...OPENCODE_FREE_PROVIDER, baseURL: localURL, models: [], discoverModels: true },
      },
    },
    env,
  });
  assert.equal(discovered.routes[0]?.id, "local/local-model");
  assert.deepEqual(seen[1], { url: "/v1/models", authorization: undefined });
  const ordinary = await loadModelRouter({
    config: {
      providers: { paid: { ...OPENCODE_FREE_PROVIDER, auth: "api-key", baseURL: localURL } },
    },
    env: {},
  });
  assert.equal(ordinary.validate(ordinary.routes[0]!.id).ok, false);
  assert.throws(() => ordinary.providerConfig(undefined), /缺少凭证/);
});

test("reading config preserves existing providers and defaults", async (context) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-opencode-free-preserve-"));
  context.after(() => rm(picoHome, { recursive: true, force: true }));
  const store = new UserConfigStore({ picoHome });
  const empty = await store.read();
  assert.deepEqual(await store.read(), empty);
  const existing = await store.write(
    {
      version: 1,
      providers: {
        custom: { ...OPENCODE_FREE_PROVIDER, auth: "api-key", models: ["existing-model"] },
      },
      defaults: { modelRouteId: "custom/existing-model" },
    },
    { expectedRevision: empty.revision },
  );
  assert.deepEqual(await store.read(), existing);
  const noDefault = await store.write(
    { version: 1, providers: existing.config.providers },
    { expectedRevision: existing.revision },
  );
  assert.deepEqual(await store.read(), noDefault);
  const explicitDefault = await store.write(
    { version: 1, providers: {}, defaults: { modelRouteId: "explicit/model" } },
    { expectedRevision: noDefault.revision },
  );
  assert.deepEqual(await store.read(), explicitDefault);
});

test("OpenAI and Claude send Pico session headers only to documented Zen and Go endpoints", async (context) => {
  let sentHeaders = new Headers();
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    sentHeaders = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  const config = { apiKey: "synthetic", model: "fixture", sessionId: "pico-session-fixture" };
  for (const protocol of ["openai", "claude"] as const) {
    for (const baseURL of [
      "https://opencode.ai/zen/v1",
      "https://opencode.ai/zen/go/v1",
      "https://opencode.ai.evil.test/zen/v1",
      "https://opencode.ai/other/v1",
      "http://opencode.ai/zen/v1",
    ]) {
      await createProvider(protocol, { ...config, baseURL }).generate(
        [{ role: "user", content: "synthetic hello" }],
        [],
      );
      const isOpenCode =
        baseURL === "https://opencode.ai/zen/v1" || baseURL === "https://opencode.ai/zen/go/v1";
      assert.equal(sentHeaders.get("User-Agent"), isOpenCode ? "Pico/0.1.0" : null);
      assert.equal(sentHeaders.get("x-opencode-session"), isOpenCode ? config.sessionId : null);
    }
  }
});

test("headless uses the trusted anonymous route through the real Runtime and local HTTP", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-opencode-free-headless-"));
  const picoHome = join(root, "home");
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  context.after(async () => {
    await globalSessionManager.clearAndDrain();
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, undefined);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "headless anonymous works" },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const store = new UserConfigStore({ picoHome });
  const seeded = await store.read();
  await store.write(
    {
      ...seeded.config,
      defaults: { modelRouteId: OPENCODE_FREE_ROUTE_ID },
      providers: {
        "opencode-free": {
          ...OPENCODE_FREE_PROVIDER,
          baseURL: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    },
    { expectedRevision: seeded.revision },
  );
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workspacePath));
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      schemaVersion: 2,
      requestId: "anonymous-headless",
      workspacePath,
      picoHome,
      sessionId: "anonymous-headless-session",
      prompt: "synthetic hello",
      modelRouteId: OPENCODE_FREE_ROUTE_ID,
      providerRequestMode: "single_non_stream",
      providerAdmissionDeadlineMs: Date.now() + 30000,
      collaborationMode: "agent",
      permissionMode: "auto",
      allowedTools: [],
      timeoutMs: 30000,
      shutdownGraceMs: 2000,
      trace: false,
    }),
    { env: {}, credentialVault: noVault },
  );
  assert.equal(outcome.result.status, "completed", JSON.stringify(outcome.result));
  assert.equal(requests, 1);
});
