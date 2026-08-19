import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectRuntimeSessionState } from "../../src/engine/session-runtime-projection.js";
import { Session, SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import {
  normalizeSessionRuntimeStatePatch,
  type PersistedSessionSettings,
} from "../../src/engine/session-runtime.js";
import { PlanCoordinator, PlanConflictError } from "../../src/plan/index.js";
import {
  createDefaultSessionSettings,
  exitSessionPlanMode,
  setSessionMode,
  snapshotSessionSettings,
} from "../../src/input/session-settings.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
} from "../../src/storage/runtime-event.js";
import {
  RuntimeEventStoreHighWaterConflictError,
  RuntimeEventStorePlanOperationConflictError,
} from "../../src/storage/runtime-event-store-contracts.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

const AT = new Date("2026-08-05T00:00:00.000Z");
const SETTINGS: PersistedSessionSettings = {
  provider: "openai",
  model: "test",
  modelRouteId: "openai/test",
  mode: "plan",
  prePlanMode: "auto",
  collaborationMode: "plan",
  permissionMode: "auto",
  thinkingEffort: "medium",
  thinkingEffortExplicit: false,
  additionalDirectories: [],
};

test("Plan coordinator persists revisions, atomic approval and terminal execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-mode-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => {
    store.close();
    reopenedStore?.close();
    return rm(root, { recursive: true, force: true });
  });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(
    store,
    { sessionId: "session-1", invocationId: "inv-1", runId: "run-1", turnId: "turn-1" },
    () => AT,
  );
  const proposal = {
    planId: "plan-1",
    title: "Initial",
    steps: [
      { id: "step-1", title: "One", description: "Do one" },
      { id: "step-2", title: "Two", description: "Do two" },
    ],
  };
  await coordinator.propose({ operationId: "op-propose", expectedSessionSequence: 0, proposal });
  const revised = await coordinator.revise({
    operationId: "op-revise",
    expectedSessionSequence: 1,
    planId: "plan-1",
    expectedRevision: 1,
    proposal: { ...proposal, title: "Revised" },
  });
  assert.equal(revised.proposals[0]?.status, "stale");
  assert.equal(revised.latestProposal?.revision, 2);
  await assert.rejects(
    coordinator.approve({
      operationId: "op-stale",
      expectedSessionSequence: 2,
      planId: "plan-1",
      expectedRevision: 1,
      reviewedBy: "user",
      settings: SETTINGS,
    }),
    PlanConflictError,
  );
  await coordinator.approve({
    operationId: "op-approve",
    expectedSessionSequence: 2,
    planId: "plan-1",
    expectedRevision: 2,
    reviewedBy: "user",
    settings: SETTINGS,
  });
  assert.equal(
    (await store.readSessionEntries("session-1")).length,
    4,
    "approval and mode switch share one atomic batch",
  );
  await coordinator.startExecution({
    operationId: "op-start",
    expectedSessionSequence: 4,
    planId: "plan-1",
    revision: 2,
  });
  await coordinator.updateStep({
    operationId: "op-step-1",
    expectedSessionSequence: 5,
    planId: "plan-1",
    stepId: "step-1",
    status: "completed",
  });
  const completed = await coordinator.updateStep({
    operationId: "op-step-2",
    expectedSessionSequence: 6,
    planId: "plan-1",
    stepId: "step-2",
    status: "skipped",
  });
  assert.equal(completed.execution?.status, "completed");
  const events = await store.readSession("session-1");
  assert.equal(events.at(-1)?.kind, "plan.execution.completed");
  const stateFact = events.find((event) => event.kind === "session.state.committed");
  assert.ok(stateFact?.kind === "session.state.committed" && stateFact.data.patch.settings);
  assert.equal(Object.hasOwn(stateFact.data.patch.settings, "mode"), false);
  assert.equal(Object.hasOwn(stateFact.data.patch.settings, "prePlanMode"), false);
  const runtime = projectRuntimeSessionState(events);
  assert.equal(runtime.settings?.collaborationMode, "agent");
  assert.equal(runtime.settings?.permissionMode, "auto");
  assert.equal(runtime.settings?.permissionMode, "auto");

  const reopenedStore = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
  const reopened = new PlanCoordinator(
    reopenedStore,
    { sessionId: "session-1", invocationId: "inv-1", runId: "run-1", turnId: "turn-1" },
    () => AT,
  );
  assert.equal((await reopened.project()).execution?.status, "completed");
});

