import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import type { RuntimeEventStoreEntry } from "../../src/storage/runtime-event-store-contracts.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SilentReporter } from "../../src/engine/reporter.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";

import { projectGraphEntries } from "../../src/graph/graph-reducer.js";
import { configuredUserDefaultRealModel, type RealModel } from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 10 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

interface TestSandbox {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
  readonly graphId: string;
}

async function createSandbox(label: string): Promise<TestSandbox> {
  const root = await mkdtemp(join(tmpdir(), `pico-graph-multi-${label}-`));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const sessionId = `graph-multi-${label}-${randomUUID()}`;
  return { root, workDir, picoHome, sessionId, graphId: `graph:${sessionId}` };
}

async function cleanupSandbox(sandbox: TestSandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}

async function readRuntimeEvents(sandbox: TestSandbox): Promise<RuntimeEvent[]> {
  return (await readRuntimeEventEntries(sandbox)).map((entry) => entry.event);
}

async function readRuntimeEventEntries(sandbox: TestSandbox): Promise<RuntimeEventStoreEntry[]> {
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(sandbox.workDir, { picoHome: sandbox.picoHome }).workspace.root,
  });
  try {
    return await store.readSessionEntries(sandbox.sessionId);
  } finally {
    store.close();
  }
}

function modelRequest(
  model: RealModel,
): Pick<
  RunAgentCliOptions,
  | "provider"
  | "baseURL"
  | "apiKey"
  | "model"
  | "modelRouteId"
  | "modelCapabilities"
  | "thinkingEffort"
> {
  return {
    provider: model.provider,
    baseURL: model.config.baseURL,
    apiKey: model.config.apiKey,
    model: model.config.model,
    modelRouteId: model.route.id,
    modelCapabilities: model.route.capabilities,
    ...(supportsThinkingOff(model.route) ? { thinkingEffort: "off" } : {}),
  };
}

function runtimeHost(sandbox: TestSandbox, model: RealModel): RunAgentCliDependencies {
  return {
    picoHome: sandbox.picoHome,
    env: process.env,
    modelRouter: model.runtime.router,
    reporter: new SilentReporter(),
  };
}

function supportsThinkingOff(route: ModelRoute): boolean {
  const profile = route.capabilities.reasoningProfile;
  return profile.enabled === true && profile.levels.includes("off");
}

const GRAPH_TOOLS = [
  "read_file",
  "write_file",
  "add_work",
  "view_graph",
  "close_graph",
  "delegate_task",
] as const;

function runOptions(
  model: RealModel,
  sandbox: TestSandbox,
  prompt: string,
  sessionMode: "new" | "resume",
): RunAgentCliOptions {
  return {
    ...modelRequest(model),
    prompt,
    dir: sandbox.workDir,
    sessionSelection: { mode: sessionMode, sessionId: sandbox.sessionId },
    interactionMode: "yolo",
    orchestrationMode: "graph",
    allowedTools: [...GRAPH_TOOLS],
  };
}

// ============================================================
// Diagnostic helpers — dump the graph projection + event stream
// so every run produces a reviewable artifact for analysis.
// ============================================================

function dumpGraph(
  label: string,
  entries: readonly RuntimeEventStoreEntry[],
  sandbox: TestSandbox,
): void {
  const projection = projectGraphEntries(sandbox.graphId, entries);
  console.log(`\n===== [${label}] graph projection =====`);
  console.log(
    JSON.stringify(
      {
        status: projection.status,
        sessionSequence: projection.sessionSequence,
        works: projection.works.map((work) => ({
          workId: work.workId,
          instruction: work.instruction.slice(0, 60),
          inputIds: work.inputIds,
          status: work.status,
          recordId: work.recordId,
        })),
        records: projection.records.map((record) => ({
          recordId: record.recordId,
          workId: record.workId,
          outputSummary: record.outputSummary.slice(0, 80),
        })),
      },
      null,
      2,
    ),
  );
}

