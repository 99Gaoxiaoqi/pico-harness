import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { SqliteRuntimeControlStore, type PhysicalAttemptRecord } from "@pico/storage";
import { querySessionExecution } from "../../../packages/pico-host/src/session-execution-query.js";
import { parseRuntimeResult } from "../../../packages/protocol/src/runtime.js";
import { ExecutionUsageSummary } from "../../../apps/desktop/src/renderer/workbar-panels/ExecutionUsageSummary.js";

Object.assign(globalThis, { React });

test("session usage exposes physical coverage without counting pending or runtime-only calls as missing usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-usage-provenance-"));
  const events = new SqliteRuntimeEventStore({ storageRoot: root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await events.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await events.advanceOwnerFence("session", 0);
    const base = {
      schemaVersion: 2 as const,
      sessionId: "session",
      runId: "run",
      invocationId: "invocation",
      turnId: "turn",
      at: "2026-10-07T00:00:00.000Z",
      partial: false,
      visibility: "internal" as const,
    };
    await events.append(
      {
        ...base,
        eventId: "start",
        kind: "run.started",
        data: { workDir: root, agentSwarmAuthorization: "none" },
      },
      { ownerFence },
    );
    for (const callId of ["reported", "runtime-only"]) {
      await events.append(
        {
          ...base,
          eventId: `${callId}-start`,
          kind: "model.call.started",
          data: { providerCallId: callId, model: "test", purpose: "main" },
        },
        { ownerFence },
      );
      await events.append(
        {
          ...base,
          eventId: `${callId}-end`,
          kind: "model.call.settled",
          data: {
            providerCallId: callId,
            status: "succeeded",
            latencyMs: 1000,
            usage: { promptTokens: 999, completionTokens: 999 },
          },
        },
        { ownerFence },
      );
    }
    const ownerId = ledger.beginPhysicalAttemptOwner();
    const records: Pick<
      PhysicalAttemptRecord,
      "physicalAttemptId" | "status" | "usageBasis" | "usage" | "attemptCoverage"
    >[] = [
      {
        physicalAttemptId: "reported",
        status: "succeeded",
        usageBasis: "reported",
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          cacheReadTokens: 30,
          reportedFields: ["prompt", "completion", "cacheRead"],
        },
      },
      {
        physicalAttemptId: "partial",
        status: "failed",
        usageBasis: "partial",
        attemptCoverage: "partial",
        usage: { promptTokens: 20, completionTokens: 0, reportedFields: ["prompt"] },
      },
      { physicalAttemptId: "missing", status: "cancelled", usageBasis: "missing" },
      { physicalAttemptId: "pending", status: "observed", usageBasis: "missing" },
    ];
    for (const fields of records) {
      const record: PhysicalAttemptRecord = {
        ...fields,
        accountingVersion: 1,
        accountingSource: "physical",
        providerCallId: fields.physicalAttemptId,
        logicalCallId: fields.physicalAttemptId,
        ownerId,
        sessionId: "session",
        // An unbound physical record still matches its runtime call.
        ...(fields.physicalAttemptId !== "reported" ? { runId: "run" } : {}),
        purpose: "main",
        retryAttempt: 0,
        pricingVersion: "test",
        revision: 1,
        attempt: 0,
        provider: "test",
        model: "test",
        startedAt: base.at,
        completedAt: "2026-10-07T00:00:01.000Z",
        costStatus: "unknown",
      };
      ledger.recordPhysicalAttempt({
        ...record,
        revision: 0,
        status: "prepared",
        usageBasis: "missing",
        usage: undefined,
      });
      ledger.recordPhysicalAttempt(record);
    }
    const page = querySessionExecution(root, { sessionId: "session" });
    parseRuntimeResult("session.execution.summary", page.summary);
    assert.deepEqual(page.summary.provenance, {
      source: "physical_attempts",
      reportedAttempts: 1,
      partialAttempts: 1,
      missingAttempts: 1,
      pendingAttempts: 1,
      partialCoverageCalls: 1,
      runtimeOnlyCalls: 1,
    });
    assert.equal(page.summary.inputTokens, 120);
    assert.equal(page.summary.outputTokens, 10);
    assert.equal(page.summary.physicalAttempts, 4);
    const html = renderToStaticMarkup(
      React.createElement(ExecutionUsageSummary, { summary: page.summary }),
    );
    assert.match(html, /数据来源：本会话实际请求记录/);
    assert.match(
      html,
      /输入\/输出完整上报 1 次 · 部分上报 1 次 · 结束后未上报 1 次 · 记录待结算 1 次/,
    );
    assert.match(html, /另有 1 次模型调用仅有执行记录，未纳入累计/);
    assert.match(html, /请求记录不完整，累计值可能缺少部分请求/);
    assert.match(html, /92.3%/);
    assert.match(html, /tabindex="0"/);
    assert.doesNotMatch(html, /NaN|Infinity/);
  } finally {
    events.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
