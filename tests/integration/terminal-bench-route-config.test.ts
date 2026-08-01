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

for (const model of ["gpt-5.4", "gpt-5.6-terra"] as const) {
  test(`Terminal-Bench pins the exact ${model} output capability in its route config`, () => {
    const provider = {
      protocol: "openai",
      baseURL: "http://127.0.0.1:8080",
      apiKeyEnv: "PICO_TB_PROVIDER_API_KEY",
      models: [model],
      discoverModels: false,
      modelCapabilities: {
        [model]: {
          toolCall: true,
          output: 4096,
          outputTokenField: "max_tokens",
        },
      },
    };

    const route = buildBenchmarkRouteConfig({
      modelRouteId: `codex-oauth/${model}`,
      providerId: "codex-oauth",
      model,
      provider,
      pricing: { ...pricing, model },
      pricingSha256: "a".repeat(64),
      maxRunCostCNY: 890,
      thinkingEffort: "medium",
    });

    assert.equal(route.provider.modelCapabilities[model].outputTokenField, "max_completion_tokens");
    assert.equal(route.provider.modelCapabilities[model].output, 8192);
    assert.equal(route.provider.modelCapabilities[model].toolCall, true);
    assert.equal(route.runBudget.maxCostMicroCNY, 890_000_000);
    assert.equal(route.thinkingEffort, "medium");
    assert.equal(provider.modelCapabilities[model]?.output, 4096);
    assert.equal(provider.modelCapabilities[model]?.outputTokenField, "max_tokens");
  });
}

test("Terminal-Bench does not generalize the output override to other routes", () => {
  for (const { providerId, model } of [
    { providerId: "another-provider", model: "gpt-5.4" },
    { providerId: "codex-oauth", model: "gpt-5.6-terra-fast" },
    { providerId: "codex-oauth", model: "gpt-5.6-sol" },
  ]) {
    const provider = {
      protocol: "openai",
      baseURL: "http://127.0.0.1:8080",
      apiKeyEnv: "PICO_TB_PROVIDER_API_KEY",
      models: [model],
      discoverModels: false,
      modelCapabilities: {
        [model]: {
          output: 4096,
          outputTokenField: "max_tokens",
        },
      },
    };

    const route = buildBenchmarkRouteConfig({
      modelRouteId: `${providerId}/${model}`,
      providerId,
      model,
      provider,
      pricing: { ...pricing, providerId, model },
      pricingSha256: "a".repeat(64),
      maxRunCostCNY: 1,
    });

    assert.deepEqual(route.provider, provider);
  }
});

test("Terminal-Bench rejects the pinned route when its protocol cannot carry the field", () => {
  for (const model of ["gpt-5.4", "gpt-5.6-terra"] as const) {
    assert.throws(
      () =>
        buildBenchmarkRouteConfig({
          modelRouteId: `codex-oauth/${model}`,
          providerId: "codex-oauth",
          model,
          provider: {
            protocol: "claude",
            baseURL: "http://127.0.0.1:8080",
            models: [model],
            discoverModels: false,
          },
          pricing: { ...pricing, model },
          pricingSha256: "a".repeat(64),
          maxRunCostCNY: 1,
        }),
      /requires the OpenAI protocol/u,
    );
  }
});