function dumpEventStream(events: readonly RuntimeEvent[]): void {
  const graphEvents = events.filter((e) => e.kind.startsWith("graph."));
  console.log("\n===== graph event stream =====");
  for (const event of graphEvents) {
    const data = event.data as Record<string, unknown>;
    switch (event.kind) {
      case "graph.work.added":
        console.log(
          `+ added    ${String(data["workId"])} mode=${String(data["mode"])} input_ids=[${String(data["inputIds"])}]`,
        );
        break;
      case "graph.work.dispatched":
        console.log(
          `+ dispatch ${String(data["workId"])} delegation=${String(data["delegationId"])}`,
        );
        break;
      case "graph.work.recorded":
        console.log(
          `+ recorded ${String(data["workId"])} -> ${String(data["recordId"])} summary="${String(data["outputSummary"]).slice(0, 60)}"`,
        );
        break;
      case "graph.work.failed":
        console.log(
          `+ failed   ${String(data["workId"])} error="${String(data["error"]).slice(0, 80)}"`,
        );
        break;
      case "graph.closed":
        console.log(`+ closed   result_records=[${String(data["resultRecordIds"])}]`);
        break;
    }
  }
}

// ============================================================
// Scenario 1: Multi-round incremental expansion (the core pitch)
// Round 1 opens the graph and completes work A; round 2 (resume)
// appends work B that depends on A's record, then closes.
// ============================================================

realModelTest(
  "graph multi-round: resume session, append dependent work via input_ids, close",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("incremental");
    context.after(() => cleanupSandbox(sandbox));

    const runtime = new AgentRuntime();

    // Round 1: create the base file, do NOT close the graph.
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "Use add_work to create a file base.txt with content: BASE.",
          "Wait for the work to complete. Do NOT call close_graph yet — keep the graph open.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model),
    );

    // Round 2: resume the same session, append a dependent work referencing
    // round 1's record id, then close.
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "The graph from the previous round is still open. base.txt was created by a graph work.",
          "Use view_graph to find the recordId of the completed work, then use add_work with input_ids referencing that recordId to create derived.txt with content: DERIVED.",
          "After it completes, call close_graph with both record ids.",
        ].join("\n"),
        "resume",
      ),
      runtimeHost(sandbox, model),
    );

    const events = await readRuntimeEvents(sandbox);
    const entries = await readRuntimeEventEntries(sandbox);
    const projection = projectGraphEntries(sandbox.graphId, entries);
    dumpGraph("T1 incremental", entries, sandbox);
    dumpEventStream(events);

    // Both works were added and settled.
    const works = projection.works;
    assert.ok(works.length >= 2, "expected at least 2 works across two rounds");
    const settled = works.filter((w) => w.status === "recorded");
    assert.ok(settled.length >= 2, `expected >=2 recorded works, got ${settled.length}`);

    // The dependent work must reference an existing record via input_ids.
    const dependents = works.filter((w) => w.inputIds.length > 0);
    assert.ok(dependents.length >= 1, "expected a dependent work with input_ids");
    const knownRecords = new Set(projection.records.map((r) => r.recordId));
    for (const dependent of dependents) {
      for (const input of dependent.inputIds) {
        assert.ok(knownRecords.has(input), `input_ids ${input} must resolve to a committed record`);
      }
    }

    // Both files should exist (created by delegated subagents).
    for (const file of ["base.txt", "derived.txt"]) {
      const content = await readFile(join(sandbox.workDir, file), "utf8").catch(() => "");
      console.log(`[T1] ${file} = "${content.trim()}"`);
    }

    // Graph must be closed after round 2.
    assert.ok(projection.status === "closed", "graph must be closed after round 2");
  },
);

// ============================================================
// Scenario 2: Failure propagation
// Work A is designed to fail (subagent cannot read a missing file);
// work B depends on A. How does the model/system handle the
// never-satisfiable dependency? Does the run stall or hang?
// ============================================================

