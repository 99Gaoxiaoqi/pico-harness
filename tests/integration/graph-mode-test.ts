import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GraphConflictError,
  normalizeGraphWorkInput,
  recordIdFor,
  workIdFor,
} from "../../src/graph/contract.js";
import { computeReadyWorks, hasPendingWorks } from "../../src/graph/graph-reconcile.js";
import { projectGraphEntries, reduceGraphEvent } from "../../src/graph/graph-reducer.js";
import { findOrphanGraphWorks } from "../../src/graph/graph-recover.js";
import {
  AddWorkTool,
  CloseGraphTool,
  ViewGraphTool,
  graphOperationFingerprint,
  type GraphToolContext,
} from "../../src/tools/graph-tools.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../../src/storage/runtime-event.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";

const AT = new Date("2026-08-11T00:00:00.000Z");
const SESSION_ID = "graph-session-1";
const GRAPH_ID = `graph:${SESSION_ID}`;

interface Fixture {
  root: string;
  store: RuntimeEventStore;
  context: GraphToolContext;
}

async function setupFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-graph-mode-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  const store = new RuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: SESSION_ID, workDir });
  const context: GraphToolContext = {
    store,
    sessionId: SESSION_ID,
    graphId: GRAPH_ID,
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
  };
  return { root, store, context };
}

function projectionSnapshot(store: RuntimeEventStore): Promise<ReturnType<typeof projectGraphEntries>> {
  return store.readSessionEntries(SESSION_ID).then((entries) => projectGraphEntries(GRAPH_ID, entries));
}

test("normalizeGraphWorkInput trims instruction and defaults mode to explore", () => {
  const normalized = normalizeGraphWorkInput({
    instruction: "  Find the auth module  ",
    inputIds: ["record_a"],
  });
  assert.equal(normalized.instruction, "Find the auth module");
  assert.deepEqual([...normalized.inputIds], ["record_a"]);
  assert.equal(normalized.mode, "explore");
});

test("normalizeGraphWorkInput rejects empty instruction", () => {
  assert.throws(
    () => normalizeGraphWorkInput({ instruction: "   " }),
    GraphConflictError,
  );
});

test("normalizeGraphWorkInput rejects blank input ids", () => {
  assert.throws(
    () => normalizeGraphWorkInput({ instruction: "ok", inputIds: ["  "] }),
    GraphConflictError,
  );
});

test("workIdFor is deterministic for identical (graphId, instruction, inputIds)", () => {
  const a = workIdFor(GRAPH_ID, "do thing", ["r1", "r2"]);
  const b = workIdFor(GRAPH_ID, "do thing", ["r2", "r1"]); // order-insensitive
  const c = workIdFor(GRAPH_ID, "do thing", []);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith("work_"));
});

test("recordIdFor is deterministic for (graphId, workId)", () => {
  const a = recordIdFor(GRAPH_ID, "work_abc");
  const b = recordIdFor(GRAPH_ID, "work_abc");
  const c = recordIdFor(GRAPH_ID, "work_other");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith("record_"));
});

