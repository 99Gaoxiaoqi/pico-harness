import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FULL_COMPACTION_SUMMARY_MARKER } from "../../src/context/compaction-markers.js";
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
import { SqliteRuntimeControlStore } from "../../src/storage/sqlite/sqlite-runtime-control-store.js";
import { createEmptyUsageSnapshot } from "../../src/engine/session-runtime.js";
import type { ProviderCallRecord } from "../../src/tasks/runtime-types.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { WorkspaceRegistrationStore } from "../../src/daemon/workspace-registration.js";

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
  assert.equal(summary.coldStarts.byReason.initial_cold_request, 1);
  assert.equal(summary.coldStarts.byReason.prompt_revision, 1);
  assert.equal(summary.coldStarts.byReason.ttl_or_route_expiry_suspected, 1);

  const missingField = summarizeCacheEffectiveness([
    {
      ...providerCall("unknown", 2_000, 0, 0, stable),
      reported: { usageMetadata: "reported", reportedFields: ["prompt", "completion"] },
    },
  ]);
  assert.equal(missingField.requestHitRate, null);
  assert.equal(missingField.cacheReadTokens, null);
  assert.equal(missingField.uncachedInputTokens, null);
  assert.equal(missingField.promptTokenReuseRate, null);
  assert.equal(missingField.diagnostics.provider_not_reported, 1);
});

test("cache effectiveness stays unknown when an included call has no usage", () => {
  const diagnostic = diagnosePreparedProviderRequest(preparedCapture("stable"));
  const reported = providerCall("reported-hit", 100, 900, 0, diagnostic);
  const missingUsage = {
    ...providerCall("missing-usage", 0, 0, 0, diagnostic),
    reported: { usageMetadata: "unknown", requestDiagnostic: diagnostic },
  };

  const summary = summarizeCacheEffectiveness([reported, missingUsage]);
  assert.equal(summary.providerCallCount, 2);
  assert.equal(summary.usageReportedCallCount, 1);
  assert.equal(summary.cacheReadReportedCallCount, 1);
  assert.equal(summary.hitCallCount, 1);
  assert.equal(summary.requestHitRate, null);
  assert.equal(summary.cacheReadTokens, null);
  assert.equal(summary.uncachedInputTokens, null);
  assert.equal(summary.promptTokenReuseRate, null);
});

test("prompt-only compatibility usage does not masquerade as uncached input", () => {
  const diagnostic = diagnosePreparedProviderRequest(preparedCapture("stable"));
  const compatible = providerCall("compatible", 2_000, 0, 0, diagnostic);
  compatible.reported = {
    ...compatible.reported,
    reportedFields: ["prompt", "completion"],
  };

  const summary = summarizeCacheEffectiveness([compatible]);
  assert.equal(summary.usageReportedCallCount, 1);
  assert.equal(summary.cacheReadReportedCallCount, 0);
  assert.equal(summary.requestHitRate, null);
  assert.equal(summary.cacheReadTokens, null);
  assert.equal(summary.uncachedInputTokens, null);
  assert.equal(summary.promptTokenReuseRate, null);
});

test("cache effectiveness keeps zero-call, read-only, and write-only coverage explicit", () => {
  const empty = summarizeCacheEffectiveness([]);
  assert.equal(empty.providerCallCount, 0);
  assert.equal(empty.requestHitRate, null);
  assert.equal(empty.promptTokenReuseRate, null);
  assert.equal(empty.cacheReadTokens, null);
  assert.equal(empty.cacheWriteTokens, null);
  assert.equal(empty.uncachedInputTokens, null);

  const diagnostic = diagnosePreparedProviderRequest(preparedCapture("first"));
  const readOnlyCall = providerCall("read-only", 100, 900, 0, diagnostic);
  readOnlyCall.reported = {
    ...readOnlyCall.reported,
    reportedFields: ["prompt", "completion", "cacheRead"],
  };
  const readOnly = summarizeCacheEffectiveness([readOnlyCall]);
  assert.equal(readOnly.requestHitRate, 1);
  assert.equal(readOnly.cacheReadTokens, 900);
  assert.equal(readOnly.cacheWriteTokens, null);
  assert.equal(readOnly.promptTokenReuseRate, 0.9);
  assert.equal(readOnly.cacheReadToWriteRatio, null);

  const writeOnlyCall = providerCall("write-only", 100, 0, 900, diagnostic);
  writeOnlyCall.reported = {
    ...writeOnlyCall.reported,
    reportedFields: ["prompt", "completion", "input", "cacheWrite"],
  };
  const writeOnly = summarizeCacheEffectiveness([writeOnlyCall]);
  assert.equal(writeOnly.requestHitRate, null);
  assert.equal(writeOnly.cacheReadTokens, null);
  assert.equal(writeOnly.cacheWriteTokens, 900);
  assert.equal(writeOnly.promptTokenReuseRate, null);
  assert.equal(writeOnly.cacheReadToWriteRatio, null);
});