realModelTest(
  "graph multi-round: dependent work on a failing upstream — model response",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("failure");
    context.after(() => cleanupSandbox(sandbox));

    const runtime = new AgentRuntime();
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "Dispatch two graph works with add_work:",
          "1. Work A: read the file missing.txt (which does NOT exist) and write its content to report.txt.",
          "2. Work B: depends on work A's output record (use input_ids referencing A's future recordId), and should summarize report.txt into summary.txt.",
          "Wait for both to finish, then close_graph when you consider the graph complete.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model),
    );

    const events = await readRuntimeEvents(sandbox);
    const entries = await readRuntimeEventEntries(sandbox);
    const projection = projectGraphEntries(sandbox.graphId, entries);
    dumpGraph("T2 failure", entries, sandbox);
    dumpEventStream(events);

    // Key observation: subagents report "cannot complete" as a *successful*
    // completion (recorded), not as an error. So the failure-propagation path
    // (failed event + never-ready downstream) is rarely reachable in practice —
    // the lie is committed as a record and the chain continues.
    const works = projection.works;
    const failed = works.filter((w) => w.status === "failed");
    console.log(`[T2] failed works: ${failed.length}`);
    if (failed.length === 0) {
      console.log(
        "[T2] OBSERVATION: no work failed — subagent reported task-impossible as completed. " +
          "Downstream works were dispatched and recorded despite upstream not delivering its goal.",
      );
    }
    // How did the main agent treat the unverifiable upstream output?
    for (const work of works) {
      const record = projection.records.find((r) => r.workId === work.workId);
      console.log(
        `[T2] work ${work.status}: ${work.instruction.slice(0, 40)}` +
          (record ? ` | summary="${record.outputSummary.slice(0, 90)}"` : ""),
      );
    }
    const pendingAfter = works.filter((w) => w.status === "requested" || w.status === "dispatched");
    console.log(`[T2] pending works at end: ${pendingAfter.length}`);
    console.log(`[T2] graph status: ${projection.status}`);
  },
);

// ============================================================
// Scenario 5: Wrong/stale id in input_ids → deadlock
// A real user mistake: referencing the workId (or a guessed id)
// instead of the upstream recordId. The work can never become
// ready. Does the system surface the missing-input problem, or
// does the model burn continuation turns and give up?
// ============================================================

realModelTest(
  "graph multi-round: input_ids referencing a wrong id — deadlock feedback quality",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("deadlock");
    context.after(() => cleanupSandbox(sandbox));

    const runtime = new AgentRuntime();
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "Dispatch two graph works with add_work:",
          "1. First work: create base.txt with content: BASE.",
          "2. Second work: create derived.txt with content: DERIVED, and set input_ids to the FIRST add_work's returned work id (the work_... string you got back from the first add_work call).",
          "Use the work id exactly as returned — do not invent or derive anything.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model),
    );

    const events = await readRuntimeEvents(sandbox);
    const entries = await readRuntimeEventEntries(sandbox);
    const projection = projectGraphEntries(sandbox.graphId, entries);
    dumpGraph("T5 deadlock", entries, sandbox);
    dumpEventStream(events);

    const works = projection.works;
    for (const work of works) {
      console.log(
        `[T5] work ${work.status} input_ids=[${work.inputIds.join(",")}] instr="${work.instruction.slice(0, 40)}"`,
      );
    }
    const stuck = works.filter(
      (w) =>
        w.status === "requested" &&
        w.inputIds.length > 0 &&
        !w.inputIds.every((id) => projection.records.some((r) => r.recordId === id)),
    );
    console.log(`[T5] works stuck waiting on unresolvable input_ids: ${stuck.length}`);
    const pending = works.filter((w) => w.status === "requested" || w.status === "dispatched");
    console.log(`[T5] total pending at end: ${pending.length}; graph status: ${projection.status}`);
    console.log(
      `[T5] close called with pending work: ${projection.status === "closed" && pending.length > 0}`,
    );
  },
);

