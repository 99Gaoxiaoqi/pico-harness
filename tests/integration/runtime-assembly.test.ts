import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { CredentialPool } from "../../src/provider/credential-pool.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import {
  assembleRuntimeProvider,
  type RuntimeProviderFactory,
} from "../../src/runtime/runtime-assembly.js";

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
