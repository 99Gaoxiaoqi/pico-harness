import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DISCOVERY_DEPTH_BUDGETS,
  DiscoveryConflictError,
  type DiscoveryCandidate,
  type DiscoveryCheckpoint,
} from "../../src/discovery/contract.js";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../../src/engine/session-runtime-event.js";
import {
  RuntimeEventStore,
  RuntimeEventStoreHighWaterConflictError,
} from "../../src/storage/runtime-event-store.js";

const AT = new Date("2026-08-06T00:00:00.000Z");

test("Discovery presets enforce shared budget boundaries atomically", async (context) => {
  assert.deepEqual(DISCOVERY_DEPTH_BUDGETS, {
    quick: { maxBranches: 1, maxCycles: 1, maxToolCalls: 12, maxFiles: 15 },
    balanced: { maxBranches: 2, maxCycles: 2, maxToolCalls: 24, maxFiles: 30 },
    deep: { maxBranches: 3, maxCycles: 4, maxToolCalls: 48, maxFiles: 80 },
  });

  const fixture = await createFixture("budget");
  context.after(() => fixture.dispose());
  const coordinator = fixture.coordinator("budget-session");
  const started = await coordinator.start({
    operationId: "start-quick",
    discoveryId: "quick-discovery",
    objective: "定位请求路由实现",
    depth: "quick",
  });
  assert.deepEqual(started.active?.budget, {
    ...DISCOVERY_DEPTH_BUDGETS.quick,
    consumedToolCalls: 0,
    consumedFiles: 0,
    reservedToolCalls: 0,
    reservedFiles: 0,
  });

  const beforeOverflow = await fixture.store.readSession("budget-session");
  await assert.rejects(
    coordinator.checkpoint({
      operationId: "overflow-tools",
      discoveryId: "quick-discovery",
      checkpoint: checkpoint({ toolCallsUsed: 13, inspectedFiles: ["src/router.ts"] }),
    }),
    DiscoveryConflictError,
  );
  await assert.rejects(
    coordinator.checkpoint({
      operationId: "overflow-files",
      discoveryId: "quick-discovery",
      checkpoint: checkpoint({
        toolCallsUsed: 1,
        inspectedFiles: numberedFiles(16),
      }),
    }),
    DiscoveryConflictError,
  );
  assert.deepEqual(await fixture.store.readSession("budget-session"), beforeOverflow);

  const atLimit = await coordinator.checkpoint({
    operationId: "reach-quick-limit",
    discoveryId: "quick-discovery",
    checkpoint: checkpoint({
      phase: "verify",
      toolCallsUsed: 12,
      inspectedFiles: numberedFiles(15),
      evidenceRefs: ["pico://evidence/quick-limit"],
    }),
  });
  assert.equal(atLimit.latest?.status, "interrupted");
  assert.equal(atLimit.latest?.limitReason, "budget_exhausted");
  assert.equal(atLimit.latest?.budget.consumedToolCalls, 12);
  assert.equal(atLimit.latest?.budget.consumedFiles, 15);
  assert.deepEqual(
    (await fixture.store.readSession("budget-session")).slice(-2).map((event) => event.kind),
    ["discovery.checkpointed", "discovery.interrupted"],
  );

  const cycleCoordinator = fixture.coordinator("cycle-session");
  await cycleCoordinator.start({
    operationId: "start-cycle",
    discoveryId: "cycle-discovery",
    objective: "验证周期边界",
    depth: "quick",
  });
  await cycleCoordinator.checkpoint({
    operationId: "verify-cycle-one",
    discoveryId: "cycle-discovery",
    checkpoint: checkpoint({
      phase: "verify",
      toolCallsUsed: 1,
      inspectedFiles: ["src/entry.ts"],
      evidenceRefs: ["pico://evidence/cycle-one"],
    }),
  });
  const beforeCycleOverflow = await fixture.store.readSession("cycle-session");
  await assert.rejects(
    cycleCoordinator.checkpoint({
      operationId: "cycle-two",
      discoveryId: "cycle-discovery",
      checkpoint: checkpoint({ phase: "forage", cycle: 2 }),
    }),
    DiscoveryConflictError,
  );
  assert.deepEqual(await fixture.store.readSession("cycle-session"), beforeCycleOverflow);
});

