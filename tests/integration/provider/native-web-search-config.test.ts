import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseStrictRuntimeParams, type RuntimeResult } from "@pico/protocol";
import { configResultValidators } from "../../../packages/protocol/src/runtime/config.js";
import { DesktopProviderConfigService } from "@pico/pico-host/desktop-provider-config-service";
import { parseModelProviderConfigs } from "@pico/pico-host/input/pico-config";
import { parseUserConfig, UserConfigStore } from "@pico/pico-host/input/user-config-store";
import { loadModelRouter } from "@pico/pico-host/provider/model-router";
import { parseModelRoutes } from "../../../apps/desktop/src/renderer/runtime-projections/configuration.js";

const provider = {
  protocol: "openai" as const,
  baseURL: "https://api.deepseek.com/v1",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  discoverModels: false,
  models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat"],
};

test("empty known models discover selectable models through desktop provider and workspace projections", async (context) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-discovered-models-"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.url?.endsWith("/chat/completions")) {
      response.end(
        JSON.stringify({
          id: "test-connection",
          object: "chat.completion",
          created: 1,
          model: "remote-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ data: [{ id: "remote-model" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = new DesktopProviderConfigService({
    picoHome,
    env: {},
    revisionTokenKey: Buffer.alloc(32, 8),
    listWorkspacePaths: async () => [],
    requireTrustedWorkspace: async (path) => path,
    assertNoActiveRuns: async () => undefined,
    providerReferences: () => [],
    publishUserConfigUpdated: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(picoHome, { recursive: true, force: true });
  });
  await service.ready;
  const current = (await service.getUserConfig({})) as RuntimeResult<"config.user.get">;
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  await service.upsertUserProvider({
    provider: {
      id: "local",
      protocol: "openai",
      auth: "none",
      baseURL,
      apiKeyEnv: "LOCAL_API_KEY",
      models: [],
      discoverModels: true,
    },
    expectedRevision: current.revision,
  });
  const listed = (await service.listUserProviders({})) as RuntimeResult<"provider.list">;
  configResultValidators["provider.list"](listed, "result");
  assert.deepEqual(listed.providers[0]?.models, []);
  assert.deepEqual(listed.providers[0]?.availableModels, ["remote-model"]);
  assert.equal(
    listed.providers[0]?.resolvedModelCapabilities?.["remote-model"]?.contextSource,
    "profile_default",
  );
  assert.equal(listed.providers[0]?.resolvedModelCapabilities?.["remote-model"]?.vision, "unknown");
  const tested = (await service.testProviderConnection({
    providerId: "local",
    model: "remote-model",
  })) as RuntimeResult<"provider.test">;
  configResultValidators["provider.test"](tested, "result");
  assert.equal(tested.ok, true, tested.message);
  assert.ok(requests.includes("/v1/chat/completions"));
  const effective = (await service.getEffectiveConfig({
    workspacePath: picoHome,
  })) as RuntimeResult<"config.effective.get">;
  configResultValidators["config.effective.get"](effective, "result");
  assert.deepEqual(effective.config.providers[0]?.availableModels, ["remote-model"]);
  assert.deepEqual(parseModelRoutes(effective.config), [
    { id: "local/remote-model", label: "remote-model" },
  ]);
  const withDefault = (await service.updateUserConfig({
    defaults: { modelRouteId: "local/remote-model" },
    expectedRevision: listed.revision,
  })) as RuntimeResult<"config.user.update">;
  assert.equal(withDefault.config.defaults.modelRouteId, "local/remote-model");
  await assert.rejects(
    service.upsertUserProvider({
      provider: {
        id: "local",
        protocol: "openai",
        auth: "none",
        baseURL,
        apiKeyEnv: "LOCAL_API_KEY",
        models: [],
        disabledModels: ["remote-model"],
        discoverModels: true,
      },
      expectedRevision: withDefault.revision,
    }),
    /默认模型路由/u,
  );
  const cleared = (await service.updateUserConfig({
    defaults: {},
    expectedRevision: withDefault.revision,
  })) as RuntimeResult<"config.user.update">;
  await service.upsertUserProvider({
    provider: {
      id: "local",
      protocol: "openai",
      auth: "none",
      baseURL,
      apiKeyEnv: "LOCAL_API_KEY",
      models: [],
      disabledModels: ["remote-model"],
      discoverModels: true,
    },
    expectedRevision: cleared.revision,
  });
  const disabled = (await service.getEffectiveConfig({
    workspacePath: picoHome,
  })) as RuntimeResult<"config.effective.get">;
  assert.deepEqual(disabled.config.providers[0]?.availableModels, ["remote-model"]);
  assert.deepEqual(parseModelRoutes(disabled.config), []);
  const disabledTest = (await service.testProviderConnection({
    providerId: "local",
    model: "remote-model",
  })) as RuntimeResult<"provider.test">;
  assert.equal(disabledTest.ok, false);
  assert.match(disabledTest.message, /不可用/u);
  const routed = await loadModelRouter({
    config: {
      providers: {
        local: {
          protocol: "openai",
          auth: "none",
          baseURL,
          apiKeyEnv: "LOCAL_API_KEY",
          models: [],
          disabledModels: ["remote-model"],
          discoverModels: true,
        },
      },
    },
  });
  assert.deepEqual(routed.catalogModelsByProvider.local, ["remote-model"]);
  assert.deepEqual(routed.routes, []);
  assert.ok(requests.every((url) => ["/v1/models", "/v1/chat/completions"].includes(url)));
});