test("Plan operation retries are idempotent and conflicting reuse is rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-idempotency-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(
    store,
    { sessionId: "session-1", invocationId: "inv", runId: "run", turnId: "turn" },
    () => AT,
  );
  const proposal = {
    planId: "plan-1",
    title: "Plan",
    steps: [{ id: "step-1", title: "One", description: "Do one" }],
  };
  await coordinator.propose({ operationId: "same-op", expectedSessionSequence: 0, proposal });
  await coordinator.propose({ operationId: "same-op", expectedSessionSequence: 0, proposal });
  assert.equal((await store.readSession("session-1")).length, 1);
  await assert.rejects(
    coordinator.propose({
      operationId: "same-op",
      expectedSessionSequence: 0,
      proposal: { ...proposal, title: "Different" },
    }),
    RuntimeEventStorePlanOperationConflictError,
  );
});

test("revision requests and interrupted controls are durable CAS operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-recovery-"));
  const workDir = join(root, "work");
  const storageRoot = join(root, "state");
  await mkdir(workDir);
  t.after(() => {
    store.close();
    reopenedStore?.close();
    return rm(root, { recursive: true, force: true });
  });
  const store = new SqliteRuntimeEventStore({ storageRoot });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(
    store,
    { sessionId: "session-1", invocationId: "inv", runId: "run", turnId: "turn" },
    () => AT,
  );
  const proposal = {
    planId: "plan-1",
    title: "Plan",
    steps: [{ id: "step-1", title: "One", description: "Do one" }],
  };
  await coordinator.propose({ operationId: "propose", expectedSessionSequence: 0, proposal });
  const requested = await coordinator.requestRevision({
    operationId: "request-revision",
    expectedSessionSequence: 1,
    planId: "plan-1",
    expectedRevision: 1,
    feedback: "补充失败回滚步骤",
  });
  assert.equal(requested.revisionRequest?.feedback, "补充失败回滚步骤");
  assert.equal(requested.pendingProposal, undefined);
  assert.equal(requested.latestProposal?.status, "stale");
  await assert.rejects(
    coordinator.approve({
      operationId: "approve-stale-request",
      expectedSessionSequence: 2,
      planId: "plan-1",
      expectedRevision: 1,
      reviewedBy: "user",
      settings: SETTINGS,
    }),
    PlanConflictError,
  );
  await assert.rejects(
    coordinator.rejectAndExit({
      operationId: "reject-stale-request",
      expectedSessionSequence: 2,
      planId: "plan-1",
      expectedRevision: 1,
      reviewedBy: "user",
      settings: SETTINGS,
    }),
    PlanConflictError,
  );
  await assert.rejects(
    coordinator.propose({
      operationId: "bypass-request",
      expectedSessionSequence: 2,
      proposal: { ...proposal, planId: "plan-bypass" },
    }),
    PlanConflictError,
  );
  await coordinator.requestRevision({
    operationId: "request-revision",
    expectedSessionSequence: 1,
    planId: "plan-1",
    expectedRevision: 1,
    feedback: "补充失败回滚步骤",
  });
  assert.equal((await store.readSession("session-1")).length, 2);
  await assert.rejects(
    coordinator.requestRevision({
      operationId: "request-revision",
      expectedSessionSequence: 2,
      planId: "plan-1",
      expectedRevision: 1,
      feedback: "不同反馈",
    }),
    RuntimeEventStorePlanOperationConflictError,
  );
  const reopenedStore = new SqliteRuntimeEventStore({ storageRoot });
  const reopened = new PlanCoordinator(
    reopenedStore,
    { sessionId: "session-1", invocationId: "reopen", runId: "run", turnId: "turn" },
    () => AT,
  );
  assert.equal((await reopened.project()).revisionRequest?.operationId, "request-revision");
  await reopened.revise({
    operationId: "revise",
    expectedSessionSequence: 2,
    planId: "plan-1",
    expectedRevision: 1,
    proposal: { ...proposal, title: "Revised" },
  });
  assert.equal((await reopened.project()).revisionRequest, undefined);
  await reopened.approve({
    operationId: "approve",
    expectedSessionSequence: 3,
    planId: "plan-1",
    expectedRevision: 2,
    reviewedBy: "user",
    settings: SETTINGS,
  });
  await reopened.startExecution({
    operationId: "start",
    expectedSessionSequence: 5,
    planId: "plan-1",
    revision: 2,
  });
  await reopened.interrupt({
    operationId: "interrupt-1",
    expectedSessionSequence: 6,
    planId: "plan-1",
    reason: "runtime stopped",
  });
  const resumed = await reopened.resume({
    operationId: "resume",
    expectedSessionSequence: 7,
    planId: "plan-1",
  });
  assert.equal(resumed.execution?.status, "active");
  assert.equal(resumed.execution?.reason, undefined);
  await reopened.resume({
    operationId: "resume",
    expectedSessionSequence: 7,
    planId: "plan-1",
  });
  assert.equal((await store.readSession("session-1")).length, 8);
  await reopened.interrupt({
    operationId: "interrupt-2",
    expectedSessionSequence: 8,
    planId: "plan-1",
  });
  const replanned = await reopened.replan({
    operationId: "replan",
    expectedSessionSequence: 9,
    planId: "plan-1",
    settings: { ...SETTINGS, collaborationMode: "agent" },
    reason: "requirements changed",
  });
  assert.equal(replanned.execution?.status, "cancelled");
  const runtime = projectRuntimeSessionState(await store.readSession("session-1"));
  assert.equal(runtime.settings?.collaborationMode, "plan");

  await store.initializeSession({ sessionId: "session-cancel", workDir });
  const cancelCoordinator = new PlanCoordinator(
    store,
    { sessionId: "session-cancel", invocationId: "inv", runId: "run", turnId: "turn" },
    () => AT,
  );
  await cancelCoordinator.propose({ operationId: "propose", expectedSessionSequence: 0, proposal });
  await cancelCoordinator.approve({
    operationId: "approve",
    expectedSessionSequence: 1,
    planId: "plan-1",
    expectedRevision: 1,
    reviewedBy: "user",
    settings: SETTINGS,
  });
  await cancelCoordinator.startExecution({
    operationId: "start",
    expectedSessionSequence: 3,
    planId: "plan-1",
    revision: 1,
  });
  await cancelCoordinator.interrupt({
    operationId: "interrupt",
    expectedSessionSequence: 4,
    planId: "plan-1",
  });
  const cancelled = await cancelCoordinator.cancel({
    operationId: "cancel",
    expectedSessionSequence: 5,
    planId: "plan-1",
    reason: "user cancelled",
  });
  assert.equal(cancelled.execution?.status, "cancelled");
  await cancelCoordinator.cancel({
    operationId: "cancel",
    expectedSessionSequence: 5,
    planId: "plan-1",
    reason: "user cancelled",
  });
  assert.equal((await store.readSession("session-cancel")).length, 6);
});

