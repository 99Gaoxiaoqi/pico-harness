import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isMemoryRecallTrace,
  isMemoryRecallRequestFacts,
  type TaskExperienceCandidate,
  type PreparedProviderRequest,
} from "@pico/core";
import { parseRuntimeResult } from "@pico/protocol";
import { SqliteRuntimeControlStore } from "@pico/storage";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import {
  createCaseRecallTrace,
  memoryRecallCaseSelectedItem,
  createMemoryRecallTrace,
} from "../../../packages/runtime/src/memory-recall-trace.js";
import {
  MemoryRecallRequestTracker,
  capturePreparedMemoryRecall,
  isPreparedMemoryRecallDiagnostic,
} from "../../../packages/runtime/src/memory-recall-request.js";
import { searchTaskExperienceCases } from "../../../packages/pico-host/src/task-experience-recall.js";
import { querySessionExecution } from "../../../packages/pico-host/src/session-execution-query.js";
import { ExecutionTraceTimeline } from "../../../apps/desktop/src/renderer/workbar-panels/ExecutionTraceTimeline.js";
Object.assign(globalThis, { React });

const workspaceKey = "case-trace-workspace";
const source = { sessionId: "session", runId: "run", turnId: "turn", eventId: "source" };
const request = (content: string): PreparedProviderRequest =>
  ({
    provider: "openai",
    model: "fixture",
    body: { messages: [{ role: "tool", content }] },
  }) as PreparedProviderRequest;