test("Discovery Coordinator serializes concurrent branches and merges overlap without double-counting files", async (context) => {
  const fixture = await createFixture("branches");
  context.after(() => fixture.dispose());
  const coordinator = fixture.coordinator("branch-session");
  await coordinator.start({
    operationId: "start-balanced",
    discoveryId: "balanced-discovery",
    objective: "并行验证候选入口",
    depth: "balanced",
  });

  const branchStarts = await Promise.all([
    coordinator.startBranch({
      operationId: "start-branch-a",
      discoveryId: "balanced-discovery",
      branchId: "branch-a",
      ordinal: 0,
      objective: "沿入口追踪",
      roots: ["src"],
      queries: ["routeRequest"],
      stoppingCondition: "找到实现与直接证据",
      reserveToolCalls: 8,
      reserveFiles: 10,
    }),
    coordinator.startBranch({
      operationId: "start-branch-b",
      discoveryId: "balanced-discovery",
      branchId: "branch-b",
      ordinal: 1,
      objective: "从验证路径反查",
      roots: ["tests"],
      queries: ["routeRequest"],
      stoppingCondition: "找到测试覆盖与目标实现",
      reserveToolCalls: 8,
      reserveFiles: 10,
    }),
  ]);
  assert.equal(branchStarts[0]?.active?.branches.length, 1);
  assert.equal(branchStarts[1]?.active?.branches.length, 2);

  const target = candidate("src/target.ts", "routeRequest", 0.8, ["evidence:a"]);
  await Promise.all([
    coordinator.checkpointBranch({
      operationId: "checkpoint-branch-a",
      discoveryId: "balanced-discovery",
      branchId: "branch-a",
      checkpoint: checkpoint({
        toolCallsUsed: 4,
        inspectedFiles: ["src/entry.ts", "src/target.ts"],
        candidates: [target],
        evidenceRefs: ["evidence:a"],
      }),
    }),
    coordinator.checkpointBranch({
      operationId: "checkpoint-branch-b",
      discoveryId: "balanced-discovery",
      branchId: "branch-b",
      checkpoint: checkpoint({
        toolCallsUsed: 3,
        inspectedFiles: ["src/target.ts", "tests/target.test.ts"],
        candidates: [candidate("src/target.ts", "routeRequest", 0.95, ["evidence:b"])],
        evidenceRefs: ["evidence:b"],
      }),
    }),
  ]);

  const projection = await coordinator.project();
  assert.equal(projection.active?.budget.consumedToolCalls, 7);
  assert.equal(projection.active?.budget.consumedFiles, 3);
  assert.deepEqual(projection.active?.inspectedFiles, [
    "src/entry.ts",
    "src/target.ts",
    "tests/target.test.ts",
  ]);
  assert.deepEqual(projection.active?.evidenceRefs, ["evidence:a", "evidence:b"]);
  assert.equal(projection.active?.candidates.length, 1);
  assert.equal(projection.active?.candidates[0]?.score, 0.95);
  assert.deepEqual(projection.active?.candidates[0]?.evidenceRefs, ["evidence:a", "evidence:b"]);

  const beforeReplay = await fixture.store.readSession("branch-session");
  await coordinator.checkpointBranch({
    operationId: "checkpoint-branch-a",
    discoveryId: "balanced-discovery",
    branchId: "branch-a",
    checkpoint: checkpoint({
      toolCallsUsed: 4,
      inspectedFiles: ["src/entry.ts", "src/target.ts"],
      candidates: [target],
      evidenceRefs: ["evidence:a"],
    }),
  });
  assert.deepEqual(await fixture.store.readSession("branch-session"), beforeReplay);
  await assert.rejects(
    coordinator.checkpointBranch({
      operationId: "checkpoint-branch-a",
      discoveryId: "balanced-discovery",
      branchId: "branch-a",
      checkpoint: checkpoint({
        toolCallsUsed: 5,
        inspectedFiles: ["src/entry.ts", "src/target.ts"],
      }),
    }),
    /conflicts/u,
  );
});

