import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { SqliteAgentGraphControlStoreAdapter } from "../../../src/agent-graph/sqlite-control-store-adapter.js";
import { SessionManager } from "../../../src/engine/session-manager.js";
import type { PersistedSessionSettings } from "../../../src/engine/session-runtime.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { PlanCoordinator } from "../../../src/plan/coordinator.js";
import { AgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { createAgentGraphWorkspaceHost } from "../../../src/runtime/agent-graph-host.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../../src/storage/runtime-event.js";
import { SqliteAgentGraphControlStore } from "../../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";

const SETTINGS: PersistedSessionSettings = {
  provider: "openai",
  model: "test",
  modelRouteId: "openai/test",
  collaborationMode: "plan",
  orchestrationMode: "graph",
  permissionMode: "auto",
  thinkingEffort: "medium",
  thinkingEffortExplicit: false,
  additionalDirectories: [],
};

test("Plan Graph binding survives reopen and completion waits for its Graph to finish", async (t) => {
  const f = await fixture(t);
  await f.startPlan();
  const reopened = new SqliteRuntimeEventStore({ storageRoot: f.store.storageRoot });
  try {
    const coordinator = new PlanCoordinator(reopened, f.context);
    const execution = (await coordinator.project()).execution;
    assert.deepEqual(execution?.graph, f.binding);
    const started = (await reopened.readSession(f.sessionId)).find(
      (event) => event.kind === "plan.execution.started",
    );
    assert.ok(started?.kind === "plan.execution.started");
    assert.deepEqual(started.data.graph, f.binding);

    await assert.rejects(
      coordinator.updateStep({
        operationId: "finish-too-early",
        expectedSessionSequence: (await coordinator.project()).sessionSequence,
        planId: "plan-1",
        stepId: "step-1",
        status: "completed",
      }),
      /graph|图/i,
    );
    await assert.rejects(
      coordinator.complete({
        operationId: "complete-too-early",
        expectedSessionSequence: (await coordinator.project()).sessionSequence,
        planId: "plan-1",
      }),
    );
    assert.equal((await coordinator.project()).execution?.steps[0]?.status, "pending");

    f.finishGraph();
    const completed = await coordinator.updateStep({
      operationId: "finish-after-graph",
      expectedSessionSequence: (await coordinator.project()).sessionSequence,
      planId: "plan-1",
      stepId: "step-1",
      status: "completed",
    });
    assert.equal(completed.execution?.status, "completed");
  } finally {
    reopened.close();
  }
});

test("Graph host startup repairs a persisted Plan cancellation without retiring a newer epoch", async (t) => {
  const f = await fixture(t);
  await f.startPlan();
  // No retireGraph callback: simulate cancellation committed just before the host crashed.
  await f.coordinator.cancel({
    operationId: "cancel-before-host-crash",
    expectedSessionSequence: (await f.coordinator.project()).sessionSequence,
    planId: "plan-1",
    reason: "User cancelled the plan",
  });
  assert.equal(f.graphStore.getGraph(f.binding.graphId)?.phase, "open");
  const manager = new SessionManager();
  const options = {
    workDir: f.workDir,
    storageRoot: f.store.storageRoot,
    runtimeEventStore: f.store,
    sessionManager: manager,
    execute: async () => assert.fail("Cancelled Plan must never launch a Graph Run"),
  };
  const host = createAgentGraphWorkspaceHost(options);
  try {
    await host.start();
    assert.equal(f.graphStore.getGraph(f.binding.graphId)?.phase, "finished");
  } finally {
    await host.close();
  }

  const next = f.graphStore.openRootEpoch(f.sessionId).record;
  assert.equal(next.epoch, f.binding.epoch + 1);
  const restarted = createAgentGraphWorkspaceHost(options);
  try {
    await restarted.start();
    assert.equal(f.graphStore.getGraph(next.graphId)?.phase, "open");
    assert.equal((await f.coordinator.project()).execution?.status, "cancelled");
  } finally {
    await restarted.close();
    await manager.clearAndDrain();
  }
});

test("Plan recovery keeps a yielded execution active but does not hide a later failed root wake", async (t) => {
  const f = await fixture(t);
  await f.startPlan();
  await f.appendRun("root-run-1", "completed");
  f.graphStore.registerYieldInterest({
    permitId: "permit-1",
    graphId: f.binding.graphId,
    rootSessionId: f.sessionId,
    rootTurnId: "turn:root-run-1",
    rootRunId: "root-run-1",
    toolCallId: "yield-1",
  });
  const runtime = new AgentRuntime();
  const request = { sessionId: f.sessionId, dir: f.workDir, picoHome: f.picoHome };
  assert.equal((await runtime.readPlanProjection(request)).execution?.status, "active");
  const wake = f.graphStore.enqueueSupervisorWakeForYield({
    wakeId: "wake-1",
    graphId: f.binding.graphId,
    dedupeKey: "terminal:operator-1",
    wakeFingerprint: `sha256:${"a".repeat(64)}`,
    cause: "runtime_terminal",
    payload: { claimId: "operator-1" },
  });
  assert.equal(wake.status, "enqueued");
  assert.equal(f.graphStore.getYieldInterest("permit-1")?.state, "consumed");
  assert.equal((await runtime.readPlanProjection(request)).execution?.status, "active");
  f.graphStore.claimSupervisorWake({
    wakeId: "wake-1",
    expectedWakeVersion: 1,
    attemptId: "attempt-1",
    rootSessionId: f.sessionId,
    targetTurnId: "turn:root-run-2",
    targetRunId: "root-run-2",
  });
  await f.appendRun("root-run-2", "failed");
  const interrupted = await runtime.recoverPlanExecution(request);
  assert.equal(interrupted.execution?.status, "interrupted");
  assert.deepEqual(interrupted.execution?.graph, f.binding);
  const firstSequence = interrupted.sessionSequence;
  assert.equal((await runtime.recoverPlanExecution(request)).sessionSequence, firstSequence);
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-graph-lifecycle-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  const storageRoot = resolvePicoPaths(workDir, { picoHome }).workspace.root;
  const store = new SqliteRuntimeEventStore({ storageRoot });
  const graphStore = new SqliteAgentGraphControlStore({ storageRoot });
  t.after(async () => {
    graphStore.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const sessionId = "root-session";
  await store.initializeSession({ sessionId, workDir });
  const context = { sessionId, invocationId: "plan-inv", runId: "plan-run", turnId: "plan-turn" };
  const coordinator = new PlanCoordinator(store, context);
  const graph = graphStore.openRootEpoch(sessionId).record;
  const binding = { graphId: graph.graphId, epoch: graph.epoch };
  return {
    store,
    graphStore,
    coordinator,
    context,
    binding,
    sessionId,
    workDir,
    picoHome,
    async startPlan() {
      const proposed = await coordinator.propose({
        operationId: "propose",
        expectedSessionSequence: 0,
        proposal: {
          planId: "plan-1",
          title: "Bound Graph plan",
          steps: [{ id: "step-1", title: "One", description: "Execute and verify" }],
        },
      });
      const approved = await coordinator.approve({
        operationId: "approve",
        expectedSessionSequence: proposed.sessionSequence,
        planId: "plan-1",
        expectedRevision: 1,
        reviewedBy: "user",
        settings: SETTINGS,
      });
      await coordinator.startExecution({
        operationId: "start",
        expectedSessionSequence: approved.sessionSequence,
        planId: "plan-1",
        revision: 1,
        graph: binding,
      });
    },
    finishGraph() {
      new SqliteAgentGraphControlStoreAdapter(graphStore).commitScheduleRevision({
        graphId: graph.graphId,
        expectedPreviousRevision: graphStore.getGraph(graph.graphId)!.headRevision,
        operationId: "finish-graph",
        source: { sessionId, turnId: "turn", runId: "run", toolCallId: "finish" },
        commands: [{ kind: "finish", selectedRecordIds: [] }],
      });
    },
    async appendRun(runId: string, status: "completed" | "failed") {
      const base = {
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        sessionId,
        invocationId: `inv:${runId}`,
        runId,
        turnId: `turn:${runId}`,
        at: new Date().toISOString(),
        partial: false,
        visibility: "internal" as const,
      };
      await store.append({
        ...base,
        eventId: `started:${runId}`,
        kind: "run.started",
        data: { workDir },
      });
      await store.append({
        ...base,
        eventId: `terminal:${runId}`,
        kind: "run.terminal",
        data: { status },
      });
    },
  };
}