test("a large first cold request is not misclassified as TTL or route failure", () => {
  const first = providerCall(
    "first-large",
    3_000,
    0,
    0,
    diagnosePreparedProviderRequest(preparedCapture("first")),
  );
  const summary = summarizeCacheEffectiveness([first]);

  assert.equal(summary.diagnostics.ttl_or_route_suspected, 0);
  assert.equal(summary.coldStarts.byReason.initial_cold_request, 1);
});

test("cache minimum diagnostics use model-specific official thresholds", () => {
  const stable = diagnosePreparedProviderRequest(
    preparedCapture("stable"),
    preparedCapture("first"),
  );
  const opus = {
    ...providerCall("opus-short", 1_500, 0, 0, stable),
    model: "claude-opus-4-6",
  };
  const haiku = {
    ...providerCall("haiku-short", 1_500, 0, 0, stable),
    model: "claude-haiku-4-5",
  };
  const sonnet = {
    ...providerCall("sonnet-long-enough", 1_500, 0, 0, stable),
    model: "claude-sonnet-4-6",
  };
  const unknown = {
    ...providerCall("unknown-model", 1_500, 0, 0, stable),
    model: "compatible-unknown",
  };

  const summary = summarizeCacheEffectiveness([opus, haiku, sonnet, unknown]);
  assert.equal(summary.diagnostics.prompt_below_minimum_threshold, 2);
  assert.equal(summary.diagnostics.ttl_or_route_suspected, 1);
});

test("cache operations emit advisory alerts without changing policy", () => {
  const first = preparedCapture("first");
  const changed = diagnosePreparedProviderRequest(preparedCapture("changed"), first);
  const calls = Array.from({ length: 4 }, (_, index) =>
    providerCall(`cold-${index}`, 2_000, 0, 600, changed),
  );

  const summary = summarizeCacheEffectiveness(calls);
  assert.deepEqual(
    new Set(summary.operationalAlerts.map((alert) => alert.kind)),
    new Set(["cache_write_dominates", "route_zero_hits", "prefix_stability_declining"]),
  );
  assert.ok(
    summary.operationalAlerts.every((alert) => !("action" in alert) && !("newPolicy" in alert)),
  );
});

test("model-switch cold starts are counted within a session, not across interleaved sessions", () => {
  const stable = diagnosePreparedProviderRequest(
    preparedCapture("stable"),
    preparedCapture("first"),
  );
  const calls = [
    { ...providerCall("a-1", 2_000, 0, 0, stable), sessionId: "a", createdAt: 1, model: "m1" },
    { ...providerCall("b-1", 2_000, 0, 0, stable), sessionId: "b", createdAt: 2, model: "m2" },
    { ...providerCall("a-2", 2_000, 0, 0, stable), sessionId: "a", createdAt: 3, model: "m1" },
    { ...providerCall("a-3", 2_000, 0, 0, stable), sessionId: "a", createdAt: 4, model: "m2" },
  ];

  assert.equal(summarizeCacheEffectiveness(calls).coldStarts.byReason.model_switch, 1);
});

test("model-switch diagnostics do not interleave independent jobs in one session", () => {
  const stable = diagnosePreparedProviderRequest(
    preparedCapture("stable"),
    preparedCapture("first"),
  );
  const calls = [
    {
      ...providerCall("job-a-1", 2_000, 0, 0, stable),
      sessionId: "shared",
      jobId: "job-a",
      createdAt: 1,
      model: "m1",
    },
    {
      ...providerCall("job-b-1", 2_000, 0, 0, stable),
      sessionId: "shared",
      jobId: "job-b",
      createdAt: 2,
      model: "m2",
    },
    {
      ...providerCall("job-a-2", 2_000, 0, 0, stable),
      sessionId: "shared",
      jobId: "job-a",
      createdAt: 3,
      model: "m1",
    },
    {
      ...providerCall("job-b-2", 2_000, 0, 0, stable),
      sessionId: "shared",
      jobId: "job-b",
      createdAt: 4,
      model: "m2",
    },
  ];

  assert.equal(summarizeCacheEffectiveness(calls).coldStarts.byReason.model_switch, 0);
});