test("graphOperationFingerprint is stable for identical semantic input", () => {
  const a = graphOperationFingerprint("graph.work.added", { workId: "w1", instruction: "x" });
  const b = graphOperationFingerprint("graph.work.added", { instruction: "x", workId: "w1" });
  const c = graphOperationFingerprint("graph.work.added", { workId: "w1", instruction: "y" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith("sha256:"));
});

test("AddWorkTool writes graph.work.added and dispatches when inputs are ready", async (t) => {
  const { root, store, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  let dispatched: { workId: string; instruction: string; mode: string } | undefined;
  const tool = new AddWorkTool(
    context,
    async (input) => {
      dispatched = input;
      return "delegation-1";
    },
    () => AT,
  );

  const result = JSON.parse(await tool.execute(JSON.stringify({ instruction: "Explore auth" }))) as {
    workId: string;
    status: string;
    delegationId: string;
  };
  assert.equal(result.status, "dispatched");
  assert.equal(result.delegationId, "delegation-1");
  assert.ok(dispatched, "dispatcher was invoked");

  const projection = await projectionSnapshot(store);
  assert.equal(projection.works.length, 1);
  assert.equal(projection.works[0]!.status, "dispatched");
  assert.equal(projection.works[0]!.delegationId, "delegation-1");
});

test("AddWorkTool with unmet input_ids stays waiting", async (t) => {
  const { root, store, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  let dispatched = false;
  const tool = new AddWorkTool(
    context,
    async () => {
      dispatched = true;
      return "delegation-x";
    },
    () => AT,
  );

  const result = JSON.parse(
    await tool.execute(
      JSON.stringify({ instruction: "Aggregate findings", input_ids: ["record_missing"] }),
    ),
  ) as { workId: string; status: string };
  assert.equal(result.status, "waiting");
  assert.equal(dispatched, false);

  const projection = await projectionSnapshot(store);
  assert.equal(projection.works[0]!.status, "requested");
});

test("AddWorkTool deduplicates identical work on replay (idempotent)", async (t) => {
  const { root, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const tool = new AddWorkTool(
    context,
    async () => "delegation-replay",
    () => AT,
  );
  const first = JSON.parse(await tool.execute(JSON.stringify({ instruction: "Same work" }))) as {
    workId: string;
  };
  const second = JSON.parse(await tool.execute(JSON.stringify({ instruction: "Same work" }))) as {
    workId: string;
  };
  assert.equal(first.workId, second.workId);
});

test("AddWorkTool dispatches after upstream record is committed (DAG dependency)", async (t) => {
  const { root, store, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  // First, add an upstream work with no inputs and let it produce a record.
  const upstreamInstruction = "Produce artifact A";
  const upstreamWorkId = workIdFor(GRAPH_ID, upstreamInstruction, []);
  const upstreamRecordId = recordIdFor(GRAPH_ID, upstreamWorkId);
  let dispatchCount = 0;
  const upstreamTool = new AddWorkTool(
    context,
    async () => {
      dispatchCount++;
      return "delegation-upstream";
    },
    () => AT,
  );
  await upstreamTool.execute(JSON.stringify({ instruction: upstreamInstruction }));

  // Manually commit the upstream record (settleGraphWork does this in the real host).
  await commitRecord(store, context, upstreamWorkId, upstreamRecordId, "artifact A summary");

  // Now declare a downstream work depending on that record.
  const downstreamTool = new AddWorkTool(
    context,
    async () => {
      dispatchCount++;
      return "delegation-downstream";
    },
    () => AT,
  );
  const downstreamResult = JSON.parse(
    await downstreamTool.execute(
      JSON.stringify({ instruction: "Consume A", input_ids: [upstreamRecordId] }),
    ),
  ) as { status: string };
  assert.equal(downstreamResult.status, "dispatched");
  assert.ok(dispatchCount >= 2);
});

test("ViewGraphTool renders works and records", async (t) => {
  const { root, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const addTool = new AddWorkTool(context, async () => "delegation-1", () => AT);
  await addTool.execute(JSON.stringify({ instruction: "Work one" }));

  const viewTool = new ViewGraphTool(context);
  const projection = JSON.parse(await viewTool.execute("{}")) as {
    works: Array<{ workId: string; instruction: string; status: string }>;
    records: unknown[];
    status: string;
  };
  assert.equal(projection.status, "active");
  assert.equal(projection.works.length, 1);
  assert.equal(projection.works[0]!.instruction, "Work one");
  assert.deepEqual(projection.records, []);
});

test("ViewGraphTool hides records when include_records is false", async (t) => {
  const { root, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const addTool = new AddWorkTool(context, async () => "delegation-1", () => AT);
  await addTool.execute(JSON.stringify({ instruction: "Work one" }));

  const viewTool = new ViewGraphTool(context);
  const projection = JSON.parse(
    await viewTool.execute(JSON.stringify({ include_records: false })),
  ) as { records?: unknown[] };
  assert.equal(projection.records, undefined);
});

test("CloseGraphTool marks the graph closed", async (t) => {
  const { root, store, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const closeTool = new CloseGraphTool(context, () => AT);
  const result = JSON.parse(await closeTool.execute("{}")) as { status: string };
  assert.equal(result.status, "closed");

  const projection = await projectionSnapshot(store);
  assert.equal(projection.status, "closed");
});

test("CloseGraphTool rejects unknown result_record_ids", async (t) => {
  const { root, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const closeTool = new CloseGraphTool(context, () => AT);
  await assert.rejects(
    closeTool.execute(JSON.stringify({ result_record_ids: ["record_missing"] })),
    GraphConflictError,
  );
});

test("CloseGraphTool is idempotent on already-closed graph", async (t) => {
  const { root, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const closeTool = new CloseGraphTool(context, () => AT);
  await closeTool.execute("{}");
  const second = JSON.parse(await closeTool.execute("{}")) as {
    status: string;
    alreadyClosed: boolean;
  };
  assert.equal(second.status, "closed");
  assert.equal(second.alreadyClosed, true);
});

test("computeReadyWorks returns only requested works whose inputs are committed", () => {
  const baseState = {
    graphId: GRAPH_ID,
    sessionSequence: 10,
    status: "active" as const,
    works: [
      {
        workId: "w-ready",
        instruction: "ready",
        inputIds: ["r-done"],
        mode: "explore" as const,
        status: "requested" as const,
      },
      {
        workId: "w-waiting",
        instruction: "waiting",
        inputIds: ["r-missing"],
        mode: "worker" as const,
        status: "requested" as const,
      },
      {
        workId: "w-dispatched",
        instruction: "dispatched",
        inputIds: [],
        mode: "explore" as const,
        status: "dispatched" as const,
      },
    ],
    records: [{ recordId: "r-done", workId: "w-other", outputSummary: "done" }],
  };
  const ready = computeReadyWorks(baseState);
  assert.deepEqual(
    ready.map((w) => w.workId),
    ["w-ready"],
  );
});

test("computeReadyWorks is empty when graph is closed", () => {
  const state = {
    graphId: GRAPH_ID,
    sessionSequence: 0,
    status: "closed" as const,
    works: [
      {
        workId: "w",
        instruction: "x",
        inputIds: [],
        mode: "explore" as const,
        status: "requested" as const,
      },
    ],
    records: [],
  };
  assert.equal(computeReadyWorks(state).length, 0);
});

test("hasPendingWorks detects requested and dispatched works", () => {
  const active = {
    graphId: GRAPH_ID,
    sessionSequence: 0,
    status: "active" as const,
    works: [
      {
        workId: "w",
        instruction: "x",
        inputIds: [],
        mode: "explore" as const,
        status: "dispatched" as const,
      },
    ],
    records: [],
  };
  assert.equal(hasPendingWorks(active), true);
  const allRecorded = {
    ...active,
    works: [{ ...active.works[0]!, status: "recorded" as const }],
  };
  assert.equal(hasPendingWorks(allRecorded), false);
});

test("reduceGraphEvent replays idempotently for duplicate graph.work.added", () => {
  let state = projectGraphEntries(GRAPH_ID, []);
  const event: RuntimeEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "graph:op1:added",
    sessionId: SESSION_ID,
    invocationId: "inv",
    runId: "run",
    turnId: "turn",
    at: AT.toISOString(),
    partial: false,
    visibility: "internal",
    kind: "graph.work.added",
    data: {
      operationId: "op1",
      fingerprint: "sha256:" + "a".repeat(64),
      graphId: GRAPH_ID,
      workId: "work_dup",
      instruction: "dup",
      inputIds: [],
      mode: "explore",
    },
  };
  state = reduceGraphEvent(state, event);
  state = reduceGraphEvent(state, event); // replay
  assert.equal(state.works.length, 1);
});

test("findOrphanGraphWorks detects dispatched works whose run terminated", async (t) => {
  const { root, store, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  // Add a work and dispatch it.
  const addTool = new AddWorkTool(context, async () => "delegation-orphan", () => AT);
  await addTool.execute(JSON.stringify({ instruction: "orphaned work" }));

  // Emit a run.terminal for the delegation id (orphan scan uses delegationId as runId).
  await store.append({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "term-1",
    sessionId: SESSION_ID,
    invocationId: "inv",
    runId: "delegation-orphan",
    turnId: "turn",
    at: AT.toISOString(),
    partial: false,
    visibility: "internal",
    kind: "run.terminal",
    data: { status: "interrupted" },
  });

  const result = await findOrphanGraphWorks({
    runtimeStore: store,
    sessionId: SESSION_ID,
    graphId: GRAPH_ID,
  });
  assert.ok(result.orphanWorkIds.length >= 1);
  const projection = result.projection;
  const orphan = projection.works.find(
    (w) => w.status === "dispatched" && w.delegationId === "delegation-orphan",
  );
  assert.ok(orphan, "dispatched work still present in projection");
});

test("findOrphanGraphWorks returns empty when no runs terminated", async (t) => {
  const { root, store, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const addTool = new AddWorkTool(context, async () => "delegation-live", () => AT);
  await addTool.execute(JSON.stringify({ instruction: "live work" }));

  const result = await findOrphanGraphWorks({
    runtimeStore: store,
    sessionId: SESSION_ID,
    graphId: GRAPH_ID,
  });
  assert.deepEqual([...result.orphanWorkIds], []);
});

test("appendGraphOperation CAS rejects conflicting fingerprint for same operationId", async (t) => {
  const { root, context } = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const tool = new AddWorkTool(context, async () => "delegation-1", () => AT);
  await tool.execute(JSON.stringify({ instruction: "first", operationId: "op-shared" }));

  // Same operationId but different semantic payload (different instruction) must conflict.
  await assert.rejects(
    tool.execute(JSON.stringify({ instruction: "different", operationId: "op-shared" })),
  );
});

async function commitRecord(
  store: RuntimeEventStore,
  context: GraphToolContext,
  workId: string,
  recordId: string,
  outputSummary: string,
): Promise<void> {
  const operationId = `manual-record:${workId}`;
  const fingerprint = graphOperationFingerprint("graph.work.recorded", {
    graphId: context.graphId,
    workId,
    recordId,
    outputSummary,
  });
  const projection = await projectionSnapshot(store);
  const event: RuntimeEvent = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: `graph:${operationId}:recorded`,
    sessionId: context.sessionId,
    invocationId: context.invocationId,
    runId: context.runId,
    turnId: context.turnId,
    at: AT.toISOString(),
    partial: false,
    visibility: "internal",
    kind: "graph.work.recorded",
    data: {
      operationId,
      fingerprint,
      graphId: context.graphId,
      workId,
      recordId,
      outputSummary,
    },
  };
  await store.appendGraphOperation([event], {
    operationId,
    fingerprint,
    expectedSessionSequence: projection.sessionSequence,
  });
}
