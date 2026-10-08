import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeControlStore, openOperationalDatabaseReadOnly } from "@pico/storage";
import type { ForegroundProcessFacts, GoalEvidenceTrace, MemoryRecallTrace } from "@pico/core";
import { parseRuntimeResult } from "@pico/protocol";
import { GoalManager } from "@pico/runtime/goal-manager";
import { querySessionExecution } from "../../../packages/pico-host/src/session-execution-query.js";
import { InspectorWorkbarPanel } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorWorkbarPanel.js";

Object.assign(globalThis, { React });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("reopened execution details retain recall/request levels, native process facts and Goal citations; deletion unlinks and anonymizes", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-evidence-details-"));
  let store = new SqliteRuntimeEventStore({ storageRoot: root });
  const memoryPath = join(root, "memory.sqlite");
  const memories = new SqliteMemoryItemStore(memoryPath);
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await store.advanceOwnerFence("session", 0);
    const base = (eventId: string) => ({
      schemaVersion: 2 as const,
      eventId,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      invocationId: "invocation",
      at: "2026-10-09T00:00:00Z",
      partial: false,
      visibility: "internal" as const,
    });
    const write = {
      content: "稳定偏好",
      kind: "preference" as const,
      statementType: "fact" as const,
      temporalType: "undated" as const,
      scopeType: "workspace" as const,
      scopeKey: "workspace",
      observedAt: 1,
      origin: "user_requested" as const,
      keys: [{ key: "偏好", keyType: "concept" as const, keyOrigin: "user" as const }],
      sources: [{ sessionId: "session", runId: "run", turnId: "turn", eventId: "user" }],
    };
    const saved = await memories.applyMutations({
      operationId: "create",
      mutations: [{ type: "create", item: write }],
    });
    const item = (await memories.readItem(saved.results[0]!.itemId))!.item;
    const trace: MemoryRecallTrace = {
      version: 1,
      mode: "automatic",
      workspaceKey: "workspace",
      queryHash: sha("query"),
      queryRef: { eventId: "user" },
      outcome: "selected",
      stages: { exact: 1, prefix: 1, content: 0, compound: 0, candidates: 1 },
      budget: { maxItems: 3, maxTokens: 320, usedItems: 1, usedTokens: 120, truncated: false },
      counts: { selected: 1, duplicate: 0, budget: 0, item_limit: 0 },
      selected: [
        {
          itemId: item.itemId,
          itemVersion: item.version,
          contentHash: item.contentHash,
          referenceHash: sha("reference"),
          range: { start: 0, end: 4, total: 4 },
          excerpt: false,
          match: "preference",
          source: "user-evidence",
          sourceCount: 1,
          sources: write.sources,
        },
      ],
      diagnostics: [],
      elapsedMs: 1,
      traceTruncated: false,
      omittedDiagnosticCount: 0,
      omittedSourceCount: 0,
    };
    const facts: ForegroundProcessFacts = {
      version: 1,
      kind: "foreground_process",
      exitCode: 1,
      terminationSignal: null,
      timedOut: false,
      outputIncomplete: false,
      spawnFailed: false,
    };
    await store.appendBatch(
      [
        {
          ...base("start"),
          kind: "run.started",
          data: { workDir: root, agentSwarmAuthorization: "none" },
        },
        {
          ...base("user"),
          visibility: "model",
          kind: "message.committed",
          data: { message: { role: "user", content: "检查结果" } },
        },
        { ...base("recall"), kind: "memory.recall.recorded", data: trace },
        {
          ...base("tool-start"),
          refs: { toolCallId: "bash" },
          kind: "tool.started",
          data: {
            toolName: "Bash",
            argumentsJson: "{}",
            argumentsHash: sha("{}"),
            argumentsRedacted: false,
            recoveryMode: "never_auto_retry",
          },
        },
        {
          ...base("tool-result"),
          visibility: "model",
          refs: { toolCallId: "bash" },
          kind: "tool.result.recorded",
          data: {
            toolName: "Bash",
            status: "succeeded",
            executionFacts: facts,
            body: { storage: "inline", content: "passed", sha256: sha("passed"), sizeBytes: 6 },
            projection: {
              version: 1,
              mode: "full",
              text: "passed",
              strategy: "full",
              truncated: false,
            },
          },
        },
        {
          ...base("final"),
          visibility: "model",
          kind: "message.committed",
          data: { message: { role: "assistant", content: "声称成功" } },
        },
        { ...base("terminal"), kind: "run.terminal", data: { status: "completed" } },
      ],
      { ownerFence },
    );
    const identity = {
      goalId: "goal",
      goalRevision: 1,
      generation: 1,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      invocationId: "invocation",
      runStartedEventId: "start",
      terminalEventId: "terminal",
      throughSequence: 7,
    };
    const evidence: GoalEvidenceTrace = {
      version: 1,
      traceId: "goal-trace",
      sourceRunId: "run",
      identity,
      coverage: "complete",
      providedEvidence: [
        {
          eventId: "tool-result",
          kind: "tool",
          toolCallId: "bash",
          sha256: sha("passed"),
          sizeBytes: 6,
          status: "succeeded",
          truncated: false,
        },
      ],
      citedEvidenceIds: ["tool-result"],
      gateReason: "process_not_successful",
    };
    const manager = new GoalManager();
    manager.create({ condition: "检查结果" });
    const snapshot = manager.snapshot();
    await store.appendSessionState(
      "session",
      {
        goal: {
          ...snapshot,
          currentGoal: {
            ...snapshot.currentGoal!,
            lastEvaluation: { met: false, reason: "退出码为1", at: 1, evidenceTrace: evidence },
          },
        },
      },
      { ownerFence },
    );
    const ownerId = ledger.beginPhysicalAttemptOwner();
    ledger.recordPhysicalAttempt({
      physicalAttemptId: "attempt",
      providerCallId: "call",
      logicalCallId: "logical",
      ownerId,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      accountingVersion: 1,
      accountingSource: "physical",
      pricingVersion: "fixture",
      purpose: "main",
      provider: "test",
      model: "test",
      retryAttempt: 0,
      attempt: 0,
      revision: 0,
      startedAt: "2026-10-09T00:00:00Z",
      status: "prepared",
      usageBasis: "missing",
      costStatus: "unknown",
      contextFacts: {
        version: 1,
        memoryRecall: {
          version: 1,
          coverage: "recorded",
          recalls: [
            {
              recallEventId: "recall",
              references: [{ itemId: item.itemId, referenceHash: sha("reference") }],
            },
          ],
        },
      },
      requestDiagnostic: {
        memoryRecall: {
          version: 1,
          coverage: "recorded",
          recalls: [
            {
              recallEventId: "recall",
              references: [{ itemId: item.itemId, referenceHash: sha("reference"), present: true }],
            },
          ],
        },
      },
    });
    await store.close();
    store = new SqliteRuntimeEventStore({ storageRoot: root });
    let page = querySessionExecution(
      root,
      { sessionId: "session" },
      { memoryDatabasePath: memoryPath, workspaceKey: "workspace" },
    );
    parseRuntimeResult("session.execution.query", page);
    const recall = page.runs[0]!.steps.find((s) => s.kind === "memory")!;
    assert.equal(recall.memory!.requests[0]!.evidenceLevel, "prepared");
    assert.equal(recall.memory!.items[0]!.state, "unchanged");
    assert.equal(recall.memory!.sources[0]!.available, true);
    assert.equal(page.runs[0]!.steps.find((s) => s.kind === "tool")!.executionFacts!.exitCode, 1);
    assert.equal(page.runs[0]!.steps.filter((s) => s.kind === "goal_evaluation").length, 1);
    assert.equal(page.summary.modelCalls, 1);
    assert.equal(page.summary.toolCalls, 1);
    const renderStep = (id: string) =>
      renderToStaticMarkup(
        React.createElement(InspectorWorkbarPanel, {
          trace: [],
          execution: page,
          selectedTraceId: id,
          loading: false,
          onRefresh() {},
          onSelectTrace() {},
        }),
      );
    assert.match(renderStep(recall.id), /请求已装配/u);
    assert.match(renderStep(recall.id), /当前版本一致/u);
    assert.match(renderStep(page.runs[0]!.steps.find((s) => s.kind === "tool")!.id), /退出码.*1/u);
    assert.match(
      renderStep(page.runs[0]!.steps.find((s) => s.kind === "goal_evaluation")!.id),
      /已引用/u,
    );
    const slice = await store.readGoalEvidenceRun("session", "run");
    assert.equal(slice.tools[0]!.executionFacts!.exitCode, 1);
    assert.equal(slice.finalReply!.eventId, "final");
    await memories.applyMutations({
      operationId: "update",
      mutations: [
        {
          type: "update",
          itemId: item.itemId,
          expectedVersion: item.version,
          item: { ...write, content: "更正偏好" },
        },
      ],
    });
    page = querySessionExecution(
      root,
      { sessionId: "session" },
      { memoryDatabasePath: memoryPath, workspaceKey: "workspace" },
    );
    assert.equal(page.runs[0]!.steps.find((s) => s.memory)!.memory!.items[0]!.state, "changed");
    await memories.deleteItem({ operationId: "delete", itemId: item.itemId, expectedVersion: 2 });
    page = querySessionExecution(
      root,
      { sessionId: "session" },
      { memoryDatabasePath: memoryPath, workspaceKey: "workspace" },
    );
    assert.deepEqual(page.runs[0]!.steps.find((s) => s.memory)!.memory!.items[0], {
      itemId: item.itemId,
      state: "deleted",
      linkAvailable: false,
    });
    await store.deleteSession("session");
    const db = openOperationalDatabaseReadOnly(root);
    try {
      const raw = String(
        db
          .prepare(
            "SELECT record_json FROM usage_physical_attempts WHERE physical_attempt_id='attempt'",
          )
          .get()!.record_json,
      );
      assert.doesNotMatch(raw, /memoryRecall|recallEventId|itemId/);
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    memories.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled Goal evaluator retries remain unsettled and do not duplicate model accounting", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-goal-unsettled-"));
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await store.advanceOwnerFence("session", 0);
    const base = {
      schemaVersion: 2 as const,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      invocationId: "invocation",
      at: "2026-10-09T00:00:00Z",
      partial: false,
      visibility: "internal" as const,
    };
    await store.appendBatch(
      [
        {
          ...base,
          eventId: "start",
          kind: "run.started",
          data: { workDir: root, agentSwarmAuthorization: "none" },
        },
        { ...base, eventId: "end", kind: "run.terminal", data: { status: "completed" } },
      ],
      { ownerFence },
    );
    const ownerId = ledger.beginPhysicalAttemptOwner();
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = {
        accountingVersion: 1 as const,
        accountingSource: "physical" as const,
        physicalAttemptId: `goal-attempt-${attempt}`,
        providerCallId: "goal-call",
        logicalCallId: "goal-call",
        ownerId,
        sessionId: "session",
        runId: "run",
        turnId: "turn",
        goalId: "goal",
        purpose: "goal_evaluation" as const,
        provider: "test",
        model: "test",
        pricingVersion: "test",
        retryAttempt: attempt,
        attempt,
        revision: 0,
        startedAt: `2026-10-09T00:00:0${attempt}Z`,
        status: "prepared" as const,
        usageBasis: "missing" as const,
        costStatus: "unknown" as const,
      };
      ledger.recordPhysicalAttempt(record);
      ledger.recordPhysicalAttempt({
        ...record,
        revision: 1,
        status: attempt === 0 ? "failed" : "cancelled",
      });
    }
    const missingRecall = {
      accountingVersion: 1 as const,
      accountingSource: "physical" as const,
      physicalAttemptId: "unrecorded-attempt",
      providerCallId: "unrecorded-call",
      logicalCallId: "unrecorded-call",
      ownerId,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      purpose: "main" as const,
      provider: "test",
      model: "test",
      pricingVersion: "test",
      retryAttempt: 0,
      attempt: 0,
      revision: 0,
      startedAt: "2026-10-09T00:00:00Z",
      status: "prepared" as const,
      usageBasis: "missing" as const,
      costStatus: "unknown" as const,
      contextFacts: {
        version: 1 as const,
        memoryRecall: { version: 1 as const, coverage: "unrecorded" as const, recalls: [] },
      },
    };
    ledger.recordPhysicalAttempt(missingRecall);
    ledger.recordPhysicalAttempt({ ...missingRecall, revision: 1, status: "succeeded" });
    const page = querySessionExecution(root, { sessionId: "session" });
    parseRuntimeResult("session.execution.query", page);
    const steps = page.runs[0]!.steps;
    const evaluations = steps.filter((s) => s.kind === "goal_evaluation");
    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0]!.status, "cancelled");
    assert.equal(evaluations[0]!.goalEvaluation!.settlement, "unsettled");
    assert.equal(evaluations[0]!.goalEvaluation!.met, undefined);
    assert.equal(page.summary.modelCalls, 2);
    assert.equal(steps.filter((s) => s.kind === "model").length, 2);
    assert.equal(steps.filter((s) => s.kind === "memory").length, 0);
    const missing = steps.find((s) => s.purpose === "main")!;
    assert.equal(missing.memoryRecallCoverage, "unrecorded");
    const missingHtml = renderToStaticMarkup(
      React.createElement(InspectorWorkbarPanel, {
        trace: [],
        execution: page,
        selectedTraceId: missing.id,
        loading: false,
        onRefresh() {},
        onSelectTrace() {},
      }),
    );
    assert.match(missingHtml, /召回追踪未记录/u);
    const html = renderToStaticMarkup(
      React.createElement(InspectorWorkbarPanel, {
        trace: [],
        execution: page,
        selectedTraceId: evaluations[0]!.id,
        loading: false,
        onRefresh() {},
        onSelectTrace() {},
      }),
    );
    assert.match(html, /验收尚未结算/u);
    assert.match(html, /验收请求已取消/u);
    assert.doesNotMatch(html, /目标达成/u);
  } finally {
    await store.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