test("OpenAI explicit tool changes are classified as tool revisions, not prompt revisions", () => {
  const prepared = (description: string) =>
    capturePreparedProviderRequest({
      provider: "openai",
      model: "gpt-5.6-terra",
      body: {
        model: "gpt-5.6-terra",
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        tools: [{ type: "function", function: { name: "lookup", description } }],
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "PRIVATE_STABLE_SYSTEM",
                prompt_cache_breakpoint: { mode: "explicit" },
              },
            ],
          },
          { role: "user", content: "PRIVATE_TAIL" },
        ],
      },
    });
  const first = prepared("stable");
  const changed = diagnosePreparedProviderRequest(prepared("changed"), first);
  const summary = summarizeCacheEffectiveness([
    providerCall("explicit-tool-change", 2_000, 0, 0, changed),
  ]);

  assert.equal(summary.firstChangedLayer.tools, 1);
  assert.equal(summary.firstChangedLayer["tools+system"], 0);
  assert.equal(summary.coldStarts.byReason.tool_disclosure_or_schema_revision, 1);
  assert.equal(summary.coldStarts.byReason.prompt_revision, 0);
});

test("explicit full-compaction markers take precedence over generic history rewrites", () => {
  const capture = (history: string) =>
    capturePreparedProviderRequest({
      provider: "openai",
      model: "gpt-5.6-terra",
      body: {
        model: "gpt-5.6-terra",
        messages: [
          { role: "system", content: "stable system" },
          { role: "assistant", content: history },
          { role: "user", content: "latest question" },
        ],
      },
    });
  const prior = capture("ordinary history");
  const changed = diagnosePreparedProviderRequest(
    capture(`${FULL_COMPACTION_SUMMARY_MARKER} PRIVATE_COMPACTION_SUMMARY`),
    prior,
  );
  const summary = summarizeCacheEffectiveness([
    providerCall("full-compaction", 2_000, 0, 0, changed),
  ]);

  assert.equal(summary.coldStarts.byReason.full_compaction_or_history_rewrite, 1);
  assert.equal(summary.coldStarts.byReason.prompt_revision, 0);
  assert.doesNotMatch(JSON.stringify(changed), /PRIVATE_COMPACTION_SUMMARY/u);
});

test("usage.get excludes baselines from cache ratios and honors the call time range", async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "pico-cache-effectiveness-"));
  const picoHome = join(workspacePath, "pico-home");
  const env = { PICO_HOME: picoHome };
  const store = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(workspacePath, { picoHome }).workspace.root,
  });
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
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(await trustStore.canonicalize(workspacePath));
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  context.after(async () => {
    await desktop.close();
    await rm(workspacePath, { recursive: true, force: true });
  });

  const all = asRecord(await desktop.handle(createRuntimeRequest("usage.get", { workspacePath })));
  const allUsage = asRecord(all["usage"]);
  const allCache = asRecord(allUsage["cache"]);
  assert.equal(asRecord(allUsage["total"])["inputTokens"], 103_071);
  assert.equal(
    asRecord(allUsage["total"])["totalTokens"],
    203_674,
    "总 Token 必须包含未缓存输入、缓存读写与输出，不重复计入 reasoning",
  );
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

test("global usage.get returns trusted records plus explicit partial failures", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-global-usage-partial-"));
  const picoHome = join(root, "pico-home");
  const healthyWorkspace = join(root, "healthy");
  const brokenWorkspace = join(root, "broken");
  const untrustedWorkspace = join(root, "untrusted");
  await Promise.all([
    mkdir(healthyWorkspace, { recursive: true }),
    mkdir(brokenWorkspace, { recursive: true }),
    mkdir(untrustedWorkspace, { recursive: true }),
  ]);

  const env = { PICO_HOME: picoHome };
  const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const registeredWorkspaces = await Promise.all(
    [healthyWorkspace, brokenWorkspace, untrustedWorkspace].map((workspacePath) =>
      registrationStore.register(workspacePath),
    ),
  );
  await trustStore.trust(await trustStore.canonicalize(healthyWorkspace));
  await trustStore.trust(await trustStore.canonicalize(brokenWorkspace));

  const healthyStore = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(healthyWorkspace, { picoHome }).workspace.root,
  });
  healthyStore.recordProviderCall(
    providerCall(
      "healthy",
      100,
      900,
      50,
      diagnosePreparedProviderRequest(preparedCapture("stable")),
    ),
  );
  healthyStore.close();

  const brokenStorage = resolvePicoPaths(brokenWorkspace, { picoHome }).workspace.root;
  await mkdir(resolvePicoPaths(brokenWorkspace, { picoHome }).home.workspaces, {
    recursive: true,
  });
  await writeFile(brokenStorage, "not-a-directory", "utf8");

  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    registrationStore,
    trustStore,
    env,
  });
  context.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = asRecord(await desktop.handle(createRuntimeRequest("usage.get", {})));
  const usage = asRecord(result["usage"]);
  assert.equal(usage["providerCallCount"], 1);
  assert.equal(asRecord(usage["total"])["totalTokens"], 1_051);
  const unavailable = usage["unavailableWorkspaces"];
  assert.ok(Array.isArray(unavailable));
  assert.equal(unavailable.length, 2);
  assert.deepEqual(
    new Set(unavailable.map((item) => asRecord(item)["workspacePath"])),
    new Set([registeredWorkspaces[1], registeredWorkspaces[2]]),
  );
});

