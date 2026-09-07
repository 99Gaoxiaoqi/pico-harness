import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AtomicMemoryExtractionEngine } from "../../src/memory/atomic/extraction-engine.js";
import { ModelCapabilityError } from "../../src/provider/errors.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import type {
  MemoryEvidenceEvent,
  MemoryExtractionSnapshot,
  MemoryModelRequest,
} from "../../src/memory/atomic/runtime-contracts.js";

const SESSION = "memory-budget-engine";
const preference = "我偏好使用 PostgreSQL。";
const noOp = JSON.stringify({
  status: "complete",
  coverageStatus: "processed",
  requestedStatus: "not_applicable",
  requestedItems: [],
  incidentalItems: [],
});

test("budget overflow splits at a complete turn, remaps filtered indexes and preserves tail evidence", async (t) => {
  const store = fixture(t);
  const longText = "我的团队使用数据库存储业务数据，偏好清晰直接的实现方案。".repeat(160);
  const old = event(1, "旧轮：" + longText, "old");
  const current = event(2, "新轮：" + longText + preference, "current");
  const calls: MemoryModelRequest[] = [];
  const engine = new AtomicMemoryExtractionEngine({
    store,
    gate: async () => ({ allowed: true }),
    model: {
      async call(request) {
        calls.push(request);
        if (request.stage === "canonicalize") return canonical();
        const sources = request.sourceMessages!;
        assert.equal(sources.length, 1, "each split sends only its own turn");
        assert.match(request.prompt, /"messagePositions":\[0\]/);
        const original = sources[0]!.content.startsWith("旧轮") ? old : current;
        assert.match(request.prompt, new RegExp(`event:${original.eventId}`));
        assert.doesNotMatch(
          request.prompt,
          new RegExp(`event:${original === old ? current.eventId : old.eventId}`),
        );
        assert.doesNotMatch(JSON.stringify(request), /HIDDEN TOOL|HIDDEN SYSTEM/);
        return original === old ? noOp : proposal(current);
      },
    },
  });
  const result = await engine.execute(
    snapshot([old, current], {
      contextWindowTokens: 7000,
      reservedOutputTokens: 256,
      sourceMessages: [
        { role: "system", content: "HIDDEN SYSTEM" },
        { role: "user", content: old.text },
        { role: "user", content: "HIDDEN TOOL", toolCallId: "tool" },
        { role: "user", content: current.text },
      ],
      sourceEventMessagePositions: { [old.eventId]: [1], [current.eventId]: [3] },
    }),
  );
  assert.equal(result.status, "remembered");
  assert.equal(result.requestedItems[0]?.content, preference);
  assert.deepEqual(
    calls.map(({ stage }) => stage),
    ["proposal", "proposal", "canonicalize"],
  );
  assert.equal((await store.readExtractionCursor(SESSION))?.processedOrdinal, current.ordinal);
  assert.equal(calls[2]!.sourceMessages, undefined);
  assert.equal(calls[2]!.sourceTools, undefined);
});

test("a denied historical compaction advances empty coverage before an explicit remember", async (t) => {
  const store = fixture(t);
  const old = event(1, "历史内容不应触发自动提取。", "old");
  const current = event(2, preference, "current");
  const calls: MemoryModelRequest[] = [];
  const gates: string[] = [];
  const engine = new AtomicMemoryExtractionEngine({
    store,
    gate: async (trigger) => {
      gates.push(trigger ?? "missing");
      return trigger === "remember"
        ? { allowed: true }
        : { allowed: false, reason: "memory_disabled" };
    },
    model: {
      async call(request) {
        calls.push(request);
        assert.doesNotMatch(request.prompt, new RegExp(`event:${old.eventId}`));
        return request.stage === "canonicalize" ? canonical() : proposal(current);
      },
    },
  });
  const result = await engine.execute(
    snapshot([old, current], {
      checkpoints: [{ checkpointId: "old-checkpoint", ordinal: 1, throughOrdinal: 1 }],
    }),
  );
  assert.equal(result.status, "remembered");
  assert.ok(gates.includes("compaction"));
  assert.deepEqual(
    calls.map(({ stage }) => stage),
    ["proposal", "canonicalize"],
  );
  assert.equal((await store.readExtractionCursor(SESSION))?.processedOrdinal, 2);
  assert.deepEqual(
    (await store.readCompactionPolicyDenials(SESSION)).map((row) => row.compactionCheckpointId),
    ["old-checkpoint"],
  );
});

