import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseUsage } from "../../apps/desktop/src/renderer/runtime.js";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import {
  capturePreparedProviderRequest,
  diagnosePreparedProviderRequest,
} from "../../src/observability/provider-request-diagnostics.js";
import { summarizeCacheEffectiveness } from "../../src/observability/cache-effectiveness.js";
import {
  createModelUsageReport,
  formatModelUsageReport,
} from "../../src/provider/model-runtime-report.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import { createEmptyUsageSnapshot } from "../../src/engine/session-runtime.js";
import type { ProviderCallRecord } from "../../src/tasks/runtime-types.js";

test("cache effectiveness only uses detailed calls for ratios and classifies cache misses", () => {
  const firstCapture = preparedCapture("first");
  const first = diagnosePreparedProviderRequest(firstCapture);
  const stable = diagnosePreparedProviderRequest(preparedCapture("stable"), firstCapture);
  const changed = diagnosePreparedProviderRequest(preparedCapture("changed"), firstCapture);
  const calls = [
    providerCall("short", 500, 0, 0, first),
    providerCall("hit", 1_000, 100, 50, stable),
    providerCall("changed", 3_000, 0, 0, changed),
    providerCall("suspected", 3_000, 0, 0, stable),
    providerCall("unsupported", 3_000, 0, 0, stable, { cacheSupport: "unsupported" }),
  ];

  const summary = summarizeCacheEffectiveness(calls);
  assert.equal(summary.providerCallCount, 5);
  assert.equal(summary.cacheReadReportedCallCount, 5);
  assert.equal(summary.hitCallCount, 1);
  assert.equal(summary.requestHitRate, 0.2);
  assert.equal(summary.cacheReadTokens, 100);
  assert.equal(summary.cacheWriteTokens, 50);
  assert.equal(summary.uncachedInputTokens, 10_500);
  assert.equal(summary.promptTokenReuseRate, 100 / 10_650);
  assert.equal(summary.cacheReadToWriteRatio, 2);
  assert.equal(summary.diagnostics.prompt_below_minimum_threshold, 1);
  assert.equal(summary.diagnostics.stable_prefix_changed, 1);
  assert.equal(summary.diagnostics.ttl_or_route_suspected, 1);
  assert.equal(summary.diagnostics.protocol_unsupported, 1);
  assert.equal(summary.prefixStability.tools.stabilityRate, 1);
  assert.equal(summary.prefixStability["tools+system"].changed, 1);
  assert.equal(summary.firstChangedLayer["tools+system"], 1);

  const missingField = summarizeCacheEffectiveness([
    {
      ...providerCall("unknown", 2_000, 0, 0, stable),
      reported: { usageMetadata: "reported", reportedFields: ["prompt", "completion"] },
    },
  ]);
  assert.equal(missingField.requestHitRate, null);
  assert.equal(missingField.cacheReadTokens, null);
  assert.equal(missingField.diagnostics.provider_not_reported, 1);
});

test("usage.get excludes baselines from cache ratios and honors the call time range", async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "pico-cache-effectiveness-"));
  const picoHome = join(workspacePath, "pico-home");
  const env = { PICO_HOME: picoHome };
  const store = new RuntimeStore({ workDir: workspacePath, picoHome });
  store.recordProviderCall({
    ...providerCall(
      "old",
      1_024,
      500,
      100,
      diagnosePreparedProviderRequest(preparedCapture("old")),
    ),
    createdAt: 1_000,
  });
  store.recordProviderCall({
    ...providerCall("new", 2_048, 0, 0, diagnosePreparedProviderRequest(preparedCapture("new"))),
    createdAt: 2_000,
  });
  store.putUsageBaseline({
    baselineId: "baseline",
    inputTokens: 99_999,
    outputTokens: 1,
    cacheReadTokens: 99_999,
    cacheWriteTokens: 1,
    cost: 0,
    importedAt: 3_000,
  });
  store.close();

  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, env });
  context.after(async () => {
    await desktop.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const all = asRecord(await desktop.handle(createRuntimeRequest("usage.get", { workspacePath })));
  const allUsage = asRecord(all["usage"]);
  const allCache = asRecord(allUsage["cache"]);
  assert.equal(asRecord(allUsage["total"])["inputTokens"], 103_071);
  assert.equal(allCache["cacheReadTokens"], 500);
  assert.equal(allCache["requestHitRate"], 0.5);
  assert.equal(allCache["source"], "provider_calls_only");

  const range = asRecord(
    await desktop.handle(createRuntimeRequest("usage.get", { workspacePath, from: 1_500 })),
  );
  const rangeUsage = asRecord(range["usage"]);
  assert.equal(rangeUsage["baselineCount"], 0);
  assert.equal(rangeUsage["providerCallCount"], 1);
  assert.equal(asRecord(rangeUsage["cache"])["requestHitRate"], 0);
});

test("Desktop usage parser reads canonical cache fields and preserves zero values", () => {
  assert.deepEqual(
    parseUsage({
      usage: {
        total: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 5 },
        cache: {
          uncachedInputTokens: 10,
          requestHitRate: 0,
          promptTokenReuseRate: 0,
          cacheReadToWriteRatio: 0,
        },
      },
    }),
    {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 5,
      uncachedInputTokens: 10,
      cachedTokens: 0,
      cacheRequestHitRate: 0,
      cachePromptTokenReuseRate: 0,
      cacheReadToWriteRatio: 0,
      cost: undefined,
      period: "",
    },
  );
});

test("/model usage keeps unavailable request hit rate explicit and reports cache ratios", () => {
  const usage = {
    ...createEmptyUsageSnapshot(),
    totalProviderCalls: 2,
    totalUsageReports: 2,
    totalInputReports: 2,
    totalCacheReadReports: 2,
    totalCacheWriteReports: 2,
    totalInputTokens: 800,
    totalCacheReadTokens: 1_000,
    totalCacheWriteTokens: 200,
  };
  const report = createModelUsageReport(
    {
      id: "openai/cache-test",
      providerId: "openai",
      provider: "openai",
      model: "cache-test",
      baseURL: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      source: "config",
      capabilities: resolveModelRouteCapabilities("openai", "cache-test", undefined),
    },
    usage,
  );
  assert.equal(report.cache.requestHitRate, null);
  assert.equal(report.cache.promptTokenReuseRate, 0.5);
  assert.equal(report.cache.cacheReadToWriteRatio, 5);
  assert.match(
    formatModelUsageReport(report),
    /Cache request hit rate: unavailable \(requires provider_calls ledger\)/u,
  );
});

function providerCall(
  callId: string,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  requestDiagnostic: object,
  extraReported: Record<string, unknown> = {},
): ProviderCallRecord {
  return {
    callId,
    purpose: "main",
    provider: "claude",
    model: "cache-test",
    status: "succeeded",
    inputTokens,
    outputTokens: 1,
    cacheReadTokens,
    cacheWriteTokens,
    cost: 0,
    createdAt: 0,
    reported: {
      usageMetadata: "reported",
      reportedFields: ["prompt", "completion", "input", "cacheRead", "cacheWrite"],
      requestDiagnostic,
      ...extraReported,
    },
  };
}

function preparedCapture(variant: "first" | "stable" | "changed" | "old" | "new") {
  const system = variant === "changed" ? "changed system" : "stable system";
  const current = capturePreparedProviderRequest({
    provider: "claude",
    model: "cache-test",
    body: {
      model: "cache-test",
      tools: [
        {
          name: "read_file",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }],
        },
      ],
    },
  });
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}
