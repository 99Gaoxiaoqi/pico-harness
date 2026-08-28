import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentGraphSupervisorService,
  type AgentGraphDriveResult,
  type AgentGraphDrivePort,
  type AgentGraphRootWakePort,
  type AgentGraphYieldSnapshot,
  type RecoverableAgentGraphSupervisorWake,
  type RootSupervisorRunIdentity,
  type RootSupervisorRunState,
} from "../../src/agent-graph/supervisor-service.js";
import type {
  AgentGraphRecord,
  AgentGraphSupervisorWakeAttemptRecord,
  AgentGraphSupervisorWakeRecord,
  ClaimAgentGraphSupervisorWakeInput,
  ClaimAgentGraphSupervisorWakeResult,
  SettleAgentGraphSupervisorWakeInput,
} from "../../src/storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

test("startup recovers open graphs and due supervisor wakes", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  store.addWake(wakeRecord());
  const drive = new FakeDrivePort(["graph-1"]);
  const root = new FakeRootWakePort();
  root.startState = { status: "completed" };
  const service = new AgentGraphSupervisorService({ store, drivePort: drive, rootWakePort: root });

  await service.start();

  assert.equal(drive.calls, 1);
  assert.equal(root.starts.length, 1);
  assert.equal(store.wakes.get("wake-1")?.status, "delivered");
  assert.equal(store.attempts.size, 1);
  await service.close();
});

test("reconcile wake candidates do not bypass the durable yield permit gate", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  const drive = new FakeDrivePort(["graph-1"]);
  drive.onDrive = () => ({
    wakeCandidates: [
      {
        dedupeKey: "runtime-terminal:child-run-1",
        cause: "runtime_terminal",
        payload: { claimId: "claim-1" },
      },
    ],
  });
  const root = new FakeRootWakePort();
  root.startState = { status: "completed" };
  const service = new AgentGraphSupervisorService({ store, drivePort: drive, rootWakePort: root });

  await service.start();

  assert.equal(store.wakes.size, 0);
  assert.equal(root.starts.length, 0);
  await service.close();
});

test("same-graph notifications are single-flight and collapse to one rerun", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  const drive = new FakeDrivePort([]);
  const gate = deferred<void>();
  drive.onDrive = async (call) => {
    if (call === 1) await gate.promise;
  };
  const service = new AgentGraphSupervisorService({
    store,
    drivePort: drive,
    rootWakePort: new FakeRootWakePort(),
  });
  await service.start();

  const first = service.notifyGraph("graph-1");
  const second = service.notifyGraph("graph-1");
  const third = service.notifyGraph("graph-1");
  gate.resolve();
  await Promise.all([first, second, third]);

  assert.equal(drive.calls, 2);
  assert.equal(drive.maxConcurrent, 1);
  await service.close();
});

test("yield registers interest before snapshot and loses no completion around the race", async (t) => {
  for (const timing of ["before", "during", "after"] as const) {
    await t.test(timing, async () => {
      const store = new SharedWakeStore();
      store.addGraph(graphRecord());
      const drive = new FakeDrivePort([]);
      const root = new FakeRootWakePort();
      root.startState = { status: "completed" };
      const service = new AgentGraphSupervisorService({
        store,
        drivePort: drive,
        rootWakePort: root,
      });
      await service.start();
      const enqueue = () => {
        if (!store.wakes.has("wake-1")) store.addWake(wakeRecord());
      };
      if (timing === "before") enqueue();
      if (timing === "during") drive.onDrive = async () => enqueue();

      const yielded = await service.registerYield({
        permitId: `permit-${timing}`,
        graphId: "graph-1",
        rootSessionId: "root-1",
        rootRunId: `yielding-run-${timing}`,
      });
      if (timing === "after") {
        enqueue();
        await service.notifyGraph("graph-1");
      }

      assert.equal(drive.events[0], `register:permit-${timing}`);
      assert.equal(yielded.snapshot.graphId, "graph-1");
      assert.equal(store.wakes.get("wake-1")?.status, "delivered");
      assert.equal(root.starts.length, 1);
      await service.close();
    });
  }
});

test("yield rejects when quiescence has no executing work and cancellation wins", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  const drive = new FakeDrivePort([]);
  drive.cancelState = "cancelled";
  const service = new AgentGraphSupervisorService({
    store,
    drivePort: drive,
    rootWakePort: new FakeRootWakePort(),
  });
  await service.start();

  await assert.rejects(
    service.registerYield({
      permitId: "permit-without-progress",
      graphId: "graph-1",
      rootSessionId: "root-1",
      rootRunId: "yielding-run",
    }),
    /没有可等待的未来进展/u,
  );
  assert.deepEqual(drive.events, ["register:permit-without-progress", "snapshot:graph-1"]);
  await service.close();
});