test("provider detail uses exact endpoint catalog metadata and keeps user overrides first", async (context) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-model-capabilities-"));
  const service = new DesktopProviderConfigService({
    picoHome,
    env: {},
    revisionTokenKey: Buffer.alloc(32, 9),
    listWorkspacePaths: async () => [],
    requireTrustedWorkspace: async (path) => path,
    assertNoActiveRuns: async () => undefined,
    providerReferences: () => [],
    publishUserConfigUpdated: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(picoHome, { recursive: true, force: true });
  });
  await service.ready;
  const current = (await service.getUserConfig({})) as RuntimeResult<"config.user.get">;
  await service.upsertUserProvider({
    provider: {
      id: "opencode-go",
      protocol: "openai",
      auth: "none",
      baseURL: "https://opencode.ai/zen/go/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: ["minimax-m3", "glm-5.2"],
      discoverModels: false,
      modelCapabilities: { "glm-5.2": { context: 32_768, vision: true } },
    },
    expectedRevision: current.revision,
  });
  const listed = (await service.listUserProviders({})) as RuntimeResult<"provider.list">;
  configResultValidators["provider.list"](listed, "result");
  const capabilities = listed.providers[0]?.resolvedModelCapabilities;
  assert.equal(capabilities?.["minimax-m3"]?.displayName, "MiniMax-M3");
  assert.equal(capabilities?.["minimax-m3"]?.contextWindowTokens, 1_000_000);
  assert.equal(capabilities?.["minimax-m3"]?.maxOutputTokens, 131_072);
  assert.equal(capabilities?.["minimax-m3"]?.vision, true);
  assert.equal(capabilities?.["minimax-m3"]?.reasoning, true);
  assert.equal(capabilities?.["minimax-m3"]?.toolCall, true);
  assert.equal(capabilities?.["minimax-m3"]?.metadataSource, "models_dev_snapshot");
  assert.equal(capabilities?.["glm-5.2"]?.contextWindowTokens, 32_768);
  assert.equal(capabilities?.["glm-5.2"]?.contextSource, "config");
  assert.equal(capabilities?.["glm-5.2"]?.vision, true);
});

