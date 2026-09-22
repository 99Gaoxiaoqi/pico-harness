import { reportFixtureAttempt } from "../../fixtures/native-accounting.js";
import type { LLMProvider } from "@pico/core";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { CostTracker as RuntimeCostTracker } from "@pico/runtime/cost-tracker";
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

test("endpoint billing stays frozen through production tracking, SQLite reopen and dashboard projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-route-billing-"));
  let ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  t.after(async () => {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  });
  const usage = {
    promptTokens: 1000,
    completionTokens: 20,
    inputTokens: 600,
    cacheReadTokens: 400,
    reportedFields: ["prompt", "completion", "input", "cacheRead"] as const,
  };
  const provider: LLMProvider = {
    async generate(_messages, _tools, options) {
      await reportFixtureAttempt(options, "openai", "glm-5.2", usage);
      return { role: "assistant", content: "ok", usage };
    },
  };
  const route = billingRouteForProvider("openai", {
    model: "glm-5.2",
    baseURL: "https://opencode.ai/zen/go/v1",
  });
  // Even without capabilities or a resolver, a known model cannot borrow another endpoint's price.
  await new RuntimeCostTracker(provider, route, undefined, { ledger }).generate([], []);
  await new CostTracker(provider, route, undefined, { ledger }).generate([], []);
  await new CostTracker(provider, { ...route, billingMode: "subscription_included" }, undefined, {
    ledger,
  }).generate([], []);
  await new CostTracker(provider, { ...route, baseUrl: "https://opencode.ai/zen/v1" }, undefined, {
    ledger,
  }).generate([], []);
  const before = ledger.listPhysicalAttempts();
  assert.equal(before.length, 4);
  assert.equal(before.filter((row) => row.costStatus === "unknown").length, 2);
  assert.equal(before.filter((row) => row.costStatus === "included").length, 1);
  assert.equal(before.filter((row) => row.costStatus === "estimated").length, 1);
  assert.equal(before.find((row) => row.costStatus === "included")?.costCNY, 0);
  for (const row of before.filter((row) => row.costStatus === "unknown")) {
    assert.equal(row.route, route.baseUrl);
    assert.equal(row.pricingBasis, undefined);
    assert.equal(row.costCNY, undefined);
    assert.match(row.costUnknownReason!, /endpoint\/model 未匹配定价/);
  }
  ledger.close();
  ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  assert.deepEqual(ledger.listPhysicalAttempts(), before);
  const calls = ledger.listAccountingProviderCalls();
  assert.equal(calls.filter((row) => row.reported?.costUnknownReason).length, 2);
  const details = await buildUsageDashboard({
    createRuntimeEventReader: (storageRoot) => new SqliteRuntimeEventStore({ storageRoot }),
    sources: [{ workspacePath: root, storageRoot: root, calls }],
    // A newly configured display price must not reprice the historical unknown calls.
    pricing: [
      {
        provider: "openai",
        model: "glm-5.2",
        source: "configured",
        inputPerMillion: 1,
        outputPerMillion: 1,
        cacheReadPerMillion: 1,
        cacheWritePerMillion: 1,
      },
    ],
    unavailableWorkspaces: [],
  });
  assert.equal(details.activities.filter((row) => row.costStatus === "unknown").length, 2);
  assert.equal(details.activities.filter((row) => row.costStatus === "included").length, 1);
  assert.equal(details.activities.filter((row) => row.costStatus === "estimated").length, 1);
  assert.equal(details.knownCacheReadTokens, 1600);
  assert.equal(details.cacheReadReportedCallCount, 4);
  assert.equal(details.cacheWriteReportedCallCount, 0);
});
