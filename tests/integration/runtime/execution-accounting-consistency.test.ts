import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  SqliteRuntimeControlStore,
  operationalDatabasePath,
  type PhysicalAttemptRecord,
} from "@pico/storage";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import {
  querySessionExecution,
  querySessionExecutionSummary,
} from "../../../packages/pico-host/src/session-execution-query.js";
import { buildUsageDashboard } from "../../../packages/pico-host/src/usage-dashboard.js";

import { readExecutionWindow } from "../../../apps/desktop/src/renderer/workbar-panels/execution-trace-window.js";

const at = "2026-09-22T00:00:00.000Z";
function events(n: number, workDir = "/fixture"): RuntimeEvent[] {
  const base = {
    schemaVersion: 2 as const,
    sessionId: "session",
    invocationId: `inv-${n}`,
    runId: `run-${n}`,
    turnId: `turn-${n}`,
    at,
    partial: false,
    visibility: "internal" as const,
  };
  return [
    {
      ...base,
      eventId: `${n}-open`,
      kind: "run.started",
      data: { workDir, agentSwarmAuthorization: "none" },
    },
    {
      ...base,
      eventId: `${n}-start`,
      kind: "model.call.started",
      data: { providerCallId: `call-${n}`, provider: "fixture", model: "fixture", purpose: "main" },
    },
    {
      ...base,
      eventId: `${n}-settled`,
      kind: "model.call.settled",
      data: {
        providerCallId: `call-${n}`,
        status: "cancelled",
        latencyMs: 20,
        usage: { promptTokens: 999, completionTokens: 999 },
        costCNY: 999,
        costStatus: "estimated",
      },
    },
    { ...base, eventId: `${n}-end`, kind: "run.terminal", data: { status: "cancelled" } },
  ];
}
function physical(n: number, ownerId: string): PhysicalAttemptRecord {
  return {
    accountingVersion: 1,
    accountingSource: "physical",
    physicalAttemptId: `attempt-${n}`,
    providerCallId: `call-${n}`,
    logicalCallId: `logical-${n}`,
    ownerId,
    sessionId: "session",
    runId: `run-${n}`,
    turnId: `turn-${n}`,
    purpose: "main",
    retryAttempt: 0,
    pricingVersion: "fixture-v1",
    costStatus: "unknown",
    revision: 0,
    attempt: 0,
    provider: "fixture",
    model: "fixture",
    startedAt: at,
    status: "prepared",
    usageBasis: "missing",
  };
}
test("durable revisions replace stale logical usage across execution, ledger, session and dashboard", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-accounting-consistency-"));
  const eventStore = new SqliteRuntimeEventStore({ storageRoot: root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await eventStore.initializeSession({ sessionId: "session", workDir: root });
    const fence = await eventStore.advanceOwnerFence("session", 0);
    await eventStore.appendBatch(events(0, root), { ownerFence: fence });
    const owner = ledger.beginPhysicalAttemptOwner();
    const start = physical(0, owner);
    ledger.recordPhysicalAttempt(start);
    let page = querySessionExecution(root, { sessionId: "session" });
    assert.equal(page.runs[0]?.steps[0]?.attempts?.[0]?.status, "prepared");
    assert.equal(page.summary.inputTokens, undefined);
    const terminal: PhysicalAttemptRecord = {
      ...start,
      revision: 1,
      status: "cancelled",
      completedAt: at,
      latencyMs: 20,
    };
    ledger.recordPhysicalAttempt(terminal);
    const late: PhysicalAttemptRecord = {
      ...terminal,
      revision: 2,
      usageBasis: "reported",
      costStatus: "estimated",
      costCNY: 0.25,
      usage: {
        promptTokens: 100,
        completionTokens: 7,
        cacheReadTokens: 40,
        reportedFields: ["prompt", "completion", "cacheRead"],
      },
    };
    ledger.recordPhysicalAttempt(late);
    ledger.recordPhysicalAttempt(late);
    ledger.recordPhysicalAttempt(terminal);
    page = querySessionExecution(root, { sessionId: "session" });
    assert.equal(page.runs[0]?.status, "cancelled");
    assert.equal(page.runs[0]?.steps[0]?.status, "cancelled");
    assert.equal(page.summary.inputTokens, 100);
    assert.equal(page.summary.outputTokens, 7);
    assert.equal(page.summary.costCNY, 0.25);
    assert.equal(page.summary.physicalAttempts, 1);
    assert.deepEqual(page.summary, querySessionExecutionSummary(root, { sessionId: "session" }));
    const usage = ledger.getUsageSummary({ sessionId: "session" }).total;
    assert.equal(
      usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      page.summary.inputTokens,
    );
    assert.equal(usage.outputTokens, page.summary.outputTokens);
    assert.equal(usage.cost, page.summary.costCNY);
    assert.equal(ledger.getAccountingSessionUsage("session")?.totalPromptTokens, 100);
    const dashboard = await buildUsageDashboard({
      sources: [
        {
          workspacePath: root,
          storageRoot: root,
          calls: ledger.listAccountingProviderCalls({ sessionId: "session" }),
        },
      ],
      pricing: [],
      unavailableWorkspaces: [],
      createRuntimeEventReader: () => new SqliteRuntimeEventStore({ storageRoot: root }),
    });
    assert.equal(dashboard.knownCacheReadTokens, 40);
    assert.equal(dashboard.activities.filter((a) => a.kind === "model").length, 1);
    assert.equal(dashboard.activities.find((a) => a.kind === "model")?.inputTokens, 100);
    // Background accounting intentionally has no foreground model.call events.
    const background = {
      ...physical(999, owner),
      runId: undefined,
      purpose: "memory_review" as const,
    };
    ledger.recordPhysicalAttempt(background);
    ledger.recordPhysicalAttempt({
      ...background,
      revision: 1,
      status: "succeeded",
      usageBasis: "reported",
      usage: { promptTokens: 5, completionTokens: 2, reportedFields: ["prompt", "completion"] },
    });
    assert.equal(querySessionExecutionSummary(root, { sessionId: "session" }).inputTokens, 105);
    assert.equal(ledger.getAccountingSessionUsage("session")?.totalPromptTokens, 105);
    assert.equal(querySessionExecutionSummary(root, { sessionId: "session" }).meteredCalls, 2);
    for (let n = 1; n < 18; n++)
      await eventStore.appendBatch(events(n, root), { ownerFence: fence });
    const cursor = querySessionExecution(root, { sessionId: "session" }).nextCursor!;
    assert.ok(cursor);
    ledger.recordPhysicalAttempt({
      ...late,
      revision: 3,
      usage: { ...late.usage!, completionTokens: 8 },
    });
    assert.throws(
      () => querySessionExecution(root, { sessionId: "session", cursor }),
      /Invalid execution cursor/,
    );
    let revised = false;
    const window = await readExecutionWindow(
      async (cursor) => {
        if (cursor && !revised) {
          revised = true;
          ledger.recordPhysicalAttempt({
            ...late,
            revision: 4,
            usage: { ...late.usage!, completionTokens: 9 },
          });
        }
        return querySessionExecution(root, { sessionId: "session", ...(cursor ? { cursor } : {}) });
      },
      2,
      () => true,
    );
    assert.equal(window?.length, 2);
    assert.equal(new Set(window?.flatMap((p) => p.runs.map((r) => r.runId))).size, 18);
    await eventStore.initializeSession({ sessionId: "historical-only", workDir: root });
    const historical = querySessionExecutionSummary(root, { sessionId: "historical-only" });
    assert.equal(historical.modelCalls, 0);
    assert.equal(historical.inputTokens, undefined);
    assert.equal(historical.costCNY, undefined);
  } finally {
    ledger.close();
    eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("10,000 physical requests retain bounded pages and measured summary latency", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-accounting-scale-"));
  const eventStore = new SqliteRuntimeEventStore({ storageRoot: root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await eventStore.initializeSession({ sessionId: "session", workDir: root });
    const db = new DatabaseSync(operationalDatabasePath(root));
    // Deterministic database benchmark fixture; no provider or production-write path is mocked.
    try {
      const event = db.prepare(
        "INSERT INTO runtime_events(event_id,session_id,invocation_id,run_id,turn_id,event_seq,kind,visibility,partial,tx_id,payload_json,at,committed_at) VALUES (?,?,?,?,?,?,?,'internal',0,'benchmark',?,?,?)",
      );
      const attempt = db.prepare(
        "INSERT INTO usage_physical_attempts(physical_attempt_id,provider_call_id,session_id,run_id,owner_id,revision,status,created_at,record_json) VALUES (?,?,'session',?,'benchmark',1,'cancelled',?,?)",
      );
      db.exec("BEGIN");
      for (let n = 0; n < 10000; n++) {
        for (const [i, e] of events(n).entries())
          event.run(
            e.eventId,
            e.sessionId,
            e.invocationId,
            e.runId,
            e.turnId,
            n * 4 + i + 1,
            e.kind,
            JSON.stringify(e),
            at,
            at,
          );
        const record = {
          ...physical(n, "benchmark"),
          revision: 1,
          status: "cancelled",
          completedAt: at,
          latencyMs: 20,
          usageBasis: "reported",
          usage: {
            promptTokens: 10,
            completionTokens: 2,
            reportedFields: ["prompt", "completion"],
          },
        };
        attempt.run(
          record.physicalAttemptId,
          record.providerCallId,
          record.runId!,
          at,
          JSON.stringify(record),
        );
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const times = { page: [] as number[], summary: [] as number[] };
    for (let n = 0; n < 30; n++) {
      let start = performance.now();
      const page = querySessionExecution(root, { sessionId: "session" });
      times.page.push(performance.now() - start);
      if (times.page.at(-1)! > 5000)
        throw new Error(
          `benchmark first page ${times.page.at(-1)}ms exceeds diagnostic stop limit`,
        );
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024);
      assert.ok(page.nextCursor);
      assert.equal(page.summary.inputTokens, 100000);
      start = performance.now();
      const summary = querySessionExecutionSummary(root, { sessionId: "session" });
      times.summary.push(performance.now() - start);
      assert.equal(summary.physicalAttempts, 10000);
      assert.equal(summary.outputTokens, 20000);
    }
    const p95 = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
    console.log(
      JSON.stringify({
        benchmark: "execution-accounting",
        cpu: cpus()[0]?.model,
        node: process.version,
        requests: 10000,
        samples: 30,
        cache:
          "first cold query followed by OS/SQLite warm queries; new readonly connection each sample",
        firstPageMs: times.page[0],
        pageP95Ms: p95(times.page),
        summaryP95Ms: p95(times.summary),
      }),
    );
    assert.ok(p95(times.page) <= 500, `page p95 ${p95(times.page)}ms`);
    assert.ok(p95(times.summary) <= 500, `summary p95 ${p95(times.summary)}ms`);
  } finally {
    ledger.close();
    eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
