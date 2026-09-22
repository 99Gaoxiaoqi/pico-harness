import { LEGACY_CONTROL_SCOPE } from "../helpers/legacy-control-schema.js";
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

test("control 7 deletes legacy usage and model traces, preserves native facts and chat, and never resurrects on reopen", async () => {
  const { ALL_WORKSPACE_SQLITE_SCOPES } = await import("@pico/storage/sqlite/workspace-scopes");
  const { prepareWorkspaceSqliteStorageSync } =
    await import("@pico/storage/sqlite/sqlite-workspace-storage");
  const { openOperationalDatabaseReadOnly } = await import("@pico/storage");
  const { coordinateEventLogHardCut } =
    await import("../../../packages/storage/src/event-log-hard-cut-coordinator.js");
  const root = await mkdtemp(join(tmpdir(), "pico-native-only-migration-"));
  let ledger: SqliteRuntimeControlStore | undefined;
  const at = snapshot.startedAt;
  try {
    const old = prepareWorkspaceSqliteStorageSync(
      root,
      ALL_WORKSPACE_SQLITE_SCOPES.map((scope) =>
        scope.name === "control"
          ? {
              ...LEGACY_CONTROL_SCOPE,
              migrations: new Map(
                [...LEGACY_CONTROL_SCOPE.migrations].filter(([version]) => version <= 5),
              ),
            }
          : scope,
      ),
    );
    try {
      const db = old.lease.database;
      coordinateEventLogHardCut(db);
      db.prepare(
        "INSERT INTO sessions(session_id,work_dir,created_at,updated_at) VALUES ('session-1',?,?,?)",
      ).run(root, at, at);
      db.prepare("INSERT INTO runtime_owner_fences VALUES ('session-1',0,?)").run(at);
      db.prepare(
        "INSERT INTO runtime_transcript_projection_state VALUES ('session-1','old-epoch',1,8,0)",
      ).run();

      db.prepare(
        "INSERT INTO usage_baselines(baseline_id,session_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,imported_at) VALUES ('old','session-1',999,999,0,0,999,1)",
      ).run();
      db.prepare("INSERT INTO usage_baseline_adjustments VALUES ('old',1,10,1,0,0,1)").run();
      for (const source of ["physical", "legacy_embedded"]) {
        const id = source === "physical" ? "call-1" : "legacy-call";
        const native = {
          ...record("owner"),
          physicalAttemptId: source,
          providerCallId: id,
          accountingSource: source,
          status: "succeeded",
          usageBasis: "reported",
          usage: { promptTokens: 7, completionTokens: 2, reportedFields: ["prompt", "completion"] },
        };
        db.prepare(
          "INSERT INTO usage_physical_attempts(physical_attempt_id,provider_call_id,session_id,run_id,owner_id,revision,status,created_at,record_json) VALUES (?,?,'session-1','run-1','owner',0,'succeeded',?,?)",
        ).run(source, id, at, JSON.stringify(native));
        db.prepare("INSERT INTO usage_attempt_revisions VALUES (?,0,'hash')").run(source);
        db.prepare("INSERT INTO usage_accounting_calls VALUES (?,?,'complete')").run(id, source);
      }
      let seq = 0;
      for (const id of ["call-1", "legacy-call", "logical-call"]) {
        db.prepare(
          "INSERT INTO usage_provider_calls(call_id,tx_id,session_id,purpose,provider,model,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,created_at) VALUES (?,'tx','session-1','main','openai','test','succeeded',999,999,0,0,999,1)",
        ).run(id);
        for (const kind of ["model.call.started", "model.call.settled"]) {
          const data = kind.endsWith("started")
            ? { providerCallId: id, purpose: "main" }
            : {
                providerCallId: id,
                status: "succeeded",
                latencyMs: 1,
                usage: { promptTokens: 999, completionTokens: 999 },
              };
          const eventId = `${id}:${kind}`;
          const event = {
            schemaVersion: 2,
            eventId,
            sessionId: "session-1",
            invocationId: "run-1",
            runId: "run-1",
            turnId: "turn-1",
            at,
            partial: false,
            visibility: "internal",
            kind,
            data,
          };
          db.prepare(
            "INSERT INTO runtime_events(event_id,session_id,invocation_id,run_id,turn_id,event_seq,kind,visibility,partial,tx_id,provider_call_id,payload_json,at,committed_at) VALUES (?,'session-1','run-1','run-1','turn-1',?,?,'internal',0,'tx',?,?,?,?)",
          ).run(eventId, ++seq, kind, id, JSON.stringify(event), at, at);
        }
      }
      const chat = {
        schemaVersion: 2,
        eventId: "chat",
        sessionId: "session-1",
        invocationId: "run-1",
        runId: "run-1",
        turnId: "turn-1",
        at,
        partial: false,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "user", content: "keep my conversation" } },
      };
      db.prepare(
        "INSERT INTO runtime_events(event_id,session_id,invocation_id,run_id,turn_id,event_seq,kind,visibility,partial,tx_id,payload_json,at,committed_at) VALUES ('chat','session-1','run-1','run-1','turn-1',?,'message.committed','model',0,'tx',?,?,?)",
      ).run(++seq, JSON.stringify(chat), at, at);
      db.prepare(
        "INSERT INTO runtime_events SELECT 'legacy-tail', session_id, invocation_id, run_id, turn_id, ?, kind, visibility, partial, tx_id, tool_call_id, provider_call_id, operation_id, json_set(payload_json,'$.eventId','legacy-tail'), at, committed_at FROM runtime_events WHERE event_id='legacy-call:model.call.started'",
      ).run(++seq);
      db.prepare(
        "UPDATE sessions SET last_event_seq=?,event_count=?,storage_bytes=(SELECT SUM(length(payload_json)) FROM runtime_events) WHERE session_id='session-1'",
      ).run(seq, seq);
    } finally {
      old.lease.release();
    }
    for (let reopen = 0; reopen < 2; reopen++) {
      ledger = new SqliteRuntimeControlStore({ storageRoot: root });
      assert.equal(ledger.getUsageSummary().total.inputTokens, 7);
      assert.equal(ledger.getAccountingSessionUsage("missing").totalPromptTokens, 0);
      assert.deepEqual(
        ledger.listPhysicalAttempts().map((row) => row.accountingSource),
        ["physical"],
      );
      assert.deepEqual(
        ledger.listAccountingProviderCalls().map((row) => row.callId),
        ["physical"],
      );
      const db = openOperationalDatabaseReadOnly(root);
      try {
        assert.deepEqual(
          db
            .prepare("SELECT event_id FROM runtime_events ORDER BY event_seq")
            .all()
            .map((row) => row.event_id),
          ["call-1:model.call.started", "call-1:model.call.settled", "chat"],
        );
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 1);
        assert.notEqual(
          db.prepare("SELECT history_epoch FROM runtime_transcript_projection_state").get()!
            .history_epoch,
          "old-epoch",
        );
        assert.equal(
          db.prepare("SELECT through_sequence FROM runtime_transcript_projection_state").get()!
            .through_sequence,
          7,
        );

        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_attempt_revisions").get()!.n, 1);

        assert.equal(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('usage_baselines','usage_baseline_adjustments','usage_effective_baselines','usage_baseline_reconcile','usage_provider_calls','usage_accounting_calls','evidence_records','evidence_blobs')",
            )
            .get()!.n,
          0,
        );
        assert.match(
          String(
            db.prepare("SELECT payload_json FROM runtime_events WHERE event_id='chat'").get()!
              .payload_json,
          ),
          /keep my conversation/,
        );
      } finally {
        db.close();
      }
      const events = new SqliteRuntimeEventStore({ storageRoot: root });
      try {
        const current = await events.readTranscriptWatermark("session-1");
        await assert.rejects(
          events.readTranscriptProjectionPage({
            sessionId: "session-1",
            through: { ...current, historyEpoch: "old-epoch", throughSequence: 8 },
            maxBytes: 65536,
          }),
          { code: "RESET_REQUIRED" },
        );
        const catalog = await events.findSessionCatalogEntry("session-1");
        assert.equal(catalog?.headEventCount, 3);
        assert.equal(catalog?.fold.headSequence, 7);
        assert.equal(
          (await events.readSessionMessages("session-1"))[0]?.content,
          "keep my conversation",
        );
        assert.equal((await events.getHeadCursor("session-1"))?.seq, 7);
        assert.equal((await events.readSessionProjection("session-1"))?.entries.length, 3);
      } finally {
        events.close();
      }
      ledger.close();
    }
    const events = new SqliteRuntimeEventStore({ storageRoot: root });
    try {
      const ownerFence = await events.advanceOwnerFence("session-1", 0);
      const appended = await events.append(
        {
          schemaVersion: 2,
          eventId: "new-chat",
          sessionId: "session-1",
          invocationId: "run-1",
          runId: "run-1",
          turnId: "turn-1",
          at,
          partial: false,
          visibility: "model",
          kind: "message.committed",
          data: { message: { role: "user", content: "new conversation" } },
        },
        { ownerFence },
      );
      assert.equal(appended.cursor.seq, 8);
      assert.equal((await events.findSessionCatalogEntry("session-1"))?.headEventCount, 4);
    } finally {
      events.close();
    }
  } finally {
    ledger?.close();
    await rm(root, { recursive: true, force: true });
  }
});