test("an indivisible oversized turn and Provider context_window errors do not retry identical requests", async (t) => {
  for (const knownBudget of [true, false]) {
    const store = fixture(t);
    const current = event(1, preference, "current");
    let calls = 0;
    const engine = new AtomicMemoryExtractionEngine({
      store,
      gate: async () => ({ allowed: true }),
      model: {
        async call() {
          calls++;
          throw new ModelCapabilityError("test", "context_window", "request too large");
        },
      },
    });
    const result = await engine.execute(
      snapshot(
        [current],
        knownBudget
          ? {
              contextWindowTokens: 1024,
              reservedOutputTokens: 256,
            }
          : {},
      ),
    );
    assert.equal(result.status, "unavailable");
    assert.equal(calls, knownBudget ? 0 : 1);
    assert.equal(await store.readExtractionCursor(SESSION), undefined);
    assert.equal((await store.readPendingExtractionFailure(SESSION))?.throughOrdinal, 1);
  }
});

test("localized and canonical requests are budgeted before a second model call", async (t) => {
  for (const stage of ["localized", "canonicalize"] as const) {
    const store = fixture(t);
    const historical = event(1, "历史定位材料：" + "清晰直接的实现方案。".repeat(400), "old");
    const current = event(
      2,
      stage === "localized" ? "请记住历史定位材料中的偏好。" : preference.repeat(35),
      "current",
    );
    await store.initializeExtractionCursor(SESSION, 1);
    const calls: string[] = [];
    const engine = new AtomicMemoryExtractionEngine({
      store,
      gate: async () => ({ allowed: true }),
      model: {
        async call(request) {
          calls.push(request.stage);
          if (stage === "localized")
            return JSON.stringify({
              status: "search_required",
              coverageStatus: "processed",
              requestedStatus: "unresolved",
              requestedItems: [],
              incidentalItems: [],
              search: { terms: ["历史定位材料"] },
            });
          return JSON.stringify({
            status: "complete",
            coverageStatus: "processed",
            requestedStatus: "resolved",
            requestedItems: Array.from({ length: 10 }, () => ({
              ...fields(),
              evidence: [{ sourceRef: `event:${current.eventId}`, quote: current.text }],
            })),
            incidentalItems: [],
          });
        },
      },
    });
    const result = await engine.execute(
      snapshot([historical, current], {
        contextWindowTokens: 4000,
        reservedOutputTokens: 256,
        sourceMessages: [{ role: "user", content: current.text }],
        sourceEventMessagePositions: { [current.eventId]: [0] },
      }),
    );
    assert.equal(result.status, "unavailable", stage);
    assert.deepEqual(calls, ["proposal"], stage);
    assert.equal((await store.readExtractionCursor(SESSION))?.processedOrdinal, 1, stage);
  }
});

function fixture(t: TestContext) {
  const store = new SqliteMemoryItemStore(":memory:");
  t.after(() => store.close());
  return store;
}
function event(ordinal: number, text: string, turnId: string): MemoryEvidenceEvent {
  return {
    ordinal,
    eventId: `event-${ordinal}`,
    runId: `run-${turnId}`,
    turnId,
    observedAt: 1_700_000_000_000,
    role: "user",
    text,
  };
}
function snapshot(
  events: readonly MemoryEvidenceEvent[],
  overrides: Partial<MemoryExtractionSnapshot> = {},
): MemoryExtractionSnapshot {
  const boundary = events.at(-1)!;
  return {
    deletionRevision: 0,
    trigger: "remember",
    sessionId: SESSION,
    workspaceKey: "/workspace",
    runId: boundary.runId,
    turnId: boundary.turnId,
    boundaryOrdinal: boundary.ordinal,
    boundaryEventId: boundary.eventId,
    events,
    ...overrides,
  };
}
function fields() {
  return {
    content: preference,
    kind: "preference",
    statementType: "fact",
    temporalType: "undated",
    eventStartedAt: null,
    eventEndedAt: null,
    scope: "global",
    keys: [{ key: "PostgreSQL", type: "entity" }],
  };
}
function proposal(source: MemoryEvidenceEvent) {
  return JSON.stringify({
    status: "complete",
    coverageStatus: "processed",
    requestedStatus: "resolved",
    requestedItems: [
      { ...fields(), evidence: [{ sourceRef: `event:${source.eventId}`, quote: preference }] },
    ],
    incidentalItems: [],
  });
}
function canonical() {
  return JSON.stringify({
    results: [{ candidateId: "candidate_0", status: "accepted", item: fields() }],
  });
}