test("yield rejects a finished Graph even when an old Claim still appears executing", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  const drive = new FakeDrivePort([]);
  drive.snapshotPhase = "finished";
  drive.snapshotExecuting = 1;
  drive.cancelState = "cancelled";
  const service = new AgentGraphSupervisorService({
    store,
    drivePort: drive,
    rootWakePort: new FakeRootWakePort(),
  });
  await service.start();

  await assert.rejects(
    service.registerYield({
      permitId: "permit-finished",
      graphId: "graph-1",
      rootSessionId: "root-1",
      rootRunId: "yielding-run",
    }),
    /没有可等待的未来进展/u,
  );
  await service.close();
});

test("two services competing for one wake create and execute only one attempt", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-graph-supervisor-race-"));
  const firstStore = new SqliteAgentGraphControlStore({ storageRoot });
  firstStore.createGraph({ graphId: "graph-1", rootSessionId: "root-1", epoch: 1 });
  firstStore.enqueueSupervisorWake({
    wakeId: "wake-1",
    graphId: "graph-1",
    dedupeKey: "runtime-terminal:child-run-1",
    wakeFingerprint: "fingerprint-1",
    cause: "runtime_terminal",
    payload: { claimId: "claim-1" },
  });
  const secondStore = new SqliteAgentGraphControlStore({ storageRoot });
  const root = new FakeRootWakePort();
  root.startState = { status: "completed" };
  const errors: unknown[] = [];
  const first = new AgentGraphSupervisorService({
    store: new SqliteSupervisorTestPort(firstStore),
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
    onError: (error) => errors.push(error),
  });
  const second = new AgentGraphSupervisorService({
    store: new SqliteSupervisorTestPort(secondStore),
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
    onError: (error) => errors.push(error),
  });

  try {
    await Promise.all([first.start(), second.start()]);

    assert.equal(firstStore.listSupervisorWakeAttempts("wake-1").length, 1);
    assert.equal(root.starts.length, 1);
    assert.equal(firstStore.getSupervisorWake("wake-1")?.status, "delivered");
    assert.equal(errors.length, 0);
    await Promise.all([first.close(), second.close()]);
  } finally {
    firstStore.close();
    secondStore.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("a new service resumes the exact running attempt after a crash boundary", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  store.addWake(wakeRecord());
  const root = new FakeRootWakePort();
  root.startState = { status: "running" };
  const first = new AgentGraphSupervisorService({
    store,
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
  });
  await first.start();
  assert.equal(store.wakes.get("wake-1")?.status, "running");
  const admittedRunId = root.starts[0]?.targetRunId;
  await first.close();

  root.inspectState = { status: "running" };
  root.startState = { status: "completed" };
  const recovered = new AgentGraphSupervisorService({
    store,
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
  });
  await recovered.start();

  assert.equal(root.starts.length, 2);
  assert.equal(root.starts[1]?.targetRunId, admittedRunId);
  assert.equal(store.attempts.size, 1);
  assert.equal(store.wakes.get("wake-1")?.status, "delivered");
  await recovered.close();
});

test("waiting permission resumes only after an explicit signal and close takes no new work", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  store.addWake(wakeRecord());
  const root = new FakeRootWakePort();
  root.startState = { status: "waiting_permission", error: "approval required" };
  const drive = new FakeDrivePort([]);
  const service = new AgentGraphSupervisorService({ store, drivePort: drive, rootWakePort: root });
  await service.start();
  assert.equal(store.wakes.get("wake-1")?.status, "waiting_permission");
  assert.equal(root.starts.length, 1);

  await service.scanRecoverableWakes();
  assert.equal(root.starts.length, 1);
  root.inspectState = { status: "waiting_permission", error: "approval required" };
  root.startState = { status: "completed" };
  await service.resumeWaitingPermission("wake-1");
  assert.equal(root.starts.length, 2);
  assert.equal(store.wakes.get("wake-1")?.status, "delivered");

  await service.close();
  store.addWake(wakeRecord({ wakeId: "wake-after-close", dedupeKey: "after-close" }));
  await service.notifyGraph("graph-1");
  await service.scanRecoverableWakes();
  assert.equal(store.wakes.get("wake-after-close")?.status, "pending");
  assert.equal(drive.calls, 0);
});

