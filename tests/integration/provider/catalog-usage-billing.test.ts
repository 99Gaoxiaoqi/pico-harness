import { reportFixtureAttempt } from "../../fixtures/native-accounting.js";
import type { LLMProvider } from "@pico/core";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { catalogPricing, MODEL_PRICING } from "@pico/pico-host/catalog-pricing";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { billingRouteForProvider } from "@pico/runtime/provider-billing-route";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { buildUsageDashboard } from "@pico/pico-host";
import { usagePricing } from "@pico/pico-host";

test("catalog and override pricing are recorded per call and projected without pricing custom gateways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-catalog-billing-"));
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const capabilities = resolveModelRouteCapabilities("openai", "gpt-4o", undefined);
  const config = {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o",
    apiKey: "unused",
    capabilities,
  };
  const provider: LLMProvider = {
    async generate(_messages, _tools, options) {
      await reportFixtureAttempt(options, "openai", "gpt-4o", {
        promptTokens: 1000000,
        completionTokens: 1000000,
        inputTokens: 1000000,
        reportedFields: ["prompt", "completion", "input"],
      });
      return {
        role: "assistant" as const,
        content: "ok",
        usage: {
          promptTokens: 1000000,
          completionTokens: 1000000,
          inputTokens: 1000000,
          outputTokens: 1000000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      };
    },
  };
  await new CostTracker(provider, billingRouteForProvider("openai", config), undefined, {
    ledger,
  }).generate([], []);
  await new CostTracker(
    provider,
    billingRouteForProvider("openai", { ...config, baseURL: "https://custom.example/v1" }),
    undefined,
    { ledger },
  ).generate([], []);
  await new CostTracker(
    provider,
    billingRouteForProvider("openai", {
      ...config,
      capabilities: {
        ...capabilities,
        price: {
          currency: "USD",
          source: "config",
          inputPerMillion: 1,
          outputPerMillion: 2,
          cacheReadPerMillion: 0,
          cacheWritePerMillion: 0,
        },
      },
    }),
    undefined,
    { ledger },
  ).generate([], []);
  const calls = ledger.listAccountingProviderCalls();
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((c) => c.reported?.costStatus === "estimated").length, 2);
  assert.equal(calls.filter((c) => c.reported?.costStatus === "unknown").length, 1);
  assert.ok(calls.some((c) => Math.abs(c.cost - 21.6) < 1e-9));
  const details = await buildUsageDashboard({
    createRuntimeEventReader: (storageRoot) => new SqliteRuntimeEventStore({ storageRoot }),
    sources: [{ workspacePath: root, storageRoot: root, calls }],
    pricing: usagePricing({}, MODEL_PRICING),
    unavailableWorkspaces: [],
  });
  assert.equal(details.activities.filter((a) => a.costStatus === "estimated").length, 2);
  assert.ok(details.pricing.some((p) => p.provider === "openai" && p.model === "gpt-4o"));
  const deepseek = {
    provider: "openai",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
  };
  assert.equal(catalogPricing(deepseek, Date.parse("2026-09-07T01:00:00Z"))?.inputPerMillion, 0.44);
  assert.equal(catalogPricing(deepseek, Date.parse("2026-09-07T04:00:00Z"))?.inputPerMillion, 0.22);
});
