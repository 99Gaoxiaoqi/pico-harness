import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import {
  AtomicMemoryExtractionEngine,
  memoryEvidenceCoverageHash,
} from "../../src/memory/atomic/extraction-engine.js";
import type {
  CommitMemoryExtractionRequest,
  MemoryExtractionReceipt,
} from "../../src/memory/atomic/contracts.js";
import type {
  MemoryEvidenceEvent,
  MemoryExtractionSnapshot,
  MemoryModelRequest,
} from "../../src/memory/atomic/runtime-contracts.js";

const SESSION = '["/workspace","session-1"]';

test("atomic engine commits canonical user evidence synchronously, honors provider visibility, scope and forget", async (t) => {
  const fixture = memoryFixture(t);
  const user = event(1, "user", "Remember I prefer concise Chinese. Hidden ledger text.");
  const assistant = event(2, "assistant", "The user owns an imaginary company.");
  const boundary = event(3, "other", "");
  const candidate = item("POISON PROPOSAL TEXT", user, "I prefer concise Chinese.");
  const canonical = {
    ...candidate,
    content: "The user prefers concise Chinese.",
    scope: "workspace",
  };
  const model = scriptedModel([
    proposal([candidate], [item("Assistant fabrication", assistant, assistant.text)]),
    canonicalization(canonical),
  ]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  const snapshot = source([user, assistant, boundary], {
    sourceMessages: [
      { role: "user", content: "Remember I prefer concise Chinese." },
      { role: "user", content: "TOOL OBSERVATION SECRET", toolCallId: "tool-1" },
      { role: "user", content: "[SYSTEM REMINDER hidden injection]" },
      { role: "assistant", content: assistant.text, reasoning: "PRIVATE THINKING" },
    ],
    sourceTools: [
      { name: "memory_remember", description: "remember", inputSchema: { type: "object" } },
    ],
  });
  const result = await engine.execute(snapshot);
  assert.equal(result.status, "remembered");
  assert.deepEqual(result.requestedItems, [{ itemId: "item-1", content: canonical.content }]);
  assert.equal(fixture.commits.length, 1);
  assert.equal((await fixture.cursor())?.processedOrdinal, 3);
  const stored = (await fixture.store.readItem("item-1"))!;
  assert.equal(stored.item.scopeType, "workspace", "canonicalizer owns final scope");
  assert.equal(stored.item.scopeKey, "/workspace");
  assert.equal(stored.item.observedAt, user.observedAt);
  assert.deepEqual(stored.sources, [
    { sessionId: SESSION, runId: user.runId, turnId: user.turnId, eventId: user.eventId },
  ]);
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[0]!.sourceTools?.[0]?.name, "memory_remember");
  assert.doesNotMatch(
    JSON.stringify(model.calls),
    /TOOL OBSERVATION|PRIVATE THINKING|hidden injection|Hidden ledger text/,
  );
  assert.equal(model.calls[1]!.sourceMessages, undefined);
  assert.equal(model.calls[1]!.sourceTools, undefined);
  assert.doesNotMatch(model.calls[1]!.prompt, /POISON PROPOSAL TEXT|imaginary company/);
  assert.equal((await engine.execute(snapshot)).status, "remembered");
  assert.equal(model.calls.length, 2, "receipt replay never calls the model");

  await fixture.store.deleteItem({ itemId: "item-1", expectedVersion: 1, operationId: "forget-1" });
  assert.equal(
    (await engine.execute(snapshot)).status,
    "not_applicable",
    "replay cannot claim forgotten content is still saved",
  );
  const later = event(4, "other", "", "2");
  assert.equal(
    (await engine.execute(source([user, assistant, boundary, later], { deletionRevision: 1 })))
      .status,
    "not_applicable",
  );
  assert.equal(model.calls.length, 2);
});