test("search defaults survive strict RPC, private persistence and provider updates with resolved capabilities", async (context) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-search-config-"));
  const store = new UserConfigStore({ picoHome });
  const secret = "synthetic-native-search-config-secret";
  const initial = await store.read();
  await store.write(
    { version: 1, providers: { deepseek: { ...provider, apiKey: secret } } },
    { expectedRevision: initial.revision },
  );
  const service = new DesktopProviderConfigService({
    picoHome,
    env: {},
    userConfigStore: store,
    revisionTokenKey: Buffer.alloc(32, 7),
    listWorkspacePaths: async () => [],
    requireTrustedWorkspace: async (path) => path,
    assertNoActiveRuns: async () => undefined,
    providerReferences: () => [],
    publishUserConfigUpdated: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(picoHome, { recursive: true, force: true });
  });
  await service.ready;
  let current = (await service.getUserConfig({})) as RuntimeResult<"config.user.get">;
  assert.equal(current.config.defaults.webSearch, undefined);
  for (const source of ["model", "external"] as const) {
    const defaults = { webSearch: { enabled: true, source } };
    const params = parseStrictRuntimeParams("config.user.update", {
      defaults,
      expectedRevision: current.revision,
    });
    current = (await service.updateUserConfig(params)) as RuntimeResult<"config.user.update">;
    configResultValidators["config.user.update"](current, "result");
    assert.deepEqual(current.config.defaults.webSearch, defaults.webSearch);
    assert.equal(JSON.stringify(current).includes(secret), false);
    const updated = await service.upsertUserProvider({
      provider: {
        id: "deepseek",
        ...provider,
        modelCapabilities: { "deepseek-v4-flash": { webSearch: true } },
      },
      expectedRevision: current.revision,
    });
    assert.equal(JSON.stringify(updated).includes(secret), false);
    current = (await service.getUserConfig({})) as RuntimeResult<"config.user.get">;
    assert.deepEqual(current.config.defaults.webSearch, defaults.webSearch);
    assert.deepEqual((await store.read()).config.defaults?.webSearch, defaults.webSearch);
    const effective = (await service.getEffectiveConfig({
      workspacePath: picoHome,
    })) as RuntimeResult<"config.effective.get">;
    configResultValidators["config.effective.get"](effective, "result");
    assert.deepEqual(effective.config.defaults.webSearch, defaults.webSearch);
    const listed = (await service.listUserProviders({})) as RuntimeResult<"provider.list">;
    configResultValidators["provider.list"](listed, "result");
    const capability =
      listed.providers[0]!.resolvedModelCapabilities!["deepseek-v4-flash"]!.nativeWebSearch;
    assert.equal(capability.available, false);
    assert.match(capability.reason, /DeepSeek Responses/);
    assert.equal(JSON.stringify(listed).includes(secret), false);
  }
  assert.ok((await readFile(store.filePath, "utf8")).includes(secret));
  for (const webSearch of [
    null,
    true,
    {},
    { enabled: true },
    { enabled: "true", source: "model" },
    { enabled: false, source: "unknown" },
    { enabled: true, source: "model", apiKey: secret },
  ]) {
    assert.throws(
      () =>
        parseStrictRuntimeParams("config.user.update", {
          defaults: { webSearch },
          expectedRevision: current.revision,
        }),
      /webSearch/,
    );
    assert.throws(
      () => parseUserConfig({ version: 1, providers: {}, defaults: { webSearch } }, "test"),
      /webSearch/,
    );
    await assert.rejects(
      service.updateUserConfig({ defaults: { webSearch }, expectedRevision: current.revision }),
      /webSearch/,
    );
  }
});