// ============================================================
// Scenario 6: FORCED add_work after close_graph
// Unlike T3, the model is explicitly told to use add_work for the
// second file. AddWorkTool does not check projection.status —
// on a closed graph it writes graph.work.added and returns
// status "waiting" with no dispatch ever. Does the model get
// misled, or does it recover?
// ============================================================

realModelTest(
  "graph multi-round: forced add_work after close_graph — tool feedback quality",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("afterclose2");
    context.after(() => cleanupSandbox(sandbox));

    const runtime = new AgentRuntime();

    // Round 1: complete a work and close the graph cleanly.
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "Use add_work to create a file first.txt with content: FIRST.",
          "Wait for it to complete, then call close_graph with its record id.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model),
    );

    // Round 2: force add_work on the already-closed graph. No fallback hint.
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "The graph from the previous round is closed. You now need second.txt with content: SECOND.",
          "Use add_work to declare the new work. You must use the graph tooling.",
        ].join("\n"),
        "resume",
      ),
      runtimeHost(sandbox, model),
    );

    const events = await readRuntimeEvents(sandbox);
    const entries = await readRuntimeEventEntries(sandbox);
    const projection = projectGraphEntries(sandbox.graphId, entries);
    dumpGraph("T6 forced-after-close", entries, sandbox);
    dumpEventStream(events);

    const works = projection.works;
    const closeIndex = events.findIndex((e) => e.kind === "graph.closed");
    const addedAfterClose =
      closeIndex >= 0 ? events.slice(closeIndex).filter((e) => e.kind === "graph.work.added") : [];
    console.log(
      `[T6] works total: ${works.length}; added events after close: ${addedAfterClose.length}`,
    );
    for (const work of works) {
      console.log(
        `[T6] work ${work.status} input_ids=[${work.inputIds.join(",")}] instr="${work.instruction.slice(0, 40)}"`,
      );
    }

    // The closed graph must reject new work: no added event may be committed
    // after close, and no dispatch may follow.
    const pending = works.filter((w) => w.status === "requested" || w.status === "dispatched");
    console.log(`[T6] pending works: ${pending.length}`);
    if (addedAfterClose.length > 0) {
      console.log(
        "[T6] OBSERVATION: add_work accepted a new work on a CLOSED graph — it will never be dispatched. " +
          "The tool returned waiting instead of rejecting.",
      );
    }
    assert.ok(
      addedAfterClose.length === 0,
      "add_work must reject (GraphConflictError) after the graph is closed — no added event allowed",
    );
    const content = await readFile(join(sandbox.workDir, "second.txt"), "utf8").catch(() => "");
    console.log(`[T6] second.txt = "${content.trim()}"`);
  },
);

// ============================================================
// Scenario 3: add_work AFTER close_graph
// Round 1 completes a work and closes the graph. Round 2 resumes
// and tries to add more work. Does the tool mislead the model
// (e.g. returning waiting with no error, no dispatch, no close
// re-open)? What does the model do?
// ============================================================

