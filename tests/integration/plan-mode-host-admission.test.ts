import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest } from "../../packages/protocol/src/runtime.js";
import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "../../src/daemon/protocol.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { PlanCoordinator } from "../../src/plan/coordinator.js";
import { planReviewOperationId, planReviewRunId } from "../../src/plan/review-identity.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { SqliteRuntimeControlStore } from "../../src/storage/sqlite/sqlite-runtime-control-store.js";

test("Plan review Run admission replays one durable run for the same operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  await mkdir(workspace);
  let executions = 0;
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  const request = {
    workspacePath: workspace,
    sessionId: "session-1",
    prompt: "execute approved plan",
    execution: {
      resumeExistingSession: true,
      planReview: {
        action: "execute" as const,
        planId: "plan-1",
        expectedRevision: 1,
        expectedSessionSequence: 4,
        operationId: "operation-1",
        controlEpoch: "plan:operation-1",
      },
    },
    idempotencyKey: "plan-review-run:operation-1",
  };
  const first = await service.startForegroundRun(request);
  const replay = await service.startForegroundRun(request);
  assert.equal((first as { runId: string }).runId, (replay as { runId: string }).runId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);

  await assert.rejects(
    service.startForegroundRun({ ...request, prompt: "different request" }),
    RuntimeProtocolError,
  );
});

test("Plan review intent recovers Phase A without allocating a second Run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-saga-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  await mkdir(workspace);
  let executions = 0;
  const input = {
    workspacePath: workspace,
    sessionId: "session-saga",
    prompt: "execute approved plan",
    operationId: "operation-saga",
    controlEpoch: "plan:operation-saga",
    planId: "plan-saga",
    revision: 2,
    action: "execute" as const,
    execution: {
      resumeExistingSession: true,
      planReview: {
        action: "execute" as const,
        planId: "plan-saga",
        expectedRevision: 2,
        expectedSessionSequence: 9,
        operationId: "operation-saga",
        controlEpoch: "plan:operation-saga",
      },
    },
    idempotencyKey: "plan-review-run:operation-saga",
  };

  const reservingService = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => {
      throw new Error("Phase A must not execute");
    },
  });
  const reserved = await reservingService.reservePlanReviewRun(input);
  await reservingService.close();

  const recoveringService = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  t.after(async () => {
    await recoveringService.close();
    await rm(root, { recursive: true, force: true });
  });

  const [intent] = await recoveringService.listPlanReviewRunIntents(workspace, input.sessionId);
  assert.ok(intent);
  assert.equal(intent.runId, reserved.runId);
  const first = await recoveringService.startReservedPlanReviewRun(intent);
  const replay = await recoveringService.startReservedPlanReviewRun(intent);
  assert.equal((first as { runId: string }).runId, reserved.runId);
  assert.equal((replay as { runId: string }).runId, reserved.runId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
});

test("Plan review intent recovers Phase B with the prebound Run identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-phase-b-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  await mkdir(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const input = {
    workspacePath: workspace,
    sessionId: "session-phase-b",
    prompt: "execute approved plan",
    operationId: "operation-phase-b",
    controlEpoch: "plan:operation-phase-b",
    planId: "plan-phase-b",
    revision: 3,
    action: "execute" as const,
    execution: {
      resumeExistingSession: true,
      planReview: {
        action: "execute" as const,
        planId: "plan-phase-b",
        expectedRevision: 3,
        expectedSessionSequence: 11,
        operationId: "operation-phase-b",
        controlEpoch: "plan:operation-phase-b",
      },
    },
    idempotencyKey: "plan-review-run:operation-phase-b",
  };
  const reservingService = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  const reserved = await reservingService.reservePlanReviewRun(input);
  await reservingService.close();

  const store = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(canonicalWorkspace, { picoHome }).workspace.root,
  });
  const startedAt = Date.now();
  store.upsertDaemonRun({
    runId: reserved.runId,
    workspacePath: canonicalWorkspace,
    sessionId: input.sessionId,
    description: input.prompt,
    status: "running",
    startedAt,
    updatedAt: startedAt,
    version: 1,
  });
  store.close();

  let executions = 0;
  const recoveringService = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => {
      executions += 1;
      return { ok: true };
    },
  });
  t.after(async () => {
    await recoveringService.close();
    await rm(root, { recursive: true, force: true });
  });
  const [intent] = await recoveringService.listPlanReviewRunIntents(workspace, input.sessionId);
  assert.ok(intent);
  const recovered = await recoveringService.startReservedPlanReviewRun(intent);
  assert.equal((recovered as { runId: string }).runId, reserved.runId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  const finished = await recoveringService.getWorkspaceRun(workspace, reserved.runId);
  assert.equal(finished?.status, "succeeded");
  assert.ok((finished?.version ?? 0) > 1, "restart recovery + exact reattach share one Run ledger");
});