test("reject and exit atomically preserves permission mode", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-reject-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const coordinator = new PlanCoordinator(
    store,
    { sessionId: "session-1", invocationId: "inv", runId: "run", turnId: "turn" },
    () => AT,
  );
  await coordinator.propose({
    operationId: "propose",
    expectedSessionSequence: 0,
    proposal: {
      planId: "plan-1",
      title: "Plan",
      steps: [{ id: "step-1", title: "One", description: "Do one" }],
    },
  });
  await coordinator.rejectAndExit({
    operationId: "reject",
    expectedSessionSequence: 1,
    planId: "plan-1",
    expectedRevision: 1,
    reviewedBy: "user",
    settings: SETTINGS,
  });
  const events = await store.readSession("session-1");
  assert.deepEqual(
    events.slice(-2).map((event) => event.kind),
    ["plan.rejected", "session.state.committed"],
  );
  const runtime = projectRuntimeSessionState(events);
  assert.equal(runtime.settings?.collaborationMode, "agent");
  assert.equal(runtime.settings?.permissionMode, "auto");
});

test("Plan reducer enforces review, step and rewind invariants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-invariants-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => {
    store.close();
    return rm(root, { recursive: true, force: true });
  });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "s", workDir });
  const coordinator = new PlanCoordinator(
    store,
    { sessionId: "s", invocationId: "i", runId: "r", turnId: "t" },
    () => AT,
  );
  const proposal = {
    planId: "p",
    title: "P",
    steps: [
      { id: "a", title: "A", description: "A" },
      { id: "b", title: "B", description: "B" },
    ],
  };
  await assert.rejects(
    coordinator.propose({ operationId: "cas", expectedSessionSequence: 1, proposal }),
    RuntimeEventStoreHighWaterConflictError,
  );
  await coordinator.propose({ operationId: "p1", expectedSessionSequence: 0, proposal });
  await assert.rejects(
    coordinator.approve({
      operationId: "sys",
      expectedSessionSequence: 1,
      planId: "p",
      expectedRevision: 1,
      reviewedBy: "system",
      settings: SETTINGS,
    }),
    PlanConflictError,
  );
  await coordinator.approve({
    operationId: "approve",
    expectedSessionSequence: 1,
    planId: "p",
    expectedRevision: 1,
    reviewedBy: "user",
    settings: SETTINGS,
  });
  await coordinator.startExecution({
    operationId: "start",
    expectedSessionSequence: 3,
    planId: "p",
    revision: 1,
  });
  await coordinator.updateStep({
    operationId: "a-start",
    expectedSessionSequence: 4,
    planId: "p",
    stepId: "a",
    status: "in_progress",
  });
  await assert.rejects(
    coordinator.updateStep({
      operationId: "b-start",
      expectedSessionSequence: 5,
      planId: "p",
      stepId: "b",
      status: "in_progress",
    }),
    PlanConflictError,
  );
  await coordinator.updateStep({
    operationId: "a-done",
    expectedSessionSequence: 5,
    planId: "p",
    stepId: "a",
    status: "completed",
  });
  await assert.rejects(
    coordinator.updateStep({
      operationId: "a-reopen",
      expectedSessionSequence: 6,
      planId: "p",
      stepId: "a",
      status: "pending",
    }),
    PlanConflictError,
  );
  // Note: branchId rewind invariants were removed during log-first alignment
  // (commit bf828a35). The history.rewound kind is kept for legacy decode
  // compatibility but no longer drives plan projection restoration.
});

