import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { Session, SessionManager } from "../../src/engine/session.js";
import { PlanCoordinator, PlanConflictError } from "../../src/plan/index.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import {
  RuntimeEventStore,
  RuntimeEventStorePlanOperationConflictError,
} from "../../src/storage/runtime-event-store.js";

const AT = new Date("2026-08-06T00:00:00.000Z");

test("Plan submission atomically completes a verified active Discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-plan-atomic-"));
  const workDir = join(root, "work");
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "state") });
  await store.initializeSession({ sessionId: "session-1", workDir });
  const context = {
    sessionId: "session-1",
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
  };
  const discovery = new DiscoveryCoordinator(store, context, () => AT);
  const plan = new PlanCoordinator(store, context, () => AT);
  const started = await discovery.start({
    operationId: "discover-start",
    expectedSessionSequence: 0,
    discoveryId: "discovery-1",
    objective: "Locate quote calculation",
    depth: "balanced",
    roots: ["src"],
  });
  assert.equal(started.active?.phase, "forage");
  await discovery.checkpoint({
    operationId: "discover-focus",
    expectedSessionSequence: 1,
    discoveryId: "discovery-1",
    checkpoint: {
      phase: "focus",
      cycle: 1,
      candidates: [],
      evidenceRefs: [],
      hypotheses: [],
      openQuestions: ["Which resolver owns the final value?"],
      toolCallsUsed: 1,
      inspectedFiles: ["src/entry.ts"],
    },
  });
  const proposal = {
    planId: "plan-1",
    title: "Fix quote calculation",
    overview: "Update the verified resolver",
    steps: [{ id: "step-1", title: "Fix", description: "Edit the verified target" }],
  };
  await assert.rejects(
    plan.propose({
      operationId: "submit-before-verify",
      expectedSessionSequence: 2,
      proposal,
    }),
    PlanConflictError,
  );
  assert.equal((await store.readSessionEntries("session-1")).length, 2);

  await discovery.checkpoint({
    operationId: "discover-verify",
    expectedSessionSequence: 2,
    discoveryId: "discovery-1",
    checkpoint: {
      phase: "verify",
      cycle: 1,
      candidates: [
        {
          path: "src/quote-resolver.ts",
          symbol: "resolveQuote",
          score: 30,
          reasons: ["direct definition and caller evidence"],
          evidenceRefs: ["evidence://quote-resolver"],
        },
      ],
      evidenceRefs: ["evidence://quote-resolver"],
      hypotheses: [
        {
          id: "quote-owner",
          statement: "resolveQuote owns the final value",
          status: "supported",
          evidenceRefs: ["evidence://quote-resolver"],
        },
      ],
      openQuestions: [],
      toolCallsUsed: 2,
      inspectedFiles: ["src/quote-resolver.ts"],
    },
  });
  const proposed = await plan.propose({
    operationId: "submit-verified-plan",
    expectedSessionSequence: 3,
    proposal,
  });
  assert.equal(proposed.pendingProposal?.planId, "plan-1");
  const events = await store.readSessionEntries("session-1");
  assert.deepEqual(
    events.slice(-2).map(({ event }) => event.kind),
    ["discovery.completed", "plan.proposed"],
  );
  const discoveryCompletion = events.at(-2)?.event;
  const planProposal = events.at(-1)?.event;
  assert.equal(
    discoveryCompletion && "operationId" in discoveryCompletion.data
      ? discoveryCompletion.data.operationId
      : undefined,
    "submit-verified-plan",
  );
  assert.equal(
    planProposal && "operationId" in planProposal.data ? planProposal.data.operationId : undefined,
    "submit-verified-plan",
  );
  assert.equal((await discovery.project()).latest?.status, "completed");

  const replay = await plan.propose({
    operationId: "submit-verified-plan",
    expectedSessionSequence: 3,
    proposal,
  });
  assert.equal(replay.sessionSequence, 5);
  assert.equal((await store.readSessionEntries("session-1")).length, 5);
  await assert.rejects(
    plan.propose({
      operationId: "submit-verified-plan",
      expectedSessionSequence: 5,
      proposal: { ...proposal, title: "Conflicting retry" },
    }),
    RuntimeEventStorePlanOperationConflictError,
  );
});

test("Session fork inherits an active Discovery as interrupted without resuming workers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-fork-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new SessionManager({
    createSession: (id, cwd, options) => new Session(id, cwd, options),
  });
  const source = await manager.getOrCreate("discovery-source", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  await source.commitMessages({ role: "user", content: "Investigate the repository" });
  const store = source.runtimeEventStore!;
  const sourceDiscovery = new DiscoveryCoordinator(store, {
    sessionId: source.id,
    invocationId: "source-invocation",
    runId: "source-run",
    turnId: "source-turn",
  });
  const before = await sourceDiscovery.project();
  await sourceDiscovery.start({
    operationId: "source-discovery-start",
    expectedSessionSequence: before.sessionSequence,
    discoveryId: "source-discovery",
    objective: "Locate the implementation",
    depth: "balanced",
  });
  const afterStart = await sourceDiscovery.project();
  await sourceDiscovery.startBranch({
    operationId: "source-branch-start",
    expectedSessionSequence: afterStart.sessionSequence,
    discoveryId: "source-discovery",
    branchId: "entry-chain",
    ordinal: 0,
    objective: "Trace the entry call chain",
    roots: ["src"],
    queries: ["entry"],
    stoppingCondition: "Find a concrete definition",
    reserveToolCalls: 8,
    reserveFiles: 10,
  });
  const service = new SessionForkService({
    workDir,
    picoHome,
    sessionManager: manager,
    runtimeStore: store,
    runtimePort: createSessionForkRuntimePort(),
    createOperationId: () => "fork-active-discovery",
  });
  await service.fork({
    sourceSessionId: source.id,
    targetSessionId: "discovery-target",
    targetMode: "default",
  });
  const targetDiscovery = await new DiscoveryCoordinator(store, {
    sessionId: "discovery-target",
    invocationId: "target-invocation",
    runId: "target-run",
    turnId: "target-turn",
  }).project();
  assert.equal(targetDiscovery.latest?.status, "interrupted");
  assert.match(targetDiscovery.latest?.reason ?? "", /explicit resume/u);
  assert.equal(targetDiscovery.latest?.branches[0]?.status, "cancelled");
  assert.equal((await sourceDiscovery.project()).active?.discoveryId, "source-discovery");
});