test("failed Plan review Run is recovery_required instead of being retried", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-terminal-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  await mkdir(workspace);
  let executions = 0;
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => {
      executions += 1;
      throw new Error("provider rejected request");
    },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    workspacePath: workspace,
    sessionId: "session-failed",
    prompt: "execute approved plan",
    operationId: "operation-failed",
    controlEpoch: "plan:operation-failed",
    planId: "plan-failed",
    revision: 1,
    action: "execute" as const,
    execution: {
      resumeExistingSession: true,
      planReview: {
        action: "execute" as const,
        planId: "plan-failed",
        expectedRevision: 1,
        expectedSessionSequence: 3,
        operationId: "operation-failed",
        controlEpoch: "plan:operation-failed",
      },
    },
    idempotencyKey: "plan-review-run:operation-failed",
  };
  const reserved = await service.reservePlanReviewRun(input);
  await service.startReservedPlanReviewRun({ input, runId: reserved.runId });
  await new Promise((resolve) => setImmediate(resolve));
  const failed = await service.getWorkspaceRun(workspace, reserved.runId);
  assert.equal(failed?.status, "failed");

  const replay = await service.startReservedPlanReviewRun({ input, runId: reserved.runId });
  assert.equal((replay as { status: string }).status, "failed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
});

test("production Plan review double-click converges on one Run after non-Plan ledger drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-first-click-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  const sessionId = "session-first-click";
  await mkdir(workspace);
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspace, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  lease.session.updateRuntimeState({
    settings: {
      provider: "openai",
      model: "test",
      modelRouteId: "test/test",
      collaborationMode: "plan",
      permissionMode: "default",
      orchestrationMode: "default",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    },
  });
  await lease.session.flushPersistence();
  assert.ok(lease.session.runtimeEventStore);
  const coordinator = new PlanCoordinator(lease.session.runtimeEventStore, {
    sessionId,
    invocationId: "first-click-plan",
    runId: "first-click-plan",
    turnId: "first-click-plan",
    writeGuard: lease.session,
  });
  const before = await coordinator.project();
  const proposed = await coordinator.propose({
    operationId: "first-click-proposal",
    expectedSessionSequence: before.sessionSequence,
    proposal: {
      planId: "plan-first-click",
      title: "First click stays valid",
      steps: [{ id: "step-1", title: "Execute", description: "Run after review" }],
    },
  });
  await lease.session.commitMessages({ role: "assistant", content: "Plan handoff rendered." });
  await lease.session.flushPersistence();
  const drifted = await coordinator.project();
  assert.ok(drifted.sessionSequence > proposed.sessionSequence);
  assert.equal(drifted.pendingProposal?.revision, proposed.pendingProposal?.revision);
  assert.equal(drifted.controlEpoch, proposed.controlEpoch);

  const services = createProductionRuntimeServices({ env: { PICO_HOME: picoHome } });
  t.after(async () => {
    lease.release();
    await services.desktopService.close();
    const released = globalSessionManager.delete(sessionId, workspace, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = createRuntimeRequest("plan.respond", {
    workspacePath: workspace,
    sessionId,
    planId: "plan-first-click",
    action: "execute",
    expectedRevision: 1,
    expectedSessionSequence: proposed.sessionSequence,
    controlEpoch: proposed.controlEpoch!,
  });
  const responses = (await Promise.all([
    services.desktopService.handle(request),
    services.desktopService.handle(request),
  ])) as unknown as readonly { accepted: boolean; run?: { runId?: string } }[];
  assert.ok(responses.every(({ accepted }) => accepted));
  assert.match(responses[0]?.run?.runId ?? "", /^run_plan_/u);
  assert.equal(responses[0]?.run?.runId, responses[1]?.run?.runId);
  const runs = (await services.desktopService.handle(
    createRuntimeRequest("runs.list", { workspacePath: workspace, sessionId }),
  )) as { runs: readonly { runId: string }[] };
  assert.equal(runs.runs.filter(({ runId }) => runId.startsWith("run_plan_")).length, 1);
});

test("production Plan review rejects an old card after a real revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-old-card-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  const sessionId = "session-old-card";
  await mkdir(workspace);
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspace, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  lease.session.updateRuntimeState({
    settings: {
      provider: "openai",
      model: "test",
      modelRouteId: "test/test",
      collaborationMode: "plan",
      permissionMode: "default",
      orchestrationMode: "default",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    },
  });
  await lease.session.flushPersistence();
  assert.ok(lease.session.runtimeEventStore);
  const coordinator = new PlanCoordinator(lease.session.runtimeEventStore, {
    sessionId,
    invocationId: "old-card-plan",
    runId: "old-card-plan",
    turnId: "old-card-plan",
    writeGuard: lease.session,
  });
  const initial = await coordinator.project();
  const proposed = await coordinator.propose({
    operationId: "old-card-proposal",
    expectedSessionSequence: initial.sessionSequence,
    proposal: {
      planId: "plan-old-card",
      title: "Revision one",
      steps: [{ id: "step-1", title: "First", description: "First revision" }],
    },
  });
  const requested = await coordinator.requestRevision({
    operationId: "old-card-feedback",
    expectedSessionSequence: proposed.sessionSequence,
    planId: "plan-old-card",
    expectedRevision: 1,
    feedback: "Revise it",
  });
  await coordinator.revise({
    operationId: "old-card-revision",
    expectedSessionSequence: requested.sessionSequence,
    planId: "plan-old-card",
    expectedRevision: 1,
    proposal: {
      title: "Revision two",
      steps: [{ id: "step-1", title: "Second", description: "Second revision" }],
    },
  });

  const services = createProductionRuntimeServices({ env: { PICO_HOME: picoHome } });
  t.after(async () => {
    lease.release();
    await services.desktopService.close();
    const released = globalSessionManager.delete(sessionId, workspace, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    services.desktopService.handle(
      createRuntimeRequest("plan.respond", {
        workspacePath: workspace,
        sessionId,
        planId: "plan-old-card",
        action: "execute",
        expectedRevision: 1,
        expectedSessionSequence: proposed.sessionSequence,
        controlEpoch: proposed.controlEpoch!,
      }),
    ),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
  );
});

test("live Plan review claim recovers one deterministic intent after restart/open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-claim-recovery-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  const sessionId = "session-claim-recovery";
  await mkdir(workspace);
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspace, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  lease.session.updateRuntimeState({ settings: planSettings("plan") });
  await lease.session.flushPersistence();
  assert.ok(lease.session.runtimeEventStore);
  const coordinator = new PlanCoordinator(lease.session.runtimeEventStore, {
    sessionId,
    invocationId: "claim-recovery",
    runId: "claim-recovery",
    turnId: "claim-recovery",
    writeGuard: lease.session,
  });
  const proposed = await coordinator.propose({
    operationId: "claim-recovery-proposal",
    expectedSessionSequence: (await coordinator.project()).sessionSequence,
    proposal: {
      planId: "plan-claim-recovery",
      title: "Recover claim",
      steps: [{ id: "step-1", title: "Run", description: "Recover exact run" }],
    },
  });
  const operationId = planReviewOperationId({
    sessionId,
    planId: "plan-claim-recovery",
    revision: 1,
    controlEpoch: proposed.controlEpoch!,
    action: "execute",
  });
  await coordinator.claimReview({
    operationId,
    expectedSessionSequence: proposed.sessionSequence,
    planId: "plan-claim-recovery",
    revision: 1,
    controlEpoch: proposed.controlEpoch!,
    action: "execute",
  });
  lease.release();

  const services = createProductionRuntimeServices({ env: { PICO_HOME: picoHome } });
  t.after(async () => {
    await services.desktopService.close();
    const released = globalSessionManager.delete(sessionId, workspace, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  await services.desktopService.readSessionContinuityMetadata(workspace, sessionId);
  const intents = await services.service.listPlanReviewRunIntents(workspace, sessionId);
  assert.equal(intents.length, 1);
  assert.equal(intents[0]?.input.operationId, operationId);
  assert.equal(intents[0]?.runId, planReviewRunId(operationId));
});

test("cancel/replan competition admits only the Plan-ledger claim winner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-plan-host-control-race-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "state");
  const sessionId = "session-control-race";
  await mkdir(workspace);
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspace, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  lease.session.updateRuntimeState({ settings: planSettings("plan") });
  await lease.session.flushPersistence();
  assert.ok(lease.session.runtimeEventStore);
  const coordinator = new PlanCoordinator(lease.session.runtimeEventStore, {
    sessionId,
    invocationId: "control-race",
    runId: "control-race",
    turnId: "control-race",
    writeGuard: lease.session,
  });
  const proposed = await coordinator.propose({
    operationId: "control-race-proposal",
    expectedSessionSequence: (await coordinator.project()).sessionSequence,
    proposal: {
      planId: "plan-control-race",
      title: "Race controls",
      steps: [{ id: "step-1", title: "Run", description: "Race cancel and replan" }],
    },
  });
  const approved = await coordinator.approve({
    operationId: "control-race-approve",
    expectedSessionSequence: proposed.sessionSequence,
    planId: "plan-control-race",
    expectedRevision: 1,
    reviewedBy: "user",
    settings: planSettings("plan"),
  });
  const started = await coordinator.startExecution({
    operationId: "control-race-start",
    expectedSessionSequence: approved.sessionSequence,
    planId: "plan-control-race",
    revision: 1,
  });
  const interrupted = await coordinator.interrupt({
    operationId: "control-race-interrupt",
    expectedSessionSequence: started.sessionSequence,
    planId: "plan-control-race",
  });

  const services = createProductionRuntimeServices({ env: { PICO_HOME: picoHome } });
  t.after(async () => {
    lease.release();
    await services.desktopService.close();
    const released = globalSessionManager.delete(sessionId, workspace, { picoHome });
    await released?.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = {
    workspacePath: workspace,
    sessionId,
    planId: "plan-control-race",
    expectedRevision: 1,
    expectedSessionSequence: interrupted.sessionSequence,
    controlEpoch: interrupted.controlEpoch!,
  };
  const outcomes = await Promise.allSettled([
    services.desktopService.handle(
      createRuntimeRequest("plan.respond", { ...base, action: "cancel_execution" }),
    ),
    services.desktopService.handle(
      createRuntimeRequest("plan.respond", { ...base, action: "replan_execution" }),
    ),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  const intents = await services.service.listPlanReviewRunIntents(workspace, sessionId);
  assert.ok(intents.length <= 1, "the losing action must create no durable intent");
  const runs = (await services.desktopService.handle(
    createRuntimeRequest("runs.list", { workspacePath: workspace, sessionId }),
  )) as { runs: readonly { runId: string }[] };
  assert.ok(
    runs.runs.filter(({ runId }) => runId.startsWith("run_plan_")).length <= 1,
    "the losing action must create no RuntimeRun",
  );
});

function planSettings(collaborationMode: "agent" | "plan") {
  return {
    provider: "openai" as const,
    model: "test",
    modelRouteId: "test/test",
    collaborationMode,
    permissionMode: "default" as const,
    orchestrationMode: "default" as const,
    thinkingEffort: "medium",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  };
}

// 注：原"TUI Plan revision admission"用例随 in-process TUI 路径退役删除
// （Phase 5，2026-08-16）：plan 审批 Run 的持久 admission 语义由上方
// daemon 侧 WorkspaceRuntimeService 用例覆盖（同一 operationId 重放同一 Run）。
