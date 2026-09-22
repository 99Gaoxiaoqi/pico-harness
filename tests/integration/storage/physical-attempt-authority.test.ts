import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PhysicalAttemptRecord } from "@pico/storage/runtime-control-types";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { CostTracker } from "@pico/runtime/cost-tracker";
import type { LLMProvider, ProviderAttemptLifecycleSnapshot } from "@pico/core";

const snapshot: ProviderAttemptLifecycleSnapshot = {
  physicalAttemptId: "physical-1",
  revision: 0,
  attempt: 1,
  provider: "openai",
  model: "test",
  startedAt: "2026-09-22T00:00:00.000Z",
  status: "prepared",
  usageBasis: "missing",
};
function record(ownerId: string): PhysicalAttemptRecord {
  return {
    ...snapshot,
    accountingVersion: 1,
    accountingSource: "physical",
    providerCallId: "call-1",
    logicalCallId: "logical-1",
    ownerId,
    sessionId: "session-1",
    runId: "run-1",
    purpose: "main",
    retryAttempt: 0,
    costStatus: "unknown",
    pricingVersion: "test-v1",
  };
}

test("durable revisions replace usage, preserve cancellation, fence owners, and cannot resurrect deleted sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-meter-authority-"));
  const store = new SqliteRuntimeControlStore({ storageRoot: root });
  const events = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    await events.initializeSession({ sessionId: "session-1", workDir: root });
    const prepared = record(store.beginPhysicalAttemptOwner());
    store.recordPhysicalAttempt(prepared);
    const reader = new SqliteRuntimeControlStore({ storageRoot: root });
    assert.equal(reader.recoverPhysicalAttempts(), 0, "active writer cannot be recovered");
    assert.throws(() => reader.recordPhysicalAttempt({ ...prepared, revision: 1 }), /fenced/);
    reader.close();
    const cancelled: PhysicalAttemptRecord = {
      ...prepared,
      revision: 1,
      status: "cancelled",
      completedAt: "2026-09-22T00:00:01.000Z",
    };
    store.recordPhysicalAttempt(cancelled);
    const late: PhysicalAttemptRecord = {
      ...cancelled,
      revision: 2,
      usageBasis: "reported",
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        cacheReadTokens: 2,
        reportedFields: ["prompt", "completion", "cacheRead"],
      },
      costCNY: 0.02,
      costStatus: "estimated",
    };
    store.recordPhysicalAttempt(late);
    assert.equal(store.recordPhysicalAttempt(late).updated, false);
    assert.equal(store.recordPhysicalAttempt(cancelled).updated, false);
    assert.throws(() => store.recordPhysicalAttempt({ ...late, costCNY: 1 }), /Conflicting/);
    assert.throws(
      () => store.recordPhysicalAttempt({ ...late, revision: 3, sessionId: "other" }),
      /immutable/,
    );
    assert.throws(
      () => store.recordPhysicalAttempt({ ...late, revision: 3, status: "succeeded" }),
      /Cancelled/,
    );
    store.recordProviderCall({
      callId: "call-1",
      sessionId: "session-1",
      purpose: "main",
      provider: "openai",
      model: "test",
      status: "cancelled",
      inputTokens: 999,
      outputTokens: 999,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 999,
    });
    const totals = store.getUsageSummary({ sessionId: "session-1" });
    assert.equal(totals.providerCallCount, 1);
    assert.deepEqual(totals.total, {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      cost: 0.02,
    });
    assert.equal(store.getAccountingSessionUsage("session-1")?.totalPromptTokens, 12);
    await events.deleteSession("session-1");
    assert.throws(() => store.recordPhysicalAttempt({ ...late, revision: 3 }), /deleted/);
    assert.equal(store.listPhysicalAttempts({ sessionId: "session-1" }).length, 0);
    assert.equal(
      store.getUsageSummary().total.inputTokens,
      10,
      "detached history keeps native precedence",
    );
  } finally {
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGKILL after prepared or observed retains committed facts; readers do not recover and writers never replay HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-meter-kill-"));
  try {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { SqliteRuntimeControlStore } from '@pico/storage/sqlite/sqlite-runtime-control-store';
      const s = new SqliteRuntimeControlStore({storageRoot: ${JSON.stringify(root)}});
      const base = ${JSON.stringify(record("unused"))}; base.ownerId = s.beginPhysicalAttemptOwner();
      s.recordPhysicalAttempt(base);
      s.recordPhysicalAttempt({...base, physicalAttemptId:'completed-first', providerCallId:'call-first'});
      s.recordPhysicalAttempt({...base, physicalAttemptId:'completed-first', providerCallId:'call-first', revision:1, status:'succeeded', usageBasis:'reported', usage:{promptTokens:3, completionTokens:1}});
      s.recordPhysicalAttempt({...base, physicalAttemptId:'physical-2', providerCallId:'call-2'});
      s.recordPhysicalAttempt({...base, physicalAttemptId:'physical-2', providerCallId:'call-2', revision:1, status:'observed', httpStatus:200});
      console.log('ready'); setInterval(()=>{},1000);
    `,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    const reader = new SqliteRuntimeControlStore({ storageRoot: root });
    assert.deepEqual(
      reader.listPhysicalAttempts().map((r) => r.status),
      ["succeeded", "prepared", "observed"],
    );
    assert.equal(reader.recoverPhysicalAttempts(), 2);
    assert.equal(reader.recoverPhysicalAttempts(), 0);
    assert.deepEqual(
      reader.listPhysicalAttempts().map((r) => r.status),
      ["succeeded", "interrupted", "interrupted"],
    );
    assert.deepEqual(
      reader.listPhysicalAttempts().map((r) => r.httpStatus),
      [undefined, undefined, 200],
    );
    assert.equal(reader.getUsageSummary().total.cost, 0);
    reader.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CostTracker awaits admission, freezes attribution for late revisions, and leaves successful response intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-meter-tracker-"));
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  let dispatched = 0;
  let late: ((snapshot: ProviderAttemptLifecycleSnapshot) => Promise<void>) | undefined;
  const provider: LLMProvider = {
    async generate(_messages, _tools, options) {
      await options?.onProviderAttemptStart?.(snapshot);
      dispatched++;
      late = options?.onProviderAttemptUpdate;
      await late?.({ ...snapshot, revision: 1, status: "cancelled" });
      return { role: "assistant", content: "answer" };
    },
  };
  const notices: string[] = [];
  let sessionId = "original";
  const tracker = new CostTracker(provider, "test", undefined, {
    ledger,
    context: () => ({ purpose: "main", sessionId }),
    onAccountingChanged(record) {
      notices.push(record.sessionId!);
      throw new Error("notification unavailable");
    },
    recordRuntimeEvents: false,
  });
  try {
    assert.equal((await tracker.generate([], [])).content, "answer");
    sessionId = "next";
    await late?.({
      ...snapshot,
      revision: 2,
      status: "cancelled",
      usageBasis: "reported",
      usage: { promptTokens: 5, completionTokens: 2 },
    });
    assert.equal(ledger.listPhysicalAttempts({ sessionId: "original" })[0]?.usage?.promptTokens, 5);
    assert.equal(ledger.listPhysicalAttempts({ sessionId: "next" }).length, 0);
    assert.deepEqual(notices, ["original", "original", "original"]);
    const failing = new CostTracker(provider, "test", undefined, {
      ledger: {
        recordProviderCall: ledger.recordProviderCall.bind(ledger),
        beginPhysicalAttemptOwner: () => "owner",
        recordPhysicalAttempt() {
          throw new Error("disk full");
        },
      },
      recordRuntimeEvents: false,
    });
    await assert.rejects(failing.generate([], []), /disk full/);
    assert.equal(dispatched, 1, "failed admission sends zero additional requests");
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy embedded evidence and empty coverage outrank logical totals before and after repeated migration", async () => {
  const { Session } = await import("@pico/pico-host/session");
  const { RuntimeRun } = await import("@pico/pico-host/product-runtime-run");
  const { createEngineRuntimePort } = await import("@pico/pico-host/engine-runtime-port-adapter");
  const root = await mkdtemp(join(tmpdir(), "pico-meter-legacy-"));
  const session = new Session("legacy", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimeStorageRoot: root,
    runtimePort: createEngineRuntimePort(),
  });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await session.recover();
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      for (const callId of ["legacy-call", "empty-call"]) {
        await run.recordModelCallStarted({ providerCallId: callId, purpose: "main" });
        await run.recordModelCallSettled({
          providerCallId: callId,
          status: "succeeded",
          latencyMs: 1,
          attempts:
            callId === "empty-call"
              ? []
              : [
                  {
                    attemptId: "old-physical",
                    attempt: 1,
                    provider: "openai",
                    model: "test",
                    startedAt: snapshot.startedAt,
                    completedAt: snapshot.startedAt,
                    status: "succeeded",
                    latencyMs: 1,
                    usageBasis: "reported",
                    usage: { promptTokens: 7, completionTokens: 2 },
                    costCNY: 0.1,
                    costStatus: "estimated",
                  },
                ],
          attemptCoverage: "partial",
        });
        ledger.recordProviderCall({
          callId,
          sessionId: session.id,
          purpose: "main",
          provider: "openai",
          model: "test",
          status: "succeeded",
          inputTokens: 999,
          outputTokens: 999,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 999,
        });
      }
    });
    assert.equal(ledger.getUsageSummary({ sessionId: session.id }).total.inputTokens, 7);
    assert.equal(ledger.migrateLegacyPhysicalAttempts(), 1);
    assert.equal(ledger.migrateLegacyPhysicalAttempts(), 0);
    assert.equal(ledger.listPhysicalAttempts()[0]?.attemptCoverage, "partial");
    assert.equal(ledger.getUsageSummary({ sessionId: session.id }).total.inputTokens, 7);
    const hydration = await session.readHydrationSnapshot();
    assert.equal(hydration.runtime.usage.totalPromptTokens, 7);
    await session.runtimeEventStore!.deleteSession(session.id);
    assert.equal(ledger.getUsageSummary().total.inputTokens, 7);
  } finally {
    await session.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("control migration writes and verifies a readable pre-migration backup", async () => {
  const { ALL_WORKSPACE_SQLITE_SCOPES } = await import("@pico/storage/sqlite/workspace-scopes");
  const { prepareWorkspaceSqliteStorageSync } =
    await import("@pico/storage/sqlite/sqlite-workspace-storage");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "pico-meter-upgrade-"));
  try {
    const oldScopes = ALL_WORKSPACE_SQLITE_SCOPES.map((scope) =>
      scope.name === "control"
        ? {
            ...scope,
            migrations: new Map([...scope.migrations].filter(([version]) => version < 4)),
          }
        : scope,
    );
    const old = prepareWorkspaceSqliteStorageSync(root, oldScopes);
    old.lease.release();
    const upgraded = new SqliteRuntimeControlStore({ storageRoot: root });
    upgraded.close();
    const backup = new DatabaseSync(join(root, "pico.control-v3-before-physical.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        (backup.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
        "ok",
      );
      assert.equal(
        (
          backup
            .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'control'")
            .get() as { version: number }
        ).version,
        3,
      );
      assert.equal(
        backup
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'usage_physical_attempts'")
          .get(),
        undefined,
      );
    } finally {
      backup.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same logical call with unreported HTTP 503 and successful outer retry retains partial coverage", async () => {
  const { createModelUsageReport } = await import("@pico/runtime/provider/model-runtime-report");
  const { resolveModelRouteCapabilities } = await import("@pico/runtime");
  const root = await mkdtemp(join(tmpdir(), "pico-meter-retry-coverage-"));
  const store = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    const first = record(store.beginPhysicalAttemptOwner());
    store.recordPhysicalAttempt(first);
    store.recordPhysicalAttempt({ ...first, revision: 1, status: "failed", httpStatus: 503 });
    const retry: PhysicalAttemptRecord = {
      ...first,
      physicalAttemptId: "physical-retry",
      providerCallId: "call-retry",
      retryAttempt: 1,
    };
    store.recordPhysicalAttempt(retry);
    store.recordPhysicalAttempt({
      ...retry,
      revision: 1,
      status: "succeeded",
      httpStatus: 200,
      usageBasis: "reported",
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        cacheReadTokens: 2,
        reportedFields: ["prompt", "completion", "cacheRead"],
      },
      costCNY: 0.02,
      costStatus: "estimated",
    });
    assert.equal(
      new Set(store.listPhysicalAttempts().map((attempt) => attempt.logicalCallId)).size,
      1,
    );
    const usage = store.getAccountingSessionUsage("session-1")!;
    assert.equal(usage.totalProviderCalls, 2);
    assert.equal(usage.totalUsageReports, 1);
    assert.equal(usage.totalCacheReadReports, 1);
    assert.equal(usage.totalEstimatedCostReports, 1);
    assert.equal(usage.totalUnknownCostReports, 1);
    const report = createModelUsageReport(
      {
        id: "openai/test",
        providerId: "openai",
        provider: "openai",
        model: "test",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        source: "config",
        capabilities: resolveModelRouteCapabilities("openai", "test", undefined),
      },
      usage,
    );
    assert.equal(report.fields.promptTokens.status, "partial");
    assert.equal(report.fields.completionTokens.status, "partial");
    assert.equal(report.fields.cacheReadTokens.status, "partial");
    assert.equal(report.cache.requestHitRate, null);
    assert.equal(report.cost.status, "partial");
    assert.equal(report.cost.cny, 0.02);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy migration recovers auxiliary purpose from matching start and never invents main attribution", async () => {
  const { Session } = await import("@pico/pico-host/session");
  const { RuntimeRun } = await import("@pico/pico-host/product-runtime-run");
  const { createEngineRuntimePort } = await import("@pico/pico-host/engine-runtime-port-adapter");
  const root = await mkdtemp(join(tmpdir(), "pico-meter-legacy-purpose-"));
  const session = new Session("legacy-purpose", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimeStorageRoot: root,
    runtimePort: createEngineRuntimePort(),
  });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await session.recover();
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      await run.recordModelCallStarted({ providerCallId: "aux-call", purpose: "aux" });
      for (const providerCallId of ["aux-call", "unknown-call"]) {
        await run.recordModelCallSettled({
          providerCallId,
          status: "succeeded",
          latencyMs: 1,
          attempts: [
            {
              attemptId: providerCallId,
              attempt: 1,
              provider: "openai",
              model: "test",
              startedAt: snapshot.startedAt,
              completedAt: snapshot.startedAt,
              status: "succeeded",
              latencyMs: 1,
              usageBasis: "reported",
              usage: { promptTokens: 7, completionTokens: 2 },
            },
          ],
          attemptCoverage: "complete",
        });
      }
    });
    assert.deepEqual(
      ledger
        .listAccountingProviderCalls({ sessionId: session.id })
        .map((call) => call.purpose)
        .sort(),
      ["aux", "legacy_unknown"],
    );
    assert.equal(ledger.migrateLegacyPhysicalAttempts(), 2);
    assert.equal(ledger.migrateLegacyPhysicalAttempts(), 0);
    assert.deepEqual(
      ledger
        .listPhysicalAttempts({ sessionId: session.id })
        .map((call) => call.purpose)
        .sort(),
      ["aux", "legacy_unknown"],
    );
    assert.equal(
      ledger
        .listPhysicalAttempts({ sessionId: session.id })
        .some((call) => call.purpose === "main"),
      false,
    );
  } finally {
    await session.close();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("partial Claude usage ignores unreported intermediate counts and never marks completion complete", async () => {
  const { createModelUsageReport } = await import("@pico/runtime/provider/model-runtime-report");
  const { resolveModelRouteCapabilities } = await import("@pico/runtime");
  const root = await mkdtemp(join(tmpdir(), "pico-meter-partial-"));
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    const prepared = record(ledger.beginPhysicalAttemptOwner());
    ledger.recordPhysicalAttempt(prepared);
    const partial: PhysicalAttemptRecord = {
      ...prepared,
      revision: 1,
      status: "cancelled",
      usageBasis: "partial",
      usage: {
        promptTokens: 12,
        completionTokens: 999,
        inputTokens: 999,
        cacheReadTokens: 2,
        cacheWriteTokens: 999,
        reasoningTokens: 999,
        reportedFields: ["prompt", "cacheRead"],
      },
    };
    ledger.recordPhysicalAttempt(partial);
    const measured = ledger.listAccountingProviderCalls({ sessionId: "session-1" })[0]!;
    assert.deepEqual(
      [
        measured.inputTokens,
        measured.outputTokens,
        measured.cacheReadTokens,
        measured.cacheWriteTokens,
      ],
      [10, 0, 2, 0],
    );
    assert.equal(measured.reported?.["reasoningTokens"], undefined);
    const usage = ledger.getAccountingSessionUsage("session-1")!;
    assert.equal(usage.totalUsageReports, 0);
    assert.equal(usage.totalPromptTokens, 12);
    assert.equal(usage.totalCompletionTokens, 0);
    assert.equal(usage.totalReasoningTokens, 0);
    const report = createModelUsageReport(
      {
        id: "claude/test",
        providerId: "claude",
        provider: "claude",
        model: "test",
        baseURL: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        source: "config",
        capabilities: resolveModelRouteCapabilities("claude", "test", undefined),
      },
      usage,
    );
    assert.equal(report.fields.completionTokens.status, "unknown");
    assert.equal(report.fields.completionTokens.value, null);
    assert.equal(report.fields.reasoningTokens.status, "unknown");
    ledger.recordPhysicalAttempt({
      ...partial,
      revision: 2,
      usageBasis: "reported",
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        reasoningTokens: 1,
        reportedFields: ["prompt", "completion", "reasoning"],
      },
    });
    assert.equal(ledger.listAccountingProviderCalls()[0]!.reported?.["reasoningTokens"], 1);
    assert.equal(ledger.getAccountingSessionUsage("session-1")?.totalUsageReports, 1);
    assert.equal(ledger.getAccountingSessionUsage("session-1")?.totalReasoningTokens, 1);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("control 5 freezes proven old baseline overlap and preserves residual history across migration and retention", async () => {
  const { ALL_WORKSPACE_SQLITE_SCOPES } = await import("@pico/storage/sqlite/workspace-scopes");
  const { prepareWorkspaceSqliteStorageSync } =
    await import("@pico/storage/sqlite/sqlite-workspace-storage");
  const { openOperationalDatabaseReadOnly } = await import("@pico/storage");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "pico-meter-baseline-offset-"));
  const before = "2026-09-20T00:00:00.000Z";
  const after = "2026-09-22T00:00:00.000Z";
  const importedAt = Date.parse("2026-09-21T00:00:00.000Z");
  let ledger: SqliteRuntimeControlStore | undefined;
  try {
    const old = prepareWorkspaceSqliteStorageSync(
      root,
      ALL_WORKSPACE_SQLITE_SCOPES.map((scope) =>
        scope.name === "control"
          ? {
              ...scope,
              migrations: new Map([...scope.migrations].filter(([version]) => version <= 4)),
            }
          : scope,
      ),
    );
    try {
      const db = old.lease.database;
      db.prepare(
        "INSERT INTO control_metadata(key,value_json) VALUES ('revision','0'),('nextRuntimeEventSequence','1')",
      ).run();
      const { coordinateEventLogHardCut } =
        await import("../../../packages/storage/src/event-log-hard-cut-coordinator.js");
      coordinateEventLogHardCut(db);
      db.prepare(
        "INSERT INTO sessions(session_id, work_dir, created_at, updated_at) VALUES ('old', ?, ?, ?)",
      ).run(root, before, before);
      db.prepare("UPDATE sessions SET archived_at = 1 WHERE session_id = 'old'").run();
      let sequence = 0;
      for (const [callId, promptTokens, embedded, committedAt] of [
        ["logical", 7, false, before],
        ["embedded", 5, true, before],
        ["covered", 4, false, before],
        ["late-event", 9, false, after],
      ] as const) {
        const data = {
          providerCallId: callId,
          status: "succeeded",
          latencyMs: 1,
          usage: { promptTokens, completionTokens: 1 },
          ...(embedded
            ? {
                attemptCoverage: "complete",
                attempts: [
                  {
                    attemptId: callId,
                    attempt: 0,
                    provider: "openai",
                    model: "test",
                    startedAt: before,
                    completedAt: before,
                    status: "succeeded",
                    latencyMs: 1,
                    usageBasis: "reported",
                    usage: { promptTokens, completionTokens: 1 },
                  },
                ],
              }
            : {}),
        };
        const event = {
          schemaVersion: 2,
          eventId: callId,
          sessionId: "old",
          invocationId: "old",
          runId: "old",
          turnId: "old",
          at: before,
          partial: false,
          visibility: "internal",
          kind: "model.call.settled",
          data,
        };
        db.prepare(
          "INSERT INTO runtime_events(event_id, session_id, invocation_id, run_id, turn_id, event_seq, kind, visibility, partial, tx_id, provider_call_id, payload_json, at, committed_at) VALUES (?, 'old', 'old', 'old', 'old', ?, 'model.call.settled', 'internal', 0, 'old', ?, ?, ?, ?)",
        ).run(callId, ++sequence, callId, JSON.stringify(event), before, committedAt);
      }
      db.prepare(
        "INSERT INTO usage_provider_calls(call_id,tx_id,session_id,purpose,provider,model,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,created_at) VALUES ('covered','old','old','main','openai','test','succeeded',4,1,0,0,0,?)",
      ).run(Date.parse(before));
      db.prepare(
        "INSERT INTO usage_baselines(baseline_id,session_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,imported_at,source_json) VALUES ('session-usage-v1:old','old',15,3,0,0,0,?,?)",
      ).run(
        importedAt,
        JSON.stringify({
          kind: "session_runtime_usage",
          version: 1,
          providerCallsAlreadyDetailed: 1,
        }),
      );
    } finally {
      old.lease.release();
    }
    ledger = new SqliteRuntimeControlStore({ storageRoot: root });
    assert.equal(ledger.getUsageSummary({ sessionId: "old" }).total.inputTokens, 28);
    assert.equal(ledger.listUsageBaselines({ sessionId: "old" })[0]!.inputTokens, 3);
    assert.equal(
      ledger
        .listAccountingProviderCalls({ sessionId: "old" })
        .filter((call) => call.reported?.["accountingSource"] === "legacy_event").length,
      2,
    );
    const db = openOperationalDatabaseReadOnly(root);
    try {
      assert.equal(
        (db.prepare("SELECT input_tokens FROM usage_baselines").get() as { input_tokens: number })
          .input_tokens,
        15,
      );
      assert.equal(
        (
          db.prepare("SELECT input_tokens FROM usage_baseline_adjustments").get() as {
            input_tokens: number;
          }
        ).input_tokens,
        12,
      );
    } finally {
      db.close();
    }
    const backup = new DatabaseSync(
      join(root, "pico.control-v4-before-baseline-reconciliation.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        (
          backup
            .prepare("SELECT version FROM operational_schema_migrations WHERE scope='control'")
            .get() as { version: number }
        ).version,
        4,
      );
    } finally {
      backup.close();
    }
    ledger.migrateLegacyPhysicalAttempts("old");
    const epoch = ledger.getAccountingRevision();
    ledger.migrateLegacyPhysicalAttempts("old");
    assert.equal(ledger.getAccountingRevision(), epoch);
    ledger.close();
    ledger = new SqliteRuntimeControlStore({ storageRoot: root });
    assert.equal(ledger.getUsageSummary({ sessionId: "old" }).total.inputTokens, 28);
    const { enforceEventLogRetention } =
      await import("@pico/storage/sqlite/event-log-retention-store");
    const retention = enforceEventLogRetention({
      storageRoot: root,
      policy: { hardLimitBytes: 2, lowWatermarkBytes: 1 },
    });
    assert.deepEqual(retention.deletedSessionIds, ["old"]);
    assert.equal(ledger.getUsageSummary().total.inputTokens, 28);
    assert.equal(ledger.listUsageBaselines()[0]!.inputTokens, 3);
    ledger.close();
    ledger = new SqliteRuntimeControlStore({ storageRoot: root });
    assert.equal(ledger.getUsageSummary().total.inputTokens, 28);
    const v2 = {
      baselineId: "v2",
      sessionId: "new",
      inputTokens: 6,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      importedAt,
      source: { kind: "session_runtime_usage", version: 2 },
    };
    const revision = ledger.getAccountingRevision();
    ledger.putUsageBaseline(v2);
    assert.ok(ledger.getAccountingRevision() > revision);
    const insertedRevision = ledger.getAccountingRevision();
    ledger.putUsageBaseline(v2);
    assert.equal(ledger.getAccountingRevision(), insertedRevision);
    assert.equal(ledger.getUsageSummary({ sessionId: "new" }).total.inputTokens, 6);
  } finally {
    ledger?.close();
    await rm(root, { recursive: true, force: true });
  }
});