test("retryable failures wait for their due time and allocate a new exact attempt", async () => {
  let now = 10;
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  store.addWake(wakeRecord({ availableAt: now }));
  const root = new FakeRootWakePort();
  root.startState = { status: "failed", error: "runtime unavailable" };
  const service = new AgentGraphSupervisorService({
    store,
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
    now: () => now,
    retryDelayMs: () => 500,
  });
  await service.start();
  assert.equal(store.wakes.get("wake-1")?.status, "retryable_failed");
  assert.equal(store.wakes.get("wake-1")?.availableAt, 510);

  await service.scanRecoverableWakes();
  assert.equal(store.attempts.size, 1);
  now = 510;
  root.startState = { status: "completed" };
  await service.scanRecoverableWakes();

  assert.equal(store.attempts.size, 2);
  assert.equal(new Set(root.starts.map(({ targetRunId }) => targetRunId)).size, 2);
  assert.equal(store.wakes.get("wake-1")?.status, "delivered");
  await service.close();
});

test("ordinary root wake failures stop after five attempts and explicit retry preserves history", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-graph-wake-attention-"));
  let now = 10;
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: () => now });
  store.createGraph({ graphId: "graph-1", rootSessionId: "root-1", epoch: 1 });
  store.enqueueSupervisorWake({
    wakeId: "wake-1",
    graphId: "graph-1",
    dedupeKey: "runtime-terminal:child-run-1",
    wakeFingerprint: "fingerprint-1",
    cause: "runtime_terminal",
    payload: { claimId: "claim-1" },
  });
  const root = new FakeRootWakePort();
  root.startState = { status: "failed", error: "token=private-value runtime unavailable" };
  const first = new AgentGraphSupervisorService({
    store: new SqliteSupervisorTestPort(store),
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
    now: () => now,
    retryDelayMs: () => 500,
  });

  try {
    await first.start();
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      now += 500;
      await first.scanRecoverableWakes();
    }
    assert.equal(store.getSupervisorWake("wake-1")?.status, "needs_attention");
    assert.equal(store.listSupervisorWakeAttempts("wake-1").length, 5);
    assert.doesNotMatch(store.getSupervisorWake("wake-1")?.lastError ?? "", /private-value/u);
    await first.scanRecoverableWakes();
    assert.equal(root.starts.length, 5, "needs-attention wake must not busy-loop");
    await first.close();

    const recovered = new AgentGraphSupervisorService({
      store: new SqliteSupervisorTestPort(store),
      drivePort: new FakeDrivePort([]),
      rootWakePort: root,
      now: () => now,
      retryDelayMs: () => 500,
    });
    await recovered.start();
    assert.equal(root.starts.length, 5, "restart must preserve the attention fence");

    root.startState = { status: "completed" };
    assert.equal(await recovered.retryNeedsAttention("wake-1"), true);
    assert.equal(store.getSupervisorWake("wake-1")?.status, "delivered");
    const attempts = store.listSupervisorWakeAttempts("wake-1");
    assert.equal(attempts.length, 6);
    assert.equal(new Set(attempts.map((attempt) => attempt.targetRunId)).size, 6);
    await recovered.close();
  } finally {
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("finished graphs do not admit a fresh root wake", async () => {
  const store = new SharedWakeStore();
  store.addGraph({ ...graphRecord(), phase: "finished", finishedAt: 2 });
  store.addWake(wakeRecord());
  const root = new FakeRootWakePort();
  root.startState = { status: "completed" };
  const service = new AgentGraphSupervisorService({
    store,
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
  });

  await service.start();

  assert.equal(root.starts.length, 0);
  assert.equal(store.wakes.get("wake-1")?.status, "pending");
  assert.equal(store.attempts.size, 0);
  await service.close();
});

test("startup does not resume a running wake after its Graph was retired", async () => {
  const store = new SharedWakeStore();
  store.addGraph(graphRecord());
  store.addWake(wakeRecord());
  const root = new FakeRootWakePort();
  root.startState = { status: "running" };
  const first = new AgentGraphSupervisorService({
    store,
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
  });
  await first.start();
  assert.equal(root.starts.length, 1);
  await first.close();

  store.addGraph({ ...graphRecord(), phase: "finished", finishedAt: 2 });
  const recovered = new AgentGraphSupervisorService({
    store,
    drivePort: new FakeDrivePort([]),
    rootWakePort: root,
  });
  await recovered.start();

  assert.equal(root.starts.length, 1, "retired root wake must not recreate its Session");
  assert.equal(store.wakes.get("wake-1")?.status, "delivered");
  await recovered.close();
});

class FakeDrivePort implements AgentGraphDrivePort {
  calls = 0;
  active = 0;
  maxConcurrent = 0;
  readonly events: string[] = [];
  onDrive?: (call: number) => Promise<AgentGraphDriveResult | void> | AgentGraphDriveResult | void;
  cancelState: "registered" | "consumed" | "cancelled" = "consumed";
  snapshotPhase: AgentGraphYieldSnapshot["phase"] = "open";
  snapshotExecuting = 0;

  constructor(private readonly openGraphIds: readonly string[]) {}

  listOpenGraphIds(): readonly string[] {
    return this.openGraphIds;
  }

  async driveGraph(): Promise<AgentGraphDriveResult | void> {
    this.calls += 1;
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      return await this.onDrive?.(this.calls);
    } finally {
      this.active -= 1;
    }
  }

  registerYieldInterest(input: { permitId: string }): void {
    this.events.push(`register:${input.permitId}`);
  }

  cancelYieldInterestIfRegistered(): "registered" | "consumed" | "cancelled" {
    return this.cancelState;
  }

  readYieldSnapshot(graphId: string): AgentGraphYieldSnapshot {
    this.events.push(`snapshot:${graphId}`);
    return {
      graphId,
      headRevision: 1,
      phase: this.snapshotPhase,
      pending: 0,
      executing: this.snapshotExecuting,
      availableRecordIds: [],
    };
  }
}

