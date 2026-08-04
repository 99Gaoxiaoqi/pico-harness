import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectRuntimeSessionState } from "../../src/engine/session-runtime-projection.js";
import type { PersistedSessionSettings } from "../../src/engine/session-runtime.js";
import { PlanCoordinator, PlanConflictError } from "../../src/plan/index.js";
import { RuntimeEventStore, RuntimeEventStorePlanOperationConflictError } from "../../src/storage/runtime-event-store.js";

const AT = new Date("2026-08-05T00:00:00.000Z");
const SETTINGS: PersistedSessionSettings = {
  provider: "openai", model: "test", modelRouteId: "openai/test", mode: "plan", prePlanMode: "auto",
  thinkingEffort: "medium", thinkingEffortExplicit: false, additionalDirectories: [],
};

test("Plan coordinator persists revisions, atomic approval and terminal execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-mode-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(store, { sessionId: "session-1", invocationId: "inv-1", runId: "run-1", turnId: "turn-1" }, () => AT);
  const proposal = { planId: "plan-1", title: "Initial", steps: [{ id: "step-1", title: "One", description: "Do one" }, { id: "step-2", title: "Two", description: "Do two" }] };
  await coordinator.propose({ operationId: "op-propose", expectedSessionSequence: 0, proposal });
  const revised = await coordinator.revise({ operationId: "op-revise", expectedSessionSequence: 1, planId: "plan-1", expectedRevision: 1, proposal: { ...proposal, title: "Revised" } });
  assert.equal(revised.proposals[0]?.status, "stale");
  assert.equal(revised.latestProposal?.revision, 2);
  await assert.rejects(coordinator.approve({ operationId: "op-stale", expectedSessionSequence: 2, planId: "plan-1", expectedRevision: 1, reviewedBy: "user", settings: SETTINGS }), PlanConflictError);
  await coordinator.approve({ operationId: "op-approve", expectedSessionSequence: 2, planId: "plan-1", expectedRevision: 2, reviewedBy: "user", settings: SETTINGS });
  assert.equal((await store.readSessionEntries("session-1")).length, 4, "approval and mode switch share one atomic batch");
  await coordinator.startExecution({ operationId: "op-start", expectedSessionSequence: 4, planId: "plan-1", revision: 2 });
  await coordinator.updateStep({ operationId: "op-step-1", expectedSessionSequence: 5, planId: "plan-1", stepId: "step-1", status: "completed" });
  const completed = await coordinator.updateStep({ operationId: "op-step-2", expectedSessionSequence: 6, planId: "plan-1", stepId: "step-2", status: "skipped" });
  assert.equal(completed.execution?.status, "completed");
  const events = await store.readSession("session-1");
  assert.equal(events.at(-1)?.kind, "plan.execution.completed");
  const runtime = projectRuntimeSessionState(events);
  assert.equal(runtime.settings?.collaborationMode, "agent");
  assert.equal(runtime.settings?.permissionMode, "auto");
  assert.equal(runtime.settings?.mode, "auto");

  const reopened = new PlanCoordinator(new RuntimeEventStore({ storageRoot: join(root, "state") }), { sessionId: "session-1", invocationId: "inv-1", runId: "run-1", turnId: "turn-1" }, () => AT);
  assert.equal((await reopened.project()).execution?.status, "completed");
});

test("Plan operation retries are idempotent and conflicting reuse is rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-idempotency-"));
  const workDir = join(root, "work"); await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(store, { sessionId: "session-1", invocationId: "inv", runId: "run", turnId: "turn" }, () => AT);
  const proposal = { planId: "plan-1", title: "Plan", steps: [{ id: "step-1", title: "One", description: "Do one" }] };
  await coordinator.propose({ operationId: "same-op", expectedSessionSequence: 0, proposal });
  await coordinator.propose({ operationId: "same-op", expectedSessionSequence: 0, proposal });
  assert.equal((await store.readSession("session-1")).length, 1);
  await assert.rejects(coordinator.propose({ operationId: "same-op", expectedSessionSequence: 0, proposal: { ...proposal, title: "Different" } }), RuntimeEventStorePlanOperationConflictError);
});
