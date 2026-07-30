import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error The benchmark route builder is intentionally plain Node ESM.
import { buildBenchmarkRouteConfig } from "../../scripts/terminal-bench/route-config.mjs";

const pricing = {
  schemaVersion: 1,
  providerId: "codex-oauth",
  model: "gpt-5.4",
  currency: "CNY",
  unit: "microCNYPerMillionTokens",
  input: 100_000_000,
  output: 1_000_000_000,
};

test("Terminal-Bench pins the exact gpt-5.4 output capability in its route config", () => {
  const provider = {
    protocol: "openai",
    baseURL: "http://127.0.0.1:8080",
    apiKeyEnv: "PICO_TB_PROVIDER_API_KEY",
    models: ["gpt-5.4"],
    discoverModels: false,
    modelCapabilities: {
      "gpt-5.4": {
        toolCall: true,
        output: 4096,
        outputTokenField: "max_tokens",
      },
    },
  };

  const route = buildBenchmarkRouteConfig({
    modelRouteId: "codex-oauth/gpt-5.4",
    providerId: "codex-oauth",
    model: "gpt-5.4",
    provider,
    pricing,
    pricingSha256: "a".repeat(64),
    maxRunCostCNY: 890,
    thinkingEffort: "medium",
  });

  assert.equal(
    route.provider.modelCapabilities["gpt-5.4"].outputTokenField,
    "max_completion_tokens",
  );
  assert.equal(route.provider.modelCapabilities["gpt-5.4"].output, 8192);
  assert.equal(route.provider.modelCapabilities["gpt-5.4"].toolCall, true);
  assert.equal(route.runBudget.maxCostMicroCNY, 890_000_000);
  assert.equal(route.thinkingEffort, "medium");
  assert.equal(provider.modelCapabilities["gpt-5.4"].output, 4096);
  assert.equal(provider.modelCapabilities["gpt-5.4"].outputTokenField, "max_tokens");
});

test("Terminal-Bench does not generalize the output override to other routes", () => {
  const provider = {
    protocol: "openai",
    baseURL: "http://127.0.0.1:8080",
    apiKeyEnv: "PICO_TB_PROVIDER_API_KEY",
    models: ["gpt-5.4"],
    discoverModels: false,
    modelCapabilities: {
      "gpt-5.4": {
        output: 4096,
        outputTokenField: "max_tokens",
      },
    },
  };

  const route = buildBenchmarkRouteConfig({
    modelRouteId: "another-provider/gpt-5.4",
    providerId: "another-provider",
    model: "gpt-5.4",
    provider,
    pricing: { ...pricing, providerId: "another-provider" },
    pricingSha256: "a".repeat(64),
    maxRunCostCNY: 1,
  });

  assert.deepEqual(route.provider, provider);
});

test("Terminal-Bench rejects the pinned route when its protocol cannot carry the field", () => {
  assert.throws(
    () =>
      buildBenchmarkRouteConfig({
        modelRouteId: "codex-oauth/gpt-5.4",
        providerId: "codex-oauth",
        model: "gpt-5.4",
        provider: {
          protocol: "claude",
          baseURL: "http://127.0.0.1:8080",
          models: ["gpt-5.4"],
          discoverModels: false,
        },
        pricing,
        pricingSha256: "a".repeat(64),
        maxRunCostCNY: 1,
      }),
    /requires the OpenAI protocol/u,
  );
});