test("case selection persists versioned identity, actual prepared references and freshly checked case/source UI without memory items", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-case-trace-"));
  const path = join(root, "memory.sqlite");
  const memory = new SqliteMemoryItemStore(path);
  const db = new DatabaseSync(path);
  const events = new SqliteRuntimeEventStore({ storageRoot: root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    const candidate: TaskExperienceCandidate = {
      candidateId: "case-alpha",
      contentVersion: 4,
      recordRevision: 7,
      review: "unneeded",
      validation: "unknown",
      enabled: false,
      applicability: { taskFamily: "general", toolNames: [], conditions: [] },
      representation: "case",
      usagePolicy: "case_only",
      matchHints: ["Nebula"],
      requiredConditions: [],
      kind: "task-lesson",
      lifecycleState: "active",
      taskId: "task",
      taskVersion: 1,
      workspaceKey,
      workDir: root,
      sessionId: "session",
      runId: "run",
      failureKey: "failure",
      inputEpoch: 0,
      settingsVersion: 1,
      deletionRevision: 0,
      state: "saved",
      goal: "Nebula task",
      content: "Nebula encountered a historical failure.",
      sources: [source],
      observationIds: [],
      createdAt: 1,
      updatedAt: 1,
    };
    db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      candidate.candidateId,
      workspaceKey,
      "session",
      "run",
      "failure",
      "saved",
      7,
      null,
      1,
      JSON.stringify(candidate),
    );
    const selected: ReturnType<typeof memoryRecallCaseSelectedItem>[] = [];
    let summary: Parameters<typeof createCaseRecallTrace>[0]["summary"];
    const block = await searchTaskExperienceCases({
      store: memory.taskExperiences,
      workspaceKey,
      workDir: root,
      query: "Nebula",
      budgetMs: 5000,
      onSelected: (item) => selected.push(memoryRecallCaseSelectedItem(item)),
      onSelectionSummary: (value) => {
        summary = value;
      },
    });
    assert.equal(selected.length, 1);
    const trace = createCaseRecallTrace({
      workspaceKey,
      query: "Nebula",
      queryRef: { toolCallId: "same-tool-id", anchorEventId: "source" },
      queryPolicyVersion: 1,
      block,
      selected,
      summary,
    });
    assert.equal(isMemoryRecallTrace(trace), true);
    assert.equal(trace.version, 2);
    assert.equal(trace.selected.length, 0);
    assert.doesNotMatch(JSON.stringify(trace), /Nebula|historical failure|renderedLine|itemId/);
    const tracker = new MemoryRecallRequestTracker({ record: async () => "case-recall" });
    await tracker.record(trace);
    const facts = await tracker.context([
      { role: "user", toolCallId: "same-tool-id", content: block },
    ]);
    assert.equal(isMemoryRecallRequestFacts(facts), true);
    assert.equal(facts.version, 2);
    assert.equal(facts.recalls[0]?.caseReferences?.[0]?.candidateId, candidate.candidateId);
    const prepared = capturePreparedMemoryRecall(request(block), facts);
    assert.equal(isPreparedMemoryRecallDiagnostic(prepared), true);
    assert.equal(prepared.recalls[0]?.blockPresent, true);
    assert.equal(prepared.recalls[0]?.caseReferences?.[0]?.present, true);
    const removed = capturePreparedMemoryRecall(
      request('<case id="case-alpha">different body</case>'),
      facts,
    );
    assert.equal(removed.recalls[0]?.blockPresent, false);
    assert.equal(removed.recalls[0]?.caseReferences?.[0]?.present, false);
    await events.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await events.advanceOwnerFence("session", 0);
    const base = (eventId: string) => ({
      schemaVersion: 2 as const,
      ...source,
      eventId,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      invocationId: "invocation",
      at: "2026-10-16T00:00:00Z",
      partial: false,
      visibility: "internal" as const,
    });
    await events.appendBatch(
      [
        {
          ...base("start"),
          kind: "run.started",
          data: { workDir: root, agentSwarmAuthorization: "none" },
        },
        {
          ...base("source"),
          kind: "message.committed",
          visibility: "model",
          data: { message: { role: "user", content: "source evidence" } },
        },
        { ...base("case-recall"), kind: "memory.recall.recorded", data: trace },
        { ...base("terminal"), kind: "run.terminal", data: { status: "completed" } },
      ],
      { ownerFence },
    );
    ledger.recordPhysicalAttempt({
      physicalAttemptId: "case-attempt",
      providerCallId: "case-call",
      logicalCallId: "logical",
      ownerId: ledger.beginPhysicalAttemptOwner(),
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
      startedAt: "2026-10-16T00:00:00Z",
      status: "prepared",
      usageBasis: "missing",
      costStatus: "unknown",
      contextFacts: { version: 1, memoryRecall: facts },
      requestDiagnostic: { memoryRecall: prepared },
    });
    const read = () =>
      querySessionExecution(
        root,
        { sessionId: "session" },
        { memoryDatabasePath: path, workspaceKey },
      );
    let page = read();
    parseRuntimeResult("session.execution.query", page);
    let detail = page.runs[0]!.steps.find((step) => step.memory)!.memory!;
    assert.equal(detail.items.length, 0);
    assert.equal(detail.requests[0]?.evidenceLevel, "prepared");
    assert.equal(detail.requests[0]?.blockPresent, true);
    assert.equal(detail.requests[0]?.referenceCount, 1);
    assert.equal(detail.requests[0]?.referencePresentCount, 1);
    assert.equal(detail.cases?.[0]?.state, "unchanged");
    assert.equal(detail.sources[0]?.available, true);
    const html = renderToStaticMarkup(
      React.createElement(ExecutionTraceTimeline, {
        execution: page,
        onSelectTrace: () => {},
        selectedTraceId: "case-recall",
      }),
    );
    assert.match(html, /candidate=case-alpha/);
    assert.match(html, /不表示已采用或已验证/);
    assert.doesNotMatch(html, /memory-case-alpha/);
    db.prepare("UPDATE execution_learning_candidates SET record_json=? WHERE candidate_id=?").run(
      JSON.stringify({ ...candidate, recordRevision: 8 }),
      candidate.candidateId,
    );
    detail = read().runs[0]!.steps.find((step) => step.memory)!.memory!;
    assert.equal(detail.cases?.[0]?.state, "changed");
    assert.equal(detail.sources[0]?.available, false);
    db.prepare("DELETE FROM execution_learning_candidates WHERE candidate_id=?").run(
      candidate.candidateId,
    );
    page = read();
    detail = page.runs[0]!.steps.find((step) => step.memory)!.memory!;
    assert.equal(detail.cases?.[0]?.state, "deleted");
    assert.equal(detail.cases?.[0]?.linkAvailable, false);
    assert.equal(detail.sources[0]?.available, false);
    assert.doesNotMatch(
      renderToStaticMarkup(
        React.createElement(ExecutionTraceTimeline, {
          execution: page,
          onSelectTrace: () => {},
          selectedTraceId: "case-recall",
        }),
      ),
      /candidate=case-alpha|href="\/session\/session"/,
    );
  } finally {
    await events.close();
    db.close();
    ledger.close();
    memory.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("case empty/error/budget/limited/write failure and cross-run duplicate tool IDs stay distinguishable; legacy memory traces remain valid", async () => {
  for (const outcome of [
    "no_hits",
    "budget_exhausted",
    "error",
    "limited",
    "disabled",
    "admission_denied",
  ] as const) {
    const trace = createCaseRecallTrace({
      workspaceKey,
      outcome,
      queryRef: { toolCallId: "empty" },
      block: `result ${outcome}`,
    });
    assert.equal(isMemoryRecallTrace(trace), true);
    const tracker = new MemoryRecallRequestTracker({ record: async () => outcome });
    await tracker.record(trace);
    assert.equal(
      (await tracker.context([{ role: "user", toolCallId: "empty", content: `result ${outcome}` }]))
        .recalls[0]?.recallEventId,
      outcome,
    );
  }
  const trace = createCaseRecallTrace({
    workspaceKey,
    queryRef: { toolCallId: "collision" },
    block: "same result",
  });
  const tracker = new MemoryRecallRequestTracker({
    record: async () => "new-run",
    readHistory: async () => [{ eventId: "old-run", trace }],
  });
  await tracker.record(trace);
  const ambiguous = await tracker.context([
    { role: "user", toolCallId: "collision", content: "same result" },
  ]);
  assert.equal(ambiguous.coverage, "unrecorded");
  assert.equal(ambiguous.recalls.length, 0);
  const failed = new MemoryRecallRequestTracker({
    record: async () => {
      throw new Error("fixture");
    },
  });
  await failed.record(trace);
  assert.equal((await failed.context([])).coverage, "unrecorded");
  const manySources = Array.from({ length: 10 }, (_, i) => ({
    sessionId: String(i).repeat(400),
    runId: "r".repeat(400),
    turnId: "t".repeat(400),
    eventId: "e".repeat(400),
  }));
  const large = createCaseRecallTrace({
    workspaceKey,
    selected: Array.from({ length: 3 }, (_, i) =>
      memoryRecallCaseSelectedItem({
        candidateId: `case-${i}`,
        contentVersion: 1,
        recordRevision: 1,
        renderedLine: `<case>${i}</case>`,
        sources: manySources,
        range: { start: 0, end: 1, total: 1 },
        excerpt: false,
      }),
    ),
  });
  assert.equal(large.caseSelected?.length, 3);
  assert.equal(isMemoryRecallTrace(large), true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 8192);
  assert.ok(large.omittedSourceCount > 0);
  const legacy = createMemoryRecallTrace({
    mode: "automatic",
    workspaceKey,
    outcome: "no_hits",
    budget: { maxItems: 3, maxTokens: 100, usedItems: 0, usedTokens: 0, truncated: false },
  });
  assert.equal(legacy.version, 1);
  assert.equal(isMemoryRecallTrace(legacy), true);
  assert.equal(isMemoryRecallRequestFacts({ version: 1, coverage: "recorded", recalls: [] }), true);
  assert.equal(
    isMemoryRecallTrace({
      ...trace,
      caseSelected: [{ candidateId: "forged", itemId: "fake-memory" }],
    }),
    false,
  );
  assert.throws(() =>
    createCaseRecallTrace({
      workspaceKey,
      summary: {
        candidates: 1,
        matched: 1,
        selected: 0,
        budget: 0,
        itemLimit: 0,
        usedTokens: 1501,
        limited: false,
        truncated: false,
      },
    }),
  );
  assert.equal(isMemoryRecallTrace({ ...trace, forbiddenBody: "private" }), false);
});
