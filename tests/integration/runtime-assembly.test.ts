import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { CredentialPool } from "../../src/provider/credential-pool.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { ModelRouter, type ModelRoute } from "../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import {
  assembleRuntimeProvider,
  type RuntimeProviderFactory,
} from "../../src/runtime/runtime-assembly.js";
import { createSubagentModelRuntime } from "../../src/runtime/subagent-model-runtime.js";
import { resolveSubagentModelSelection } from "../../src/runtime/subagent-model-selection.js";

test("runtime provider assembly decorates an injected provider without taking ownership", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-assembly-injected-"));
  const session = new Session("runtime-assembly-injected", root);
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });

  let factoryCalls = 0;
  const injected: LLMProvider = {
    modelName: "injected-model",
    async generate() {
      return { role: "assistant", content: "ok" };
    },
  };
  const provider = assembleRuntimeProvider({
    kind: "openai",
    config: { baseURL: "http://example.test", apiKey: "unused", model: "configured-model" },
    session,
    trackerOptions: {},
    provider: injected,
    providerFactory: (() => {
      factoryCalls++;
      return injected;
    }) as RuntimeProviderFactory,
  });

  assert.equal(factoryCalls, 0);
  assert.equal(provider.rebuildProvider, undefined);
  assert.equal(provider.provider.modelName, "configured-model");
});

test("runtime provider assembly keeps credential rotation behind the assembly boundary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-assembly-rotation-"));
  const session = new Session("runtime-assembly-rotation", root);
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });

  const createdKeys: string[] = [];
  const providerFactory: RuntimeProviderFactory = (_kind, config) => {
    createdKeys.push(config.apiKey);
    return {
      modelName: config.model,
      async generate() {
        return { role: "assistant", content: config.apiKey };
      },
    };
  };
  const assembly = assembleRuntimeProvider({
    kind: "openai",
    config: { baseURL: "http://example.test", apiKey: "key-1", model: "configured-model" },
    session,
    trackerOptions: {},
    credentialPool: new CredentialPool(["key-1", "key-2"]),
    providerFactory,
  });

  assert.deepEqual(createdKeys, ["key-1"]);
  assert.ok(assembly.rebuildProvider);
  const rebuilt = assembly.rebuildProvider();
  assert.ok(rebuilt);
  assert.deepEqual(createdKeys, ["key-1", "key-2"]);
});

test("runtime provider assembly keeps usage tracking outside provider decorators", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-assembly-decorator-"));
  const session = new Session("runtime-assembly-decorator", root, { persistence: false });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });

  let rawCalls = 0;
  let decoratorCalls = 0;
  const assembly = assembleRuntimeProvider({
    kind: "openai",
    config: { baseURL: "http://example.test", apiKey: "unused", model: "decorated-model" },
    session,
    trackerOptions: {},
    providerFactory: () => ({
      async generate() {
        rawCalls++;
        return { role: "assistant", content: "raw" };
      },
    }),
    providerDecorator: () => {
      decoratorCalls++;
      return {
        async generate() {
          return {
            role: "assistant",
            content: "decorated",
            usage: { promptTokens: 3, completionTokens: 2 },
          };
        },
      };
    },
  });

  const response = await assembly.provider.generate([{ role: "user", content: "hello" }], []);
  assert.equal(response.content, "decorated");
  assert.equal(decoratorCalls, 1);
  assert.equal(rawCalls, 0);
  assert.equal(session.getRuntimeStateSnapshot().usage.totalProviderCalls, 1);
});

test("subagent model runtime applies the shared decorator inside usage tracking", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-subagent-provider-decorator-"));
  const session = new Session("subagent-provider-decorator", root, { persistence: false });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  const route: ModelRoute = {
    id: "fixture/subagent",
    providerId: "fixture",
    provider: "openai",
    model: "subagent-model",
    baseURL: "http://example.test",
    apiKeyEnv: "SUBAGENT_TEST_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", "subagent-model", undefined),
  };
  const router = new ModelRouter([route], { SUBAGENT_TEST_KEY: "key" }, route.id);
  const selection = resolveSubagentModelSelection({
    router,
    parentRouteId: route.id,
    allowRouteOverride: false,
  });
  let decoratorCalls = 0;
  const runtime = createSubagentModelRuntime({
    router,
    selection,
    session,
    providerFactory: () => ({
      async generate() {
        return { role: "assistant", content: "raw" };
      },
    }),
    providerDecorator: () => {
      decoratorCalls++;
      return {
        async generate() {
          return {
            role: "assistant",
            content: "decorated-subagent",
            usage: { promptTokens: 2, completionTokens: 1 },
          };
        },
      };
    },
  });

  const response = await runtime.provider.generate([{ role: "user", content: "hello" }], []);
  assert.equal(response.content, "decorated-subagent");
  assert.equal(decoratorCalls, 1);
  assert.equal(session.getRuntimeStateSnapshot().usage.totalProviderCalls, 1);
});