test("Discovery resume replaces terminal branch slots without reopening history", async (context) => {
  const fixture = await createFixture("resume-branches");
  context.after(() => fixture.dispose());
  const coordinator = fixture.coordinator("resume-branch-session");
  await coordinator.start({
    operationId: "start-resume-branches",
    discoveryId: "resume-branch-discovery",
    objective: "恢复并发调查",
    depth: "deep",
  });

  for (const [ordinal, branchId] of ["old-completed", "old-partial", "old-failed"].entries()) {
    await coordinator.startBranch({
      operationId: `start-${branchId}`,
      discoveryId: "resume-branch-discovery",
      branchId,
      ordinal,
      objective: `旧调查分支 ${branchId}`,
      roots: [`src/${branchId}`],
      queries: ["routeRequest"],
      stoppingCondition: "找到直接证据",
      reserveToolCalls: 6,
      reserveFiles: 8,
    });
  }
  await coordinator.checkpointBranch({
    operationId: "checkpoint-old-completed",
    discoveryId: "resume-branch-discovery",
    branchId: "old-completed",
    checkpoint: checkpoint({
      toolCallsUsed: 3,
      inspectedFiles: ["src/old-completed/entry.ts", "src/shared/target.ts"],
      evidenceRefs: ["evidence:old-completed"],
    }),
  });
  for (const [branchId, status] of [
    ["old-completed", "completed"],
    ["old-partial", "partial"],
    ["old-failed", "failed"],
  ] as const) {
    await coordinator.completeBranch({
      operationId: `complete-${branchId}`,
      discoveryId: "resume-branch-discovery",
      branchId,
      status,
      consumedToolCalls: branchId === "old-completed" ? 3 : 0,
      inspectedFiles:
        branchId === "old-completed" ? ["src/old-completed/entry.ts", "src/shared/target.ts"] : [],
    });
  }
  await coordinator.startBranch({
    operationId: "start-old-cancelled",
    discoveryId: "resume-branch-discovery",
    branchId: "old-cancelled",
    ordinal: 0,
    objective: "中断时仍在运行的历史分支",
    roots: ["src/old-cancelled"],
    queries: ["routeRequest"],
    stoppingCondition: "找到直接证据",
    reserveToolCalls: 6,
    reserveFiles: 8,
  });

  const interrupted = await coordinator.interrupt({
    operationId: "interrupt-resume-branches",
    discoveryId: "resume-branch-discovery",
    reason: "host restarted",
  });
  assert.deepEqual(
    interrupted.latest?.branches.map(({ branchId, status }) => ({ branchId, status })),
    [
      { branchId: "old-completed", status: "completed" },
      { branchId: "old-cancelled", status: "cancelled" },
      { branchId: "old-partial", status: "partial" },
      { branchId: "old-failed", status: "failed" },
    ],
  );

  fixture.store.close();
  fixture.reopenStore();
  const reopened = fixture.coordinator("resume-branch-session");
  const resumed = await reopened.resume({
    operationId: "resume-with-deep-budget",
    discoveryId: "resume-branch-discovery",
    depth: "deep",
  });
  assert.equal(resumed.active?.budget.consumedToolCalls, 3);
  assert.equal(resumed.active?.budget.consumedFiles, 2);
  assert.equal(resumed.active?.budget.reservedToolCalls, 0);
  assert.equal(resumed.active?.budget.reservedFiles, 0);

  for (const [ordinal, branchId] of ["new-a", "new-b", "new-c"].entries()) {
    await reopened.startBranch({
      operationId: `start-${branchId}`,
      discoveryId: "resume-branch-discovery",
      branchId,
      ordinal,
      objective: `恢复调查分支 ${branchId}`,
      roots: [`src/${branchId}`],
      queries: ["routeRequest"],
      stoppingCondition: "找到直接证据",
      reserveToolCalls: 5,
      reserveFiles: 8,
    });
  }

  const restarted = await reopened.project();
  assert.deepEqual(
    restarted.active?.branches.map(({ branchId, ordinal, status }) => ({
      branchId,
      ordinal,
      status,
    })),
    [
      { branchId: "old-completed", ordinal: 0, status: "completed" },
      { branchId: "old-cancelled", ordinal: 0, status: "cancelled" },
      { branchId: "new-a", ordinal: 0, status: "running" },
      { branchId: "old-partial", ordinal: 1, status: "partial" },
      { branchId: "new-b", ordinal: 1, status: "running" },
      { branchId: "old-failed", ordinal: 2, status: "failed" },
      { branchId: "new-c", ordinal: 2, status: "running" },
    ],
  );
  assert.equal(restarted.active?.budget.consumedToolCalls, 3);
  assert.equal(restarted.active?.budget.consumedFiles, 2);
  assert.equal(restarted.active?.budget.reservedToolCalls, 15);
  assert.equal(restarted.active?.budget.reservedFiles, 24);

  await assert.rejects(
    reopened.startBranch({
      operationId: "start-over-limit-after-resume",
      discoveryId: "resume-branch-discovery",
      branchId: "new-d",
      ordinal: 3,
      objective: "超过恢复后的并发分支上限",
      stoppingCondition: "不应启动",
      reserveToolCalls: 1,
      reserveFiles: 1,
    }),
    /branch limit reached/u,
  );
  await assert.rejects(
    reopened.checkpointBranch({
      operationId: "reopen-old-completed",
      discoveryId: "resume-branch-discovery",
      branchId: "old-completed",
      checkpoint: checkpoint({
        toolCallsUsed: 4,
        inspectedFiles: ["src/old-completed/entry.ts", "src/shared/target.ts"],
      }),
    }),
    /branch is not running/u,
  );
  await assert.rejects(
    reopened.startBranch({
      operationId: "reuse-old-branch-id",
      discoveryId: "resume-branch-discovery",
      branchId: "old-completed",
      ordinal: 3,
      objective: "复用历史分支标识",
      stoppingCondition: "不应启动",
      reserveToolCalls: 1,
      reserveFiles: 1,
    }),
    /branch id already exists/u,
  );
});

