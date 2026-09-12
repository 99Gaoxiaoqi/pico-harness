import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveModelRouteCapabilities } from "../../../src/provider/model-capabilities.js";
import { OpenAIRequestPolicy } from "../../../src/provider/openai-request-policy.js";

test("Provider reasoning only follows the current route capability profile", () => {
  const withoutRouteCapabilities = new OpenAIRequestPolicy({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "custom-model",
    thinkingEffort: "high",
  });
  assert.deepEqual(withoutRouteCapabilities.finalizeRequestBody({}, [], []), {});

  const withRouteCapabilities = new OpenAIRequestPolicy({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "custom-model",
    thinkingEffort: "high",
    capabilities: resolveModelRouteCapabilities("openai", "custom-model", {
      reasoning: {
        enabled: true,
        defaultLevel: "high",
        levels: ["high"],
        providerOptionsByLevel: {
          high: { openai: { set: [{ path: ["reasoning_effort"], value: "high" }] } },
        },
      },
    }),
  });
  assert.deepEqual(withRouteCapabilities.finalizeRequestBody({}, [], []), {
    reasoning_effort: "high",
  });
});
