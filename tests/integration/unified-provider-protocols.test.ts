import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { RuntimeResult } from "@pico/protocol";
import { createRuntimeRequest } from "../../src/daemon/index.js";
import {
  assembleProductionDaemonHost,
  createProductionRuntimeServices,
} from "../../src/daemon/production-host.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import {
  credentialRefForProvider,
  type CredentialVault,
} from "../../src/provider/credential-vault.js";
import { loadEffectiveModelRuntime } from "../../src/provider/effective-model-runtime.js";
import { createProvider } from "../../src/provider/factory.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import {
  providerPresets,
  selectedModelProtocols,
} from "../../apps/desktop/src/renderer/provider-presets.js";
import { saveProviderConnection } from "../../apps/desktop/src/renderer/provider-connection.js";

test("one provider and key survive RPC round trips and route Chat, Messages and background execution by model", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-unified-provider-"));
  const picoHome = join(root, "home");
  await mkdir(join(root, "workspace"));
  const workspacePath = await realpath(join(root, "workspace"));
  const secret = "synthetic-shared-provider-key";
  const requests: { path: string; model: string; key: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { model: string; stream?: boolean };
    const messages = request.url === "/v1/messages";
    requests.push({
      path: request.url!,
      model: body.model,
      key: messages
        ? String(request.headers["x-api-key"])
        : request.headers.authorization?.replace(/^Bearer /u, ""),
    });
    if (body.stream && messages) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: "fixture",
            type: "message",
            model: body.model,
            role: "assistant",
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "unified-ok" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      );
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        messages
          ? {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              model: "claude-fixture",
              content: [{ type: "text", text: "unified-ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              choices: [
                { finish_reason: "stop", message: { role: "assistant", content: "unified-ok" } },
              ],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const credentialRef = credentialRefForProvider({
    providerId: "opencode-go",
    protocol: "openai",
    baseURL,
  });
  const vault: CredentialVault = {
    capability: () => ({
      available: true,
      backend: "macos-keychain",
      diagnostic: "in-memory test double",
    }),
    has: async (ref) => {
      assert.equal(ref, credentialRef);
      return true;
    },
    resolve: async (ref) => {
      assert.equal(ref, credentialRef);
      return secret;
    },
    put: async () => {
      throw new Error("must reuse the shared credential");
    },
    delete: async () => {
      throw new Error("must not delete the shared credential");
    },
  };
  const store = new UserConfigStore({ picoHome });
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const env = { PICO_HOME: picoHome };
  const services = createProductionRuntimeServices({
    env,
    userConfigStore: store,
    credentialVault: vault,
    trustStore,
  });
  const host = assembleProductionDaemonHost(services, {});
  context.after(async () => {
    await host.stop();
    await globalSessionManager.clearAndDrain();
    closeAllOperationalDatabasesForTest();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  await host.start();
  const initial = (await services.desktopService.handle(
    createRuntimeRequest("config.user.get", {}),
  )) as RuntimeResult<"config.user.get">;
  const preset = providerPresets.find((entry) => entry.id === "opencode-go")!;
  const initialSelection = selectedModelProtocols(preset, ["kimi-k2.6"]);
  assert.deepEqual(initialSelection, {});
  const provider = {
    id: preset.id,
    protocol: preset.protocol,
    apiKeyEnv: preset.apiKeyEnv,
    baseURL,
    models: [...preset.models],
    modelProtocols: preset.modelProtocols!,
    discoverModels: false,
  };
  await saveProviderConnection(
    async (method, params) =>
      (await services.desktopService.handle(createRuntimeRequest(method, params))) as RuntimeResult<
        typeof method
      >,
    {
      provider: { ...provider, models: ["kimi-k2.6"], modelProtocols: initialSelection! },
      expectedRevision: initial.revision,
    },
    secret,
  );
  const listed = (await services.desktopService.handle(
    createRuntimeRequest("provider.list", {}),
  )) as RuntimeResult<"provider.list">;
  assert.deepEqual(listed.providers.find((entry) => entry.id === preset.id)?.modelProtocols, {});
  const projected = (await services.desktopService.handle(
    createRuntimeRequest("config.user.get", {}),
  )) as RuntimeResult<"config.user.get">;
  assert.deepEqual(
    projected.config.providers.find((entry) => entry.id === preset.id)?.modelProtocols,
    {},
  );
  assert.equal(JSON.stringify(projected).includes(secret), false);
  const reloaded = projected.config.providers.find((entry) => entry.id === preset.id)!;
  // The HTTP fixture replaces the live endpoint; selection still uses the preset's canonical URL.
  const restoredSelection = selectedModelProtocols(
    { ...reloaded, baseURL: preset.baseURL },
    preset.models,
  );
  assert.deepEqual(restoredSelection, preset.modelProtocols);
  const upserted = (await services.desktopService.handle(
    createRuntimeRequest("provider.upsert", {
      provider: { ...provider, modelProtocols: restoredSelection! },
      expectedRevision: projected.revision,
    }),
  )) as RuntimeResult<"provider.upsert">;
  assert.deepEqual(upserted.provider.modelProtocols, preset.modelProtocols);
  await services.desktopService.handle(
    createRuntimeRequest("config.user.update", {
      defaults: { modelRouteId: "opencode-go/minimax-m3" },
      expectedRevision: upserted.revision,
    }),
  );
  const effective = await loadEffectiveModelRuntime({
    workDir: workspacePath,
    projectTrusted: true,
    legacyProvider: "openai",
    legacyModel: "",
    env,
    userConfigStore: new UserConfigStore({ picoHome }),
    configResolver: new EffectiveConfigResolver({ userConfigStore: store }),
    credentialVault: vault,
  });
  for (const [model, protocol, path] of [
    ["kimi-k2.6", "openai", "/v1/chat/completions"],
    ["minimax-m3", "claude", "/v1/messages"],
  ] as const) {
    const selected = effective.router.providerConfig(`opencode-go/${model}`);
    assert.equal(selected.provider, protocol);
    assert.equal(selected.config.apiKey, secret);
    assert.equal(
      (
        await createProvider(selected.provider, selected.config).generate(
          [{ role: "user", content: "synthetic" }],
          [],
        )
      ).content,
      "unified-ok",
    );
    assert.deepEqual(requests.at(-1), { path, model, key: secret });
  }
  const trusted = (await services.desktopService.handle(
    createRuntimeRequest("automation.create", {
      workspacePath,
      prompt: "synthetic",
      schedule: "0 0 1 1 *",
      modelRouteId: "opencode-go/minimax-m3",
      expectedCredentialRef: credentialRef,
      allowedTools: [],
      toolNetworkPolicy: "disabled",
      enabled: true,
    }),
  )) as RuntimeResult<"automation.create">;
  assert.equal(trusted.job.enabled, true);
  const created = (await services.desktopService.handle(
    createRuntimeRequest("jobs.create", {
      workspacePath,
      name: "mixed protocol",
      prompt: "synthetic",
      schedule: "0 0 1 1 *",
      enabled: true,
    }),
  )) as RuntimeResult<"jobs.create">;
  const run = await host.runCronJobNow(workspacePath, created.job.jobId);
  let succeeded = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const history = (await services.desktopService.handle(
      createRuntimeRequest("jobs.history", { workspacePath, jobId: created.job.jobId }),
    )) as RuntimeResult<"jobs.history">;
    succeeded = history.runs.some(
      (entry) => entry.runId === run.cronRunId && entry.status === "succeeded",
    );
    if (succeeded) break;
    await delay(20);
  }
  assert.equal(succeeded, true);
  assert.deepEqual(requests.at(-1), { path: "/v1/messages", model: "minimax-m3", key: secret });

  const current = await store.read();
  const invalidMaps: Record<string, string>[] = [
    { "minimax-m3": "unsupported" },
    { absent: "claude" },
  ];
  for (const modelProtocols of invalidMaps) {
    await assert.rejects(
      services.desktopService.handle(
        createRuntimeRequest("provider.upsert", {
          provider: { ...provider, modelProtocols },
          expectedRevision: current.revision,
        }),
      ),
      /modelProtocols/u,
    );
    assert.equal((await store.read()).revision, current.revision);
  }
});