test("Discovery preserves CAS, restart, rewind and resume semantics", async (context) => {
  const fixture = await createFixture("replay");
  context.after(() => fixture.dispose());
  const coordinator = fixture.coordinator("replay-session");
  const started = await coordinator.start({
    operationId: "start-replay",
    discoveryId: "replay-discovery",
    objective: "恢复调查状态",
    depth: "balanced",
  });
  const staleSequence = started.sessionSequence;
  const focused = await coordinator.checkpoint({
    operationId: "focus-replay",
    discoveryId: "replay-discovery",
    checkpoint: checkpoint({
      phase: "focus",
      toolCallsUsed: 3,
      inspectedFiles: ["src/entry.ts", "src/target.ts"],
      candidates: [candidate("src/target.ts", "routeRequest", 0.7, ["evidence:focus"])],
      evidenceRefs: ["evidence:focus"],
    }),
  });
  await assert.rejects(
    coordinator.interrupt({
      operationId: "stale-interrupt",
      expectedSessionSequence: staleSequence,
      discoveryId: "replay-discovery",
      reason: "stale host",
    }),
    RuntimeEventStoreHighWaterConflictError,
  );
  const interrupted = await coordinator.interrupt({
    operationId: "interrupt-replay",
    expectedSessionSequence: focused.sessionSequence,
    discoveryId: "replay-discovery",
    reason: "host restarted",
  });
  assert.equal(interrupted.latest?.status, "interrupted");

  const interruptedEvent = (await fixture.store.readSession("replay-session")).findLast(
    (event) => event.kind === "discovery.interrupted",
  );
  assert.ok(interruptedEvent);
  fixture.store.close();
  fixture.reopenStore();
  const reopened = fixture.coordinator("replay-session");
  const replayed = await reopened.project();
  assert.equal(replayed.latest?.status, "interrupted");
  assert.equal(replayed.latest?.budget.consumedToolCalls, 3);
  assert.equal(replayed.latest?.budget.consumedFiles, 2);

  const resumed = await reopened.resume({
    operationId: "resume-replay",
    expectedSessionSequence: replayed.sessionSequence,
    discoveryId: "replay-discovery",
    depth: "deep",
  });
  assert.equal(resumed.active?.status, "active");
  assert.equal(resumed.active?.depth, "deep");
  assert.equal(resumed.active?.budget.consumedToolCalls, 3);
  assert.equal(resumed.active?.budget.consumedFiles, 2);
  assert.deepEqual(
    {
      maxBranches: resumed.active?.budget.maxBranches,
      maxCycles: resumed.active?.budget.maxCycles,
      maxToolCalls: resumed.active?.budget.maxToolCalls,
      maxFiles: resumed.active?.budget.maxFiles,
    },
    DISCOVERY_DEPTH_BUDGETS.deep,
  );

  await fixture.store.append(
    rewindEvent({
      sessionId: "replay-session",
      throughEventId: interruptedEvent.eventId,
    }),
  );
  const rewound = await reopened.project();
  assert.equal(rewound.latest?.status, "interrupted");
  assert.equal(rewound.active, undefined);
  assert.equal(
    (await fixture.store.readSession("replay-session")).filter(
      (event) => event.kind === "discovery.resumed",
    ).length,
    1,
  );

  const resumedAfterRewind = await reopened.resume({
    operationId: "resume-after-rewind",
    expectedSessionSequence: rewound.sessionSequence,
    discoveryId: "replay-discovery",
    depth: "deep",
  });
  assert.equal(resumedAfterRewind.active?.status, "active");
  assert.equal(
    (await fixture.store.readSession("replay-session")).filter(
      (event) => event.kind === "discovery.resumed",
    ).length,
    2,
  );
});