test("v2 settings migrate to split axes and v3 snapshots omit legacy fields", async () => {
  const base = {
    provider: "openai",
    model: "m",
    modelRouteId: "openai/m",
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  } as const;
  const legacyPlan = normalizeSessionRuntimeStatePatch({ settings: { ...base, mode: "plan" } })!;
  assert.equal(legacyPlan.settings?.collaborationMode, "plan");
  assert.equal(legacyPlan.settings?.permissionMode, "yolo");
  const legacyAuto = normalizeSessionRuntimeStatePatch({ settings: { ...base, mode: "auto" } })!;
  assert.equal(legacyAuto.settings?.collaborationMode, "agent");
  assert.equal(legacyAuto.settings?.permissionMode, "auto");
  const settings = createDefaultSessionSettings({
    sessionId: "s",
    cwd: process.cwd(),
    provider: "openai",
    model: "m",
    modelRouteId: "openai/m",
    mode: "plan",
    permissionMode: "auto",
  });
  setSessionMode(settings, "default");
  assert.equal(
    settings.collaborationMode,
    "plan",
    "/mode changes permission without leaving Plan collaboration",
  );
  assert.equal(settings.permissionMode, "default");
  const snapshot = snapshotSessionSettings(settings) as unknown as Record<string, unknown>;
  assert.equal(snapshot.collaborationMode, "plan");
  assert.equal(snapshot.permissionMode, "default");
  assert.equal(Object.hasOwn(snapshot, "mode"), false);
  assert.equal(Object.hasOwn(snapshot, "prePlanMode"), false);

  const independent = createDefaultSessionSettings({
    sessionId: "independent",
    cwd: process.cwd(),
    provider: "openai",
    model: "m",
    modelRouteId: "openai/m",
    mode: "yolo",
  });
  setSessionMode(independent, "plan");
  assert.equal(independent.collaborationMode, "plan");
  assert.equal(independent.permissionMode, "yolo");
  setSessionMode(independent, "auto");
  assert.equal(independent.mode, "plan");
  assert.equal(independent.permissionMode, "auto");
  exitSessionPlanMode(independent);
  assert.equal(independent.collaborationMode, "agent");
  assert.equal(independent.permissionMode, "auto");
});