class FakeRootWakePort implements AgentGraphRootWakePort {
  inspectState: RootSupervisorRunState = { status: "not_started" };
  startState: RootSupervisorRunState = { status: "running" };
  readonly starts: RootSupervisorRunIdentity[] = [];

  async inspect(): Promise<RootSupervisorRunState> {
    return this.inspectState;
  }

  async startOrResume(input: RootSupervisorRunIdentity): Promise<RootSupervisorRunState> {
    this.starts.push(input);
    return this.startState;
  }
}

class SharedWakeStore {
  readonly graphs = new Map<string, AgentGraphRecord>();
  readonly wakes = new Map<string, AgentGraphSupervisorWakeRecord>();
  readonly attempts = new Map<string, AgentGraphSupervisorWakeAttemptRecord>();

  addGraph(graph: AgentGraphRecord): void {
    this.graphs.set(graph.graphId, graph);
  }

  addWake(wake: AgentGraphSupervisorWakeRecord): void {
    this.wakes.set(wake.wakeId, wake);
  }

  enqueueSupervisorWake(input: {
    wakeId: string;
    graphId: string;
    dedupeKey: string;
    wakeFingerprint: string;
    cause: AgentGraphSupervisorWakeRecord["cause"];
    payload: unknown;
    availableAt?: number;
  }): { record: AgentGraphSupervisorWakeRecord; replayed: boolean } {
    const existing = [...this.wakes.values()].find(
      (wake) => wake.graphId === input.graphId && wake.dedupeKey === input.dedupeKey,
    );
    if (existing) return { record: existing, replayed: true };
    const record = wakeRecord({
      wakeId: input.wakeId,
      graphId: input.graphId,
      dedupeKey: input.dedupeKey,
      wakeFingerprint: input.wakeFingerprint,
      cause: input.cause,
      payload: input.payload,
      availableAt: input.availableAt ?? 1,
    });
    this.wakes.set(record.wakeId, record);
    return { record, replayed: false };
  }

  enqueueSupervisorWakeForYield(): { status: "not_waiting" } {
    return { status: "not_waiting" };
  }

  listRecoverableSupervisorWakes(_at: number): readonly RecoverableAgentGraphSupervisorWake[] {
    return [...this.wakes.values()]
      .filter(
        (wake) =>
          wake.status === "pending" ||
          wake.status === "retryable_failed" ||
          wake.status === "running" ||
          wake.status === "waiting_permission",
      )
      .map((wake) => this.recoverable(wake));
  }

  getRecoverableSupervisorWake(wakeId: string): RecoverableAgentGraphSupervisorWake | undefined {
    const wake = this.wakes.get(wakeId);
    return wake ? this.recoverable(wake) : undefined;
  }

  claimSupervisorWake(
    input: ClaimAgentGraphSupervisorWakeInput,
  ): ClaimAgentGraphSupervisorWakeResult {
    const existing = this.attempts.get(input.attemptId);
    if (existing) {
      return { wake: this.requireWake(input.wakeId), attempt: existing, replayed: true };
    }
    const wake = this.requireWake(input.wakeId);
    if (
      wake.version !== input.expectedWakeVersion ||
      (wake.status !== "pending" && wake.status !== "retryable_failed")
    ) {
      throw new Error("wake claim conflict");
    }
    const now = wake.updatedAt + 1;
    const attempt: AgentGraphSupervisorWakeAttemptRecord = {
      attemptId: input.attemptId,
      wakeId: wake.wakeId,
      attemptNumber: wake.attemptCount + 1,
      rootSessionId: input.rootSessionId,
      targetTurnId: input.targetTurnId,
      targetRunId: input.targetRunId,
      status: "running",
      version: 1,
      startedAt: now,
      updatedAt: now,
    };
    this.attempts.set(attempt.attemptId, attempt);
    const claimed = {
      ...wake,
      status: "running" as const,
      attemptCount: attempt.attemptNumber,
      version: wake.version + 1,
      updatedAt: now,
      lastError: undefined,
    };
    this.wakes.set(wake.wakeId, claimed);
    return { wake: claimed, attempt, replayed: false };
  }