interface Fixture {
  store: RuntimeEventStore;
  readonly storageRoot: string;
  coordinator(sessionId: string): DiscoveryCoordinator;
  reopenStore(): void;
  dispose(): Promise<void>;
}

async function createFixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-discovery-${label}-`));
  const workDir = join(root, "workspace");
  const storageRoot = join(root, "state");
  await mkdir(workDir);
  const initialized = new Set<string>();
  const fixture: Fixture = {
    store: new RuntimeEventStore({ storageRoot }),
    storageRoot,
    coordinator(sessionId) {
      if (!initialized.has(sessionId)) {
        throw new Error(`Session ${sessionId} must be initialized before creating a coordinator`);
      }
      return new DiscoveryCoordinator(
        fixture.store,
        { sessionId, invocationId: "invocation", runId: "run", turnId: "turn" },
        () => AT,
      );
    },
    reopenStore() {
      fixture.store = new RuntimeEventStore({ storageRoot });
    },
    async dispose() {
      fixture.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };

  const originalCoordinator = fixture.coordinator.bind(fixture);
  fixture.coordinator = (sessionId: string) => {
    if (!initialized.has(sessionId)) {
      throw new Error(`Call initializeSession(${sessionId}) before coordinator()`);
    }
    return originalCoordinator(sessionId);
  };
  for (const sessionId of [
    "budget-session",
    "cycle-session",
    "branch-session",
    "resume-branch-session",
    "replay-session",
  ]) {
    await fixture.store.initializeSession({ sessionId, workDir });
    initialized.add(sessionId);
  }
  return fixture;
}

function checkpoint(overrides: Partial<DiscoveryCheckpoint> = {}): DiscoveryCheckpoint {
  return {
    phase: "forage",
    cycle: 1,
    candidates: [],
    evidenceRefs: [],
    hypotheses: [],
    openQuestions: [],
    toolCallsUsed: 0,
    inspectedFiles: [],
    ...overrides,
  };
}

function candidate(
  path: string,
  symbol: string,
  score: number,
  evidenceRefs: readonly string[],
): DiscoveryCandidate {
  return {
    path,
    symbol,
    score,
    reasons: ["与症状路径一致"],
    evidenceRefs,
  };
}

function numberedFiles(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`,
  );
}

function rewindEvent(input: { sessionId: string; throughEventId: string }): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: "rewind-after-resume",
    sessionId: input.sessionId,
    invocationId: "invocation",
    runId: "run",
    turnId: "turn",
    at: AT.toISOString(),
    partial: false,
    visibility: "internal",
    kind: "history.rewound",
    data: { branchId: "branch-after-rewind", throughEventId: input.throughEventId },
  };
}