test("atomic engine retries malformed canonicalization without rerunning the proposal", async (t) => {
  const fixture = memoryFixture(t);
  const user = event(1, "user", "Remember I prefer concise Chinese.");
  const candidate = item("The user prefers concise Chinese.", user, "I prefer concise Chinese.");
  const model = scriptedModel([
    proposal([candidate]),
    JSON.stringify({
      results: [{ candidateId: "candidate_0", status: "accepted", item: candidate }],
    }),
    canonicalization(candidate),
  ]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  assert.equal((await engine.execute(source([user, event(2, "other", "")]))).status, "remembered");
  assert.deepEqual(
    model.calls.map((call) => call.stage),
    ["proposal", "canonicalize", "canonicalize"],
  );
  assert.equal(
    fixture.commits.length,
    1,
    "the candidate with an extra evidence field never commits",
  );
});

test("atomic engine retries at most three calls per range, replays pending and discards before the next tail", async (t) => {
  const fixture = memoryFixture(t);
  const firstUser = event(1, "user", "Remember this preference.");
  const firstBoundary = event(2, "other", "");
  const secondUser = event(3, "user", "Remember that I prefer Rust.", "2");
  const secondBoundary = event(4, "other", "", "2");
  const candidate = item("The user prefers Rust.", secondUser, "I prefer Rust.");
  const model = scriptedModel([
    new Error("provider unavailable"),
    "{}",
    "{}",
    "{}",
    "{}",
    "{}",
    proposal([candidate]),
    canonicalization(candidate),
  ]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  const first = source([firstUser, firstBoundary]);
  assert.equal((await engine.execute(first)).status, "unavailable");
  assert.equal(model.calls.length, 3);
  assert.equal(await fixture.cursor(), undefined);
  assert.ok(await fixture.pending());
  assert.equal((await engine.execute(first)).status, "unavailable");
  assert.equal(model.calls.length, 3);
  const result = await engine.execute(
    source([firstUser, firstBoundary, secondUser, secondBoundary]),
  );
  assert.equal(result.status, "remembered");
  assert.equal(model.calls.length, 8, "three per old range plus two for the new tail");
  assert.equal(await fixture.pending(), undefined);
  assert.equal((await fixture.cursor())?.processedOrdinal, 4);
  assert.equal(fixture.discarded.length, 1);
  assert.deepEqual(
    fixture.commits[0]?.items[0]?.sources.map((entry) => entry.eventId),
    [secondUser.eventId],
  );
});

test("atomic engine localizes once and isolates canonicalization; gate changes never commit", async (t) => {
  const fixture = memoryFixture(t);
  const historical = event(1, "user", "I prefer functional TypeScript.");
  const assistant = event(2, "assistant", "That preference means using small pure functions.");
  await fixture.store.initializeExtractionCursor(SESSION, 2);
  const current = event(3, "user", "Remember that preference.", "2");
  const boundary = event(4, "other", "", "2");
  const candidate = item("The user prefers functional TypeScript.", historical, historical.text);
  const model = scriptedModel([
    JSON.stringify({
      status: "search_required",
      coverageStatus: "processed",
      requestedStatus: "unresolved",
      requestedItems: [],
      incidentalItems: [],
      search: { terms: ["functional"], roles: ["user"] },
    }),
    proposal([candidate]),
    canonicalization(candidate),
  ]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  assert.equal(
    (
      await engine.execute(
        source([historical, assistant, current, boundary], {
          sourceMessages: [{ role: "user", content: current.text }],
        }),
      )
    ).status,
    "remembered",
  );
  assert.deepEqual(
    model.calls.map((call) => call.stage),
    ["proposal", "localized", "canonicalize"],
  );
  assert.match(model.calls[1]!.prompt, /functional TypeScript/);
  assert.match(model.calls[2]!.prompt, /interpretationContext/);
  assert.deepEqual(
    fixture.commits[0]?.items[0]?.sources.map((entry) => entry.eventId),
    [historical.eventId],
  );

  const deniedFixture = memoryFixture(t);
  let enabled = true;
  const deniedModel = scriptedModel([
    () => {
      enabled = false;
      return proposal([candidate]);
    },
  ]);
  const deniedEngine = new AtomicMemoryExtractionEngine({
    store: deniedFixture.store,
    model: deniedModel,
    gate: async () => (enabled ? { allowed: true } : { allowed: false, reason: "disabled" }),
  });
  assert.equal((await deniedEngine.execute(source([historical, assistant]))).status, "unavailable");
  assert.equal(deniedFixture.commits.length, 0);
  assert.equal(await deniedFixture.pending(), undefined);
  assert.equal(deniedModel.calls.length, 1);
});

test("atomic engine recovers compaction before tail, bootstraps old checkpoints, and persists policy denial", async (t) => {
  const old = event(1, "user", "I prefer Chinese.");
  const oldBoundary = event(2, "other", "");
  const later = event(3, "user", "Remember I prefer detailed answers.", "2");
  const boundary = event(4, "other", "", "2");
  const checkpoint = {
    checkpointId: "checkpoint-1",
    ordinal: 2,
    throughOrdinal: 2,
    coverageHash: memoryEvidenceCoverageHash([old, oldBoundary]),
  };
  const fixture = memoryFixture(t);
  const oldItem = item("The user prefers Chinese.", old, old.text);
  const newItem = item("The user prefers detailed answers.", later, "I prefer detailed answers.");
  const model = scriptedModel([
    proposal([], [oldItem]),
    canonicalization(oldItem),
    proposal([newItem]),
    canonicalization(newItem),
  ]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  const snapshot = source([old, oldBoundary, later, boundary], { checkpoints: [checkpoint] });
  assert.equal((await engine.execute(snapshot)).status, "remembered");
  assert.deepEqual(
    fixture.commits.map((commit) => [commit.trigger, commit.nextCursorOrdinal]),
    [
      ["compaction", 2],
      ["remember", 4],
    ],
  );
  assert.doesNotMatch(JSON.stringify(model.calls[0]), /detailed answers/);
  assert.equal(model.calls[0]!.sourceTools, undefined);

  const bootstrapFixture = memoryFixture(t);
  const bootstrapModel = scriptedModel([proposal([newItem]), canonicalization(newItem)]);
  const bootstrapEngine = new AtomicMemoryExtractionEngine({
    store: bootstrapFixture.store,
    model: bootstrapModel,
    gate: async () => ({ allowed: true }),
  });
  assert.equal(
    (
      await bootstrapEngine.execute({
        ...snapshot,
        checkpoints: [{ ...checkpoint, bootstrap: true }],
      })
    ).status,
    "remembered",
  );
  assert.equal(bootstrapFixture.commits[0]?.expectedCursorOrdinal, 2);

  const deniedFixture = memoryFixture(t);
  const deniedEngine = new AtomicMemoryExtractionEngine({
    store: deniedFixture.store,
    model: scriptedModel([]),
    gate: async () => ({ allowed: false, reason: "disabled" }),
  });
  await deniedEngine.execute(
    source([old, oldBoundary], {
      trigger: "compaction",
      checkpoints: [checkpoint],
      compactionCheckpointId: checkpoint.checkpointId,
    }),
  );
  assert.equal((await deniedFixture.cursor())?.processedOrdinal, 2);
  assert.equal(deniedFixture.commits[0]?.skipReason, "policy_denied");
  assert.equal((await deniedFixture.store.readCompactionPolicyDenials(SESSION)).length, 1);

  const unavailableFixture = memoryFixture(t);
  const unavailableEngine = new AtomicMemoryExtractionEngine({
    store: unavailableFixture.store,
    model: scriptedModel([]),
    gate: async () => ({ allowed: false, reason: "session_unavailable" }),
  });
  await unavailableEngine.execute(
    source([old, oldBoundary], {
      trigger: "compaction",
      checkpoints: [checkpoint],
      compactionCheckpointId: checkpoint.checkpointId,
    }),
  );
  assert.equal(await unavailableFixture.cursor(), undefined);
  assert.deepEqual(await unavailableFixture.store.readCompactionPolicyDenials(SESSION), []);
});

test("atomic engine rejects hidden or fabricated requested citations and sensitive batches without false success", async (t) => {
  const user = event(1, "user", "Visible preference. Hidden preference.");
  const boundary = event(2, "other", "");
  const fixture = memoryFixture(t);
  const hidden = item("Hidden preference.", user, "Hidden preference.");
  const model = scriptedModel([proposal([hidden]), proposal([hidden]), proposal([hidden])]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  assert.equal(
    (
      await engine.execute(
        source([user, boundary], {
          sourceMessages: [{ role: "user", content: "Visible preference." }],
        }),
      )
    ).status,
    "unavailable",
  );
  assert.equal(fixture.commits.length, 0);
  assert.equal((await fixture.pending())?.firstFailureClass, "evidence");
  const secretFixture = memoryFixture(t);
  const secretModel = scriptedModel([]);
  const secretEngine = new AtomicMemoryExtractionEngine({
    store: secretFixture.store,
    model: secretModel,
    gate: async () => ({ allowed: true }),
  });
  const result = await secretEngine.execute(
    source([event(1, "user", "Remember my password=12345"), boundary]),
  );
  assert.equal(result.status, "not_applicable");
  assert.ok("noOpReason" in result && result.noOpReason === "sensitive_information");
  assert.equal(secretModel.calls.length, 0);
});

test("deletion invalidates queued snapshots and model results without retaining failed retries", async (t) => {
  const fixture = memoryFixture(t);
  const historical = event(1, "user", "I prefer functional TypeScript.");
  const initialEvents = [historical, event(2, "other", "")];
  const candidate = item("The user prefers functional TypeScript.", historical, historical.text);
  const initial = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    gate: async () => ({ allowed: true }),
    model: scriptedModel([proposal([candidate]), canonicalization(candidate)]),
  });
  await initial.execute(source(initialEvents));
  const current = event(3, "user", "Remember that preference.", "2");
  const snapshot = source([...initialEvents, current, event(4, "other", "", "2")]);
  let signalStarted!: () => void;
  let finishModel!: (output: string) => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const modelResult = new Promise<string>((resolve) => {
    finishModel = resolve;
  });
  let calls = 0;
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    gate: async () => ({ allowed: true }),
    model: {
      async call() {
        calls++;
        signalStarted();
        return modelResult;
      },
    },
  });
  const inFlight = engine.execute(snapshot);
  await started;
  await fixture.store.deleteItem({
    itemId: "item-1",
    expectedVersion: 1,
    operationId: "delete-in-flight",
  });
  finishModel("{}");
  assert.equal((await inFlight).status, "unavailable");
  assert.equal(await fixture.pending(), undefined);
  assert.equal((await fixture.cursor())?.processedOrdinal, 2);
  assert.equal(
    (await engine.execute(snapshot)).status,
    "unavailable",
    "queued snapshots keep their old generation",
  );
  assert.equal(calls, 1);
  assert.deepEqual(await fixture.store.listItems({ workspaceKey: "/workspace" }), []);
});

test("deletion skips an old pending remember but a new request may remember the original evidence", async (t) => {
  const fixture = memoryFixture(t);
  const historical = event(1, "user", "I prefer functional TypeScript.");
  const initialEvents = [historical, event(2, "other", "")];
  const candidate = item("The user prefers functional TypeScript.", historical, historical.text);
  const model = scriptedModel([
    proposal([candidate]),
    canonicalization(candidate),
    "{}",
    "{}",
    "{}",
    JSON.stringify({
      status: "search_required",
      coverageStatus: "processed",
      requestedStatus: "unresolved",
      requestedItems: [],
      incidentalItems: [],
      search: { terms: ["functional"], roles: ["user"] },
    }),
    proposal([candidate]),
    canonicalization(candidate),
  ]);
  const engine = new AtomicMemoryExtractionEngine({
    store: fixture.store,
    model,
    gate: async () => ({ allowed: true }),
  });
  await engine.execute(source(initialEvents));
  const failedEvents = [
    ...initialEvents,
    event(3, "user", "Remember that preference.", "2"),
    event(4, "other", "", "2"),
  ];
  assert.equal((await engine.execute(source(failedEvents))).status, "unavailable");
  assert.equal((await fixture.pending())?.deletionRevision, 0);
  await fixture.store.deleteItem({
    itemId: "item-1",
    expectedVersion: 1,
    operationId: "delete-pending",
  });
  const deletionRevision = await fixture.store.readDeletionRevision();
  const automaticEvents = [...failedEvents, event(5, "other", "", "3")];
  await engine.execute(source(automaticEvents, { trigger: "extract", deletionRevision }));
  assert.equal(model.calls.length, 5, "old explicit request is skipped without calling the model");
  assert.equal(await fixture.pending(), undefined);
  assert.equal((await fixture.cursor())?.processedOrdinal, 5);
  assert.ok(
    fixture.commits.some(
      (commit) => commit.skipReason === "memory_deleted" && commit.items.length === 0,
    ),
  );
  assert.deepEqual(await fixture.store.listItems({ workspaceKey: "/workspace" }), []);
  const current = event(
    6,
    "user",
    "Please remember my earlier functional TypeScript preference again.",
    "4",
  );
  const result = await engine.execute(
    source([...automaticEvents, current, event(7, "other", "", "4")], {
      deletionRevision,
      sourceMessages: [{ role: "user", content: current.text }],
    }),
  );
  assert.equal(result.status, "remembered");
  assert.equal(model.calls.length, 8);
  assert.deepEqual(
    (await fixture.store.readItem(result.requestedItems[0]!.itemId))?.sources.map(
      (source) => source.eventId,
    ),
    [historical.eventId],
  );
});

function event(
  ordinal: number,
  role: MemoryEvidenceEvent["role"],
  text: string,
  suffix = "1",
): MemoryEvidenceEvent {
  return {
    ordinal,
    eventId: `event-${ordinal}`,
    runId: `run-${suffix}`,
    turnId: `turn-${suffix}`,
    observedAt: 1_700_000_000_000 + ordinal * 60_000,
    role,
    text,
  };
}
function source(
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
function item(content: string, event: MemoryEvidenceEvent, quote: string) {
  return {
    content,
    kind: "preference",
    statementType: "fact",
    temporalType: "undated",
    eventStartedAt: null,
    eventEndedAt: null,
    scope: "global",
    keys: [{ key: "user preference", type: "concept" }],
    evidence: [{ sourceRef: `event:${event.eventId}`, quote }],
  };
}
function proposal(
  requestedItems: readonly ReturnType<typeof item>[],
  incidentalItems: readonly ReturnType<typeof item>[] = [],
): string {
  return JSON.stringify({
    status: "complete",
    coverageStatus: "processed",
    requestedStatus: requestedItems.length ? "resolved" : "not_applicable",
    requestedItems,
    incidentalItems,
  });
}
function canonicalization(...items: readonly ReturnType<typeof item>[]): string {
  return JSON.stringify({
    results: items.map(({ evidence: _evidence, ...item }, index) => ({
      candidateId: `candidate_${index}`,
      status: "accepted",
      item,
    })),
  });
}
function scriptedModel(outputs: readonly (string | Error | (() => string))[]) {
  const calls: MemoryModelRequest[] = [];
  return {
    calls,
    async call(request: MemoryModelRequest): Promise<string> {
      calls.push(request);
      const output = outputs[calls.length - 1];
      assert.notEqual(output, undefined, `unexpected model call ${request.stage}`);
      if (output instanceof Error) throw output;
      return typeof output === "function" ? output() : output!;
    },
  };
}

/** A real SQLite store, with observation wrappers only; no admission/store behavior is stubbed. */
function memoryFixture(t: TestContext) {
  let nextId = 0;
  const store = new SqliteMemoryItemStore(":memory:", {
    now: () => 1_700_001_000_000,
    idFactory: () => `item-${++nextId}`,
  });
  t.after(() => store.close());
  const commits: CommitMemoryExtractionRequest[] = [];
  const discarded: MemoryExtractionReceipt[] = [];
  const commit = store.commitExtraction.bind(store);
  store.commitExtraction = async (request) => {
    const result = await commit(request);
    commits.push(request);
    return result;
  };
  const settle = store.settleExtractionFailure.bind(store);
  store.settleExtractionFailure = async (request) => {
    const result = await settle(request);
    if (result.status === "discarded") discarded.push(result.receipt);
    return result;
  };
  return {
    store,
    commits,
    discarded,
    cursor: () => store.readExtractionCursor(SESSION),
    pending: () => store.readPendingExtractionFailure(SESSION),
  };
}