  settleSupervisorWake(input: SettleAgentGraphSupervisorWakeInput): void {
    const wake = this.requireWake(input.wakeId);
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new Error("missing attempt");
    if (
      wake.version !== input.expectedWakeVersion ||
      attempt.version !== input.expectedAttemptVersion
    ) {
      throw new Error("wake settlement conflict");
    }
    const now = wake.updatedAt + 1;
    const status =
      input.outcome === "delivered"
        ? "completed"
        : input.outcome === "waiting_permission"
          ? "waiting_permission"
          : "failed";
    this.attempts.set(attempt.attemptId, {
      ...attempt,
      status,
      version: attempt.version + 1,
      updatedAt: now,
      ...(status === "waiting_permission" ? {} : { finishedAt: now }),
      ...(input.error !== undefined ? { error: input.error } : {}),
    });
    this.wakes.set(wake.wakeId, {
      ...wake,
      status: input.outcome,
      version: wake.version + 1,
      updatedAt: now,
      availableAt: input.retryAt ?? wake.availableAt,
      ...(input.outcome === "delivered" ? { deliveredAt: now } : {}),
      ...(input.error !== undefined ? { lastError: input.error } : {}),
    });
  }

  private recoverable(wake: AgentGraphSupervisorWakeRecord): RecoverableAgentGraphSupervisorWake {
    const graph = this.graphs.get(wake.graphId);
    if (!graph) throw new Error("missing graph");
    const attempt = [...this.attempts.values()]
      .filter((item) => item.wakeId === wake.wakeId)
      .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
    return { graph, wake, ...(attempt ? { attempt } : {}) };
  }

  private requireWake(wakeId: string): AgentGraphSupervisorWakeRecord {
    const wake = this.wakes.get(wakeId);
    if (!wake) throw new Error("missing wake");
    return wake;
  }
}

class SqliteSupervisorTestPort {
  constructor(private readonly store: SqliteAgentGraphControlStore) {}

  listRecoverableSupervisorWakes(at: number): readonly RecoverableAgentGraphSupervisorWake[] {
    return this.store.listRecoverableSupervisorWakes(at);
  }

  getRecoverableSupervisorWake(wakeId: string): RecoverableAgentGraphSupervisorWake | undefined {
    return this.store.getRecoverableSupervisorWake(wakeId);
  }

  claimSupervisorWake(input: ClaimAgentGraphSupervisorWakeInput) {
    return this.store.claimSupervisorWake(input);
  }

  enqueueSupervisorWake(
    input: Parameters<SqliteAgentGraphControlStore["enqueueSupervisorWake"]>[0],
  ) {
    return this.store.enqueueSupervisorWake(input);
  }

  enqueueSupervisorWakeForYield(
    input: Parameters<SqliteAgentGraphControlStore["enqueueSupervisorWakeForYield"]>[0],
  ) {
    return this.store.enqueueSupervisorWakeForYield(input);
  }

  settleSupervisorWake(input: SettleAgentGraphSupervisorWakeInput) {
    return this.store.settleSupervisorWake(input);
  }

  retrySupervisorWake(input: Parameters<SqliteAgentGraphControlStore["retrySupervisorWake"]>[0]) {
    return this.store.retrySupervisorWake(input);
  }
}

function graphRecord(): AgentGraphRecord {
  return {
    graphId: "graph-1",
    rootSessionId: "root-1",
    epoch: 1,
    phase: "open",
    headRevision: 1,
    createdAt: 1,
  };
}

function wakeRecord(
  overrides: Partial<AgentGraphSupervisorWakeRecord> = {},
): AgentGraphSupervisorWakeRecord {
  return {
    wakeId: "wake-1",
    graphId: "graph-1",
    dedupeKey: "runtime-terminal:child-run-1",
    wakeFingerprint: "fingerprint-1",
    cause: "runtime_terminal",
    payload: { claimId: "claim-1" },
    status: "pending",
    availableAt: 1,
    attemptCount: 0,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