realModelTest(
  "graph multi-round: add_work after close_graph — tool feedback quality",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("afterclose");
    context.after(() => cleanupSandbox(sandbox));

    const runtime = new AgentRuntime();

    // Round 1: complete a work and close the graph cleanly.
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "Use add_work to create a file first.txt with content: FIRST.",
          "Wait for it to complete, then call close_graph with its record id.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model),
    );

    // Round 2: try to append work to the closed graph.
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "The graph was closed in the previous round. Now you need a second file second.txt with content: SECOND.",
          "If the graph tools are usable, add a work for it; otherwise fall back to creating the file directly with write_file.",
        ].join("\n"),
        "resume",
      ),
      runtimeHost(sandbox, model),
    );

    const events = await readRuntimeEvents(sandbox);
    const entries = await readRuntimeEventEntries(sandbox);
    const projection = projectGraphEntries(sandbox.graphId, entries);
    dumpGraph("T3 after-close", entries, sandbox);
    dumpEventStream(events);

    const works = projection.works;
    const postCloseAdded = works.filter(
      (w) => w.status === "requested" || w.status === "dispatched",
    );
    console.log(
      `[T3] works after closed graph: ${works.length}, still pending: ${postCloseAdded.length}`,
    );

    // second.txt should exist one way or another (direct write is acceptable).
    const content = await readFile(join(sandbox.workDir, "second.txt"), "utf8").catch(() => "");
    console.log(`[T3] second.txt = "${content.trim()}"`);

    // Hard question: any work added after close must NOT be dispatched —
    // it would be a lie if the tool claimed it would run.
    const closeIndex = events.findIndex((e) => e.kind === "graph.closed");
    if (closeIndex >= 0) {
      const addedAfterClose = events.slice(closeIndex).filter((e) => e.kind === "graph.work.added");
      const dispatchedAfterClose = events
        .slice(closeIndex)
        .filter((e) => e.kind === "graph.work.dispatched");
      console.log(`[T3] added events after close: ${addedAfterClose.length}`);
      console.log(`[T3] dispatched events after close: ${dispatchedAfterClose.length}`);
      assert.ok(
        dispatchedAfterClose.length === 0,
        "no work may be dispatched after the graph is closed",
      );
    }
  },
);

// ============================================================
// Scenario 4: Larger mixed load — 3 independent + 1 aggregator
// Tests model tracking ability at moderate scale and whether the
// close_graph result record list is used correctly.
// ============================================================

realModelTest(
  "graph multi-round: 3 parallel works + aggregator downstream, close with result records",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("load");
    context.after(() => cleanupSandbox(sandbox));

    const runtime = new AgentRuntime();
    await runtime.execute(
      runOptions(
        model,
        sandbox,
        [
          "Dispatch graph work with add_work:",
          "- alpha.txt with content: ALPHA",
          "- beta.txt with content: BETA",
          "- gamma.txt with content: GAMMA",
          "These three are independent — submit them as separate add_work calls with no input_ids.",
          "After all three complete, dispatch one aggregator work with input_ids referencing all three recordIds: read the three files and write summary.txt combining their contents.",
          "Wait for the aggregator, then close_graph listing all four record ids.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model),
    );

    const events = await readRuntimeEvents(sandbox);
    const entries = await readRuntimeEventEntries(sandbox);
    const projection = projectGraphEntries(sandbox.graphId, entries);
    dumpGraph("T4 load", entries, sandbox);
    dumpEventStream(events);

    const works = projection.works;
    assert.ok(works.length >= 4, `expected >=4 works, got ${works.length}`);
    const recorded = works.filter((w) => w.status === "recorded");
    assert.ok(recorded.length >= 4, `expected >=4 recorded works, got ${recorded.length}`);

    // The aggregator must have referenced all three upstream records.
    const aggregators = works.filter((w) => w.inputIds.length >= 3);
    assert.ok(aggregators.length >= 1, "expected an aggregator work with >=3 input_ids");
    for (const aggregator of aggregators) {
      assert.ok(
        aggregator.status === "recorded",
        `aggregator must be recorded, got ${aggregator.status}`,
      );
    }

    // All four files present.
    for (const file of ["alpha.txt", "beta.txt", "gamma.txt", "summary.txt"]) {
      const content = await readFile(join(sandbox.workDir, file), "utf8").catch(() => "");
      console.log(`[T4] ${file} = "${content.trim().slice(0, 60)}"`);
    }

    // No pending work should remain at the end.
    const pending = works.filter((w) => w.status === "requested" || w.status === "dispatched");
    console.log(`[T4] pending works at end: ${pending.length}`);
    assert.ok(pending.length === 0, `all works must settle, got ${pending.length} pending`);

    assert.ok(projection.status === "closed", "graph must be closed");
  },
);