test("Session fork inherits pending plans and interrupts active execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-fork-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  t.after(async () => {
    for (const sessionId of ["source", "pending-target", "active-target"]) {
      const released = manager.delete(sessionId, workDir, { picoHome });
      await released?.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  const manager = new SessionManager({
    createSession: (id, cwd, options) => new Session(id, cwd, options),
  });
  const source = await manager.getOrCreate("source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  await source.commitMessages({ role: "user", content: "seed" });
  const store = source.runtimeEventStore!;
  const coordinator = new PlanCoordinator(
    store,
    { sessionId: "source", invocationId: "i", runId: "r", turnId: "t" },
    () => AT,
  );
  const proposal = { planId: "p", title: "P", steps: [{ id: "a", title: "A", description: "A" }] };
  const sourceStartSequence = (await coordinator.project()).sessionSequence;
  await coordinator.propose({
    operationId: "source-propose",
    expectedSessionSequence: sourceStartSequence,
    proposal,
  });
  let forkNumber = 0;
  const service = new SessionForkService({
    workDir,
    picoHome,
    sessionManager: manager,
    runtimeStore: store,
    runtimePort: createSessionForkRuntimePort(),
    createOperationId: () => `fork-op-${++forkNumber}`,
  });
  await service.fork({
    sourceSessionId: "source",
    targetSessionId: "pending-target",
    targetMode: "yolo",
  });
  const pending = await new PlanCoordinator(store, {
    sessionId: "pending-target",
    invocationId: "i",
    runId: "r",
    turnId: "t",
  }).project();
  assert.equal(pending.pendingProposal?.planId, "p");
  const inheritedFacts = (await store.readSession("pending-target")).filter((event) =>
    event.kind.startsWith("plan."),
  );
  assert.ok(
    inheritedFacts.every(
      (event) =>
        event.sessionId === "pending-target" &&
        "operationId" in event.data &&
        String(event.data.operationId).startsWith("fork:fork-op-1:"),
    ),
  );

  await store.append({
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "source-approved",
    sessionId: "source",
    invocationId: "i",
    runId: "r",
    turnId: "t",
    at: AT.toISOString(),
    partial: false,
    visibility: "internal",
    kind: "plan.approved",
    data: {
      operationId: "source-approve",
      fingerprint: `sha256:${"a".repeat(64)}`,
      planId: "p",
      expectedRevision: 1,
      reviewedBy: "user",
    },
  });
  await coordinator.startExecution({
    operationId: "source-start",
    expectedSessionSequence: sourceStartSequence + 2,
    planId: "p",
    revision: 1,
  });
  await service.fork({
    sourceSessionId: "source",
    targetSessionId: "active-target",
    targetMode: "yolo",
  });
  const active = await new PlanCoordinator(store, {
    sessionId: "active-target",
    invocationId: "i",
    runId: "r",
    turnId: "t",
  }).project();
  assert.equal(active.execution?.status, "interrupted");
  assert.match(active.execution?.reason ?? "", /explicit resume/u);
  assert.equal(
    (await store.readSession("active-target")).some(
      (event) => event.kind === "plan.execution.started",
    ),
    true,
  );
});