test("parsed capabilities, selected protocols and provider configs use the same narrow route rules", async () => {
  const providers = parseModelProviderConfigs(
    {
      deepseek: {
        ...provider,
        models: {
          "deepseek-v4-flash": { webSearch: true },
          "deepseek-v4-pro": {},
          "deepseek-chat": {},
        },
      },
      overridden: {
        ...provider,
        modelProtocols: { "deepseek-v4-flash": "openai", "deepseek-v4-pro": "claude" },
        modelCapabilities: { "deepseek-v4-pro": { webSearch: true } },
      },
      compatible: { ...provider, baseURL: "https://gateway.example/v1" },
      spoof: { ...provider, baseURL: "https://api.deepseek.com.example/v1" },
      unknown: { ...provider, models: ["deepseek-v4-pro-preview", "deepseek-v4-flash-fake"] },
      openai: {
        ...provider,
        protocol: "responses",
        baseURL: "https://api.openai.com/v1",
        models: {
          "gpt-5": {},
          "gpt-5-mini": { webSearch: false },
          "unknown-model": {},
          "gpt-4.1-nano": {},
          "gpt-5.6-nano": {},
        },
      },
      anthropic: {
        ...provider,
        protocol: "claude",
        baseURL: "https://api.anthropic.com/v1",
        models: ["claude-sonnet-4-6", "claude-fictional"],
      },
      confirmed: {
        ...provider,
        protocol: "responses",
        baseURL: "https://gateway.example/v1",
        models: { "custom-model": { webSearch: true } },
      },
    },
    "test",
  );
  const router = await loadModelRouter({
    config: { providers },
    env: { DEEPSEEK_API_KEY: "synthetic-secret" },
  });
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    const selected = router.providerConfig(`deepseek/${model}`);
    assert.equal(selected.provider, "responses");
    assert.equal(selected.route.provider, "responses");
    assert.equal(selected.config.capabilities?.nativeWebSearch?.available, false);
  }
  for (const id of [
    "deepseek/deepseek-chat",
    "compatible/deepseek-v4-flash",
    "spoof/deepseek-v4-pro",
    "unknown/deepseek-v4-pro-preview",
    "overridden/deepseek-v4-flash",
  ])
    assert.equal(router.require(id).provider, "openai");
  const overridden = router.require("overridden/deepseek-v4-pro");
  assert.equal(overridden.provider, "claude");
  assert.equal(overridden.capabilities.nativeWebSearch?.adapter, "anthropic-web-search");
  assert.equal(
    router.require("anthropic/claude-sonnet-4-6").capabilities.nativeWebSearch?.available,
    true,
  );
  assert.equal(
    router.require("anthropic/claude-fictional").capabilities.nativeWebSearch?.available,
    false,
  );
  assert.equal(
    router.require("openai/gpt-5").capabilities.nativeWebSearch?.adapter,
    "openai-web-search",
  );
  assert.equal(router.require("openai/gpt-5-mini").capabilities.nativeWebSearch?.available, false);
  assert.equal(
    router.require("openai/unknown-model").capabilities.nativeWebSearch?.available,
    false,
  );
  assert.equal(
    router.require("confirmed/custom-model").capabilities.nativeWebSearch?.available,
    true,
  );
  for (const model of ["gpt-4.1-nano", "gpt-5.6-nano"]) {
    assert.equal(router.require(`openai/${model}`).capabilities.nativeWebSearch?.available, false);
  }
  // Capability parsing must already use the selected Responses protocol.
  assert.throws(
    () =>
      parseModelProviderConfigs(
        {
          deepseek: {
            ...provider,
            models: { "deepseek-v4-pro": { promptCache: { mode: "explicit" } } },
          },
        },
        "test",
      ),
    /responses/i,
  );
  assert.doesNotThrow(() =>
    parseModelProviderConfigs(
      {
        deepseek: {
          ...provider,
          modelProtocols: { "deepseek-v4-pro": "openai" },
          models: { "deepseek-v4-pro": { promptCache: { mode: "explicit" } } },
        },
      },
      "test",
    ),
  );
  for (const webSearch of ["true", 1, null])
    assert.throws(
      () =>
        parseModelProviderConfigs(
          { deepseek: { ...provider, models: { "deepseek-v4-pro": { webSearch } } } },
          "test",
        ),
      /webSearch.*boolean/,
    );
});
