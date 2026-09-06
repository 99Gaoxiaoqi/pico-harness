import assert from "node:assert/strict";
import test from "node:test";
import { parseStrictRuntimeParams } from "../../packages/protocol/src/runtime.js";
import { parseModelProviderConfigs } from "../../src/input/pico-config.js";
import {
  credentialRefForProvider,
  parseProviderCredentialRef,
} from "../../src/provider/credential-vault.js";

test("Responses config, RPC and v2 credentials accept the protocol and reject invalid values", () => {
  const provider = {
    id: "gateway",
    protocol: "responses" as const,
    baseURL: "https://example.test/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-5"],
    modelProtocols: {},
    discoverModels: false,
  };
  const config = parseModelProviderConfigs({ gateway: provider }, "responses-test");
  assert.equal(config.gateway?.protocol, "responses");
  assert.deepEqual(
    config.gateway?.modelProtocols,
    {},
    "an explicit empty mapping remains explicit",
  );
  const params = parseStrictRuntimeParams("provider.upsert", { provider, expectedRevision: "rev" });
  assert.equal(params.provider.protocol, "responses");
  assert.deepEqual(params.provider.modelProtocols, {});

  const identity = {
    providerId: provider.id,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
  };
  const responsesRef = credentialRefForProvider(identity);
  const parsed = parseProviderCredentialRef(responsesRef);
  assert.equal(parsed.protocol, "responses");
  assert.equal(parsed.providerId, provider.id);
  const openaiRef = credentialRefForProvider({ ...identity, protocol: "openai" });
  assert.notEqual(responsesRef, openaiRef);
  const mixedConfig = parseModelProviderConfigs(
    {
      gateway: {
        ...provider,
        protocol: "openai",
        modelProtocols: { "gpt-5": "responses" },
      },
    },
    "responses-test",
  ).gateway!;
  assert.equal(
    credentialRefForProvider({ ...identity, protocol: mixedConfig.protocol }),
    openaiRef,
    "model wire overrides must not change the default protocol credential identity",
  );
  assert.equal(mixedConfig.modelProtocols?.["gpt-5"], "responses");

  for (const protocol of ["response", "unknown", ""]) {
    assert.throws(
      () => parseModelProviderConfigs({ gateway: { ...provider, protocol } }, "responses-test"),
      /must be openai, claude or responses/,
    );
    assert.throws(() =>
      parseStrictRuntimeParams("provider.upsert", {
        provider: { ...provider, protocol },
        expectedRevision: "rev",
      }),
    );
    assert.throws(() =>
      parseProviderCredentialRef(responsesRef.replace("/responses/", `/${protocol}/`)),
    );
    assert.throws(
      () =>
        parseModelProviderConfigs(
          { gateway: { ...provider, modelProtocols: { "gpt-5": protocol } } },
          "responses-test",
        ),
      /must name a model/,
    );
  }
  const reasoning = {
    enabled: true,
    levels: ["high"],
    providerOptionsByLevel: {
      high: { responses: { set: [{ path: ["reasoning", "effort"], value: "high" }] } },
    },
  };
  assert.deepEqual(
    parseModelProviderConfigs(
      { gateway: { ...provider, models: { "gpt-5": { reasoning } } } },
      "responses-test",
    ).gateway?.modelCapabilities?.["gpt-5"]?.reasoning,
    reasoning,
  );
  const cacheConfig = (promptCache: Record<string, unknown>) =>
    parseModelProviderConfigs(
      {
        gateway: { ...provider, models: { "gpt-5": { promptCache } } },
      },
      "responses-test",
    );
  assert.equal(
    cacheConfig({ mode: "implicit", keyShards: 2, shardThresholdRpm: 20, retention: "24h" }).gateway
      ?.modelCapabilities?.["gpt-5"]?.promptCache?.retention,
    "24h",
  );
  for (const promptCache of [
    { mode: "explicit" },
    { mode: "implicit", ttl: "30m" },
    { mode: "implicit", explicitBreakpoints: false },
    { mode: "implicit", prewarm: true },
  ])
    assert.throws(() => cacheConfig(promptCache), /responses/);
});