test("Desktop usage parser reads canonical cache fields and preserves zero values", () => {
  assert.deepEqual(
    parseUsage({
      usage: {
        total: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 5 },
        cache: {
          cacheReadTokens: 0,
          cacheWriteTokens: 5,
          uncachedInputTokens: 10,
          requestHitRate: 0,
          promptTokenReuseRate: 0,
          cacheReadToWriteRatio: 0,
          operationalAlerts: [
            { kind: "route_zero_hits", message: "缓存路由连续零命中", evidence: {} },
          ],
        },
      },
    }),
    {
      totalTokens: undefined,
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: undefined,
      cacheReadTokens: 0,
      cacheWriteTokens: 5,
      uncachedInputTokens: 10,
      cachedTokens: 0,
      cacheRequestHitRate: 0,
      cachePromptTokenReuseRate: 0,
      cacheReadToWriteRatio: 0,
      cacheAlerts: ["缓存路由连续零命中"],
      costCNY: undefined,
      costStatus: undefined,
      providerCallCount: undefined,
      usageReportCount: undefined,
      baselineCount: undefined,
      scope: undefined,
      workspacePath: undefined,
      unavailableWorkspaceCount: undefined,
      period: "",
    },
  );

  const baselineSeparated = parseUsage({
    usage: {
      total: { inputTokens: 10_000, cacheReadTokens: 9_000, cacheWriteTokens: 8_000 },
      cache: { cacheReadTokens: 50, cacheWriteTokens: 25, requestHitRate: 0.5 },
    },
  });
  assert.equal(baselineSeparated.cacheReadTokens, 50);
  assert.equal(baselineSeparated.cacheWriteTokens, 25);
});

test("/model usage reports session cache hit and token ratios", () => {
  const usage = {
    ...createEmptyUsageSnapshot(),
    totalProviderCalls: 2,
    totalUsageReports: 2,
    totalInputReports: 2,
    totalCacheReadReports: 2,
    totalCacheHitCalls: 1,
    totalCacheWriteReports: 2,
    totalInputTokens: 800,
    totalCacheReadTokens: 1_000,
    totalCacheWriteTokens: 200,
    totalPromptTokens: 2_000,
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
  assert.equal(report.cache.requestHitRate, 0.5);
  assert.equal(report.cache.promptTokenReuseRate, 0.5);
  assert.equal(report.cache.cacheReadToWriteRatio, 5);
  assert.match(formatModelUsageReport(report), /Cache request hit rate: 50\.0%/u);

  const readOnlyReport = createModelUsageReport(
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
    {
      ...usage,
      totalCacheWriteReports: 0,
      totalCacheWriteTokens: 0,
      totalPromptTokens: 1_800,
    },
  );
  assert.equal(readOnlyReport.cache.promptTokenReuseRate, 1_000 / 1_800);
  assert.equal(readOnlyReport.cache.cacheReadToWriteRatio, null);

  assert.equal(
    createModelUsageReport(
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
      {
        ...usage,
        totalProviderCalls: 3,
        totalUsageReports: 2,
      },
    ).cache.requestHitRate,
    null,
    "missing provider usage must keep the request hit rate unknown",
  );

  assert.equal(
    createModelUsageReport(
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
      { ...usage, totalCacheHitCalls: null },
    ).cache.requestHitRate,
    null,
    "legacy snapshots without a hit-call counter must not be reported as zero percent",
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
    model: "claude-sonnet-4-6",
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
