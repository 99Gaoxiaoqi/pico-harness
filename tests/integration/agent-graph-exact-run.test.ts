import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentEngine } from "../../src/engine/loop.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import { Session } from "../../src/engine/session.js";
import type { HookOutput } from "../../src/hooks/types.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../../src/storage/runtime-event.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import {
  agentGraphInputRuntimeEventId,
  inspectAgentGraphExactRun,
  SqliteAgentGraphExactRunPort,
  type CreateAgentGraphExactRunPortOptions,
  type ExecuteAgentGraphExactRunInput,
} from "../../src/runtime/agent-graph-exact-run-port.js";
import type { StartExactAgentGraphRunInput } from "../../src/runtime/agent-graph-runtime-adapter.js";
import { RuntimeRunExecutor } from "../../src/runtime/runtime-run-executor.js";
import { currentRuntimeRun, RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";

const EXACT_RUN: StartExactAgentGraphRunInput = {
  claimId: "claim-exact-1",
  sessionId: "graph-child-session-1",
  turnId: "graph-child-turn-1",
  runId: "graph-child-run-1",
  invocationId: "graph-child-invocation-1",
  runStartedEventId: "graph-child-run-started-1",
  workDir: "/replaced-by-fixture",
  prompt: "research exact-run recovery",
};

test("RuntimeRun exact admission atomically inserts or observes one canonical start", async () => {
  const fixture = await createFixture();
  try {
    const identity = {
      capability: fixture.session.runtimeEventCapability!,
      runId: "graph-admission-race-run",
      turnId: "graph-admission-race-turn",
      invocationId: "graph-admission-race-invocation",
      runStartedEventId: "graph-admission-race-start",
    };
    const outcomes = await Promise.all([
      RuntimeRun.admitExact({ ...identity, startedAt: "2026-01-01T00:00:00.000Z" }),
      RuntimeRun.admitExact({ ...identity, startedAt: "2026-01-01T00:00:01.000Z" }),
    ]);

    assert.deepEqual(outcomes.map(({ status }) => status).sort(), ["admitted", "observed"]);
    assert.equal(new Set(outcomes.map(({ startEvent }) => JSON.stringify(startEvent))).size, 1);
    assert.equal(
      (
        await fixture.session.runtimeEventStore!.readRun(
          identity.capability.sessionId,
          identity.runId,
        )
      ).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("Graph exact Run admits once under concurrency and replays the terminal ledger", async () => {
  const fixture = await createFixture();
  let providerDispatches = 0;
  const port = fixture.createPort(async (input) => {
    await executePrestarted(input, () => providerDispatches++);
  });
  try {
    const run = { ...EXACT_RUN, workDir: fixture.workDir };
    const [first, concurrent] = await Promise.all([
      port.startExactRun(run),
      port.startExactRun(run),
    ]);
    const replay = await port.startExactRun(run);

    assert.deepEqual([first, concurrent], ["started", "started"]);
    assert.equal(replay, "observed");
    assert.equal(providerDispatches, 1);
    const events = await port.readRunEvents(run.sessionId, run.runId);
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 1);
    assert.equal(events.filter((event) => event.kind === "model.call.started").length, 1);
    assert.equal(events.find((event) => event.kind === "run.started")?.turnId, run.turnId);
    assert.equal(
      events.filter((event) => event.eventId === agentGraphInputRuntimeEventId(run.claimId)).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("Graph exact Run validates host authority before Session pinning or run admission", async () => {
  const fixture = await createFixture();
  const run = exactRun(fixture, "preflight-rejected");
  let pins = 0;
  let executeCalls = 0;
  const port = new SqliteAgentGraphExactRunPort({
    runtimeEventStore: fixture.store,
    sessionManager: {
      async getOrCreatePinned() {
        pins += 1;
        throw new Error("Session must not be pinned");
      },
    } as unknown as SessionManager,
    validateStart: () => {
      throw new Error("invalid frozen authority");
    },
    execute: async () => void executeCalls++,
  });
  try {
    await assert.rejects(port.startExactRun(run), /invalid frozen authority/u);
    assert.equal(pins, 0);
    assert.equal(executeCalls, 0);
    assert.deepEqual(await fixture.store.readRun(run.sessionId, run.runId), []);
  } finally {
    await fixture.close();
  }
});

test("Graph exact Run safely attaches after run.started and deterministic input commit", async () => {
  const fixture = await createFixture();
  const run = { ...EXACT_RUN, workDir: fixture.workDir };
  const crashed = fixture.createPort(async (input) => {
    const runtimeRun = await RuntimeRun.start({
      capability: input.session.runtimeEventCapability!,
      runId: input.prestartedRun.runId,
      turnId: input.prestartedRun.turnId,
      invocationId: input.prestartedRun.invocationId,
      runStartedEventId: input.prestartedRun.runStartedEventId,
      now: () => new Date(input.prestartedRun.runStartedAt),
    });
    await input.session.beginRewindPoint({
      userPrompt: input.prompt,
      messageId: input.prestartedUserInput.messageId,
    });
    const receipt = await runtimeRun.commitMessageOnce(
      input.session,
      agentGraphInputRuntimeEventId(input.claimId),
      { role: "user", content: input.prompt },
    );
    await input.session.bindRewindPointSource(input.prestartedUserInput.messageId, receipt);
    throw new Error("simulated crash before provider dispatch");
  });
  try {
    await assert.rejects(crashed.startExactRun(run), /simulated crash/u);
    const before = await crashed.inspectExactRun(run);
    assert.equal(before.status, "attachable");
    if (before.status === "attachable") assert.equal(before.input, "committed");

    let providerDispatches = 0;
    const recovered = fixture.createPort(async (input) => {
      await executePrestarted(input, () => providerDispatches++);
    });
    assert.equal(await recovered.startExactRun(run), "started");
    assert.equal(providerDispatches, 1);
    const events = await recovered.readRunEvents(run.sessionId, run.runId);
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(
      events.filter((event) => event.eventId === agentGraphInputRuntimeEventId(run.claimId)).length,
      1,
    );
    assert.equal(events.find((event) => event.kind === "run.terminal")?.kind, "run.terminal");
  } finally {
    await fixture.close();
  }
});

test("Graph exact Run is indeterminate and never redispatches after provider dispatch", async () => {
  const fixture = await createFixture();
  const run = { ...EXACT_RUN, workDir: fixture.workDir };
  const crashed = fixture.createPort(async (input) => {
    const runtimeRun = await RuntimeRun.start({
      capability: input.session.runtimeEventCapability!,
      runId: input.prestartedRun.runId,
      turnId: input.prestartedRun.turnId,
      invocationId: input.prestartedRun.invocationId,
      runStartedEventId: input.prestartedRun.runStartedEventId,
      now: () => new Date(input.prestartedRun.runStartedAt),
    });
    await runtimeRun.recordModelCallStarted({
      providerCallId: "provider-call-indeterminate",
      purpose: "main",
    });
    throw new Error("simulated crash after provider dispatch");
  });
  try {
    await assert.rejects(crashed.startExactRun(run), /simulated crash/u);
    const inspection = await crashed.inspectExactRun(run);
    assert.deepEqual(
      inspection.status === "indeterminate"
        ? { status: inspection.status, reason: inspection.reason }
        : inspection,
      { status: "indeterminate", reason: "provider_dispatch_recorded" },
    );

    let redispatches = 0;
    const recovered = fixture.createPort(async () => void redispatches++);
    assert.equal(await recovered.startExactRun(run), "observed");
    assert.equal(await recovered.startExactRun(run), "observed");
    assert.equal(redispatches, 0);
    const events = await recovered.readRunEvents(run.sessionId, run.runId);
    assert.equal(events.filter((event) => event.kind === "model.call.started").length, 1);
    assert.equal(
      events.some((event) => event.kind === "run.terminal"),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("Graph exact inspection rejects a tool dispatch without pretending it is attachable", () => {
  const input = { ...EXACT_RUN, workDir: "/workspace" };
  const base = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    runId: input.runId,
    turnId: input.turnId,
    at: "2026-01-01T00:00:00.000Z",
    partial: false as const,
    visibility: "internal" as const,
  };
  const inspection = inspectAgentGraphExactRun(input, [
    {
      ...base,
      eventId: input.runStartedEventId,
      kind: "run.started",
      data: { workDir: input.workDir },
    },
    {
      ...base,
      eventId: "tool-started-indeterminate",
      refs: { stepId: "step-1", toolCallId: "tool-call-1" },
      kind: "tool.started",
      data: { toolName: "bash", argumentsHash: "hash" },
    },
  ]);
  assert.equal(inspection.status, "indeterminate");
  if (inspection.status === "indeterminate") {
    assert.equal(inspection.reason, "tool_dispatch_recorded");
  }
});

test("Graph exact stop distinguishes absent, requested, and cancelled terminal runs", async () => {
  const fixture = await createFixture();
  let executeCalls = 0;
  const stopRequests: Array<{ sessionId: string; runId: string; reason: string }> = [];
  const port = fixture.createPort(
    async () => void executeCalls++,
    (input) => {
      stopRequests.push(input);
      return true;
    },
  );
  let runtimeRun: RuntimeRun | undefined;
  try {
    const absent = exactRun(fixture, "absent");
    assert.equal(
      await port.stopExactRun({
        sessionId: absent.sessionId,
        runId: absent.runId,
        reason: "cancel absent",
      }),
      "not_started",
    );

    const active = exactRun(fixture, "active");
    runtimeRun = await startRuntimeRun(fixture, active);
    assert.equal(
      await port.stopExactRun({
        sessionId: active.sessionId,
        runId: active.runId,
        reason: "cancel active",
      }),
      "requested",
    );
    assert.deepEqual(stopRequests, [
      { sessionId: active.sessionId, runId: active.runId, reason: "cancel active" },
    ]);

    await runtimeRun.finish("cancelled", "cancelled by Graph stop");
    assert.equal(
      await port.stopExactRun({
        sessionId: active.sessionId,
        runId: active.runId,
        reason: "replayed cancel",
      }),
      "already_terminal",
    );
    assert.equal(stopRequests.length, 1);
    assert.equal(executeCalls, 0);
  } finally {
    await runtimeRun?.finish("cancelled", "test cleanup");
    await fixture.close();
  }
});

test("Graph exact stop fails closed when ownership is absent and closes a terminal race", async () => {
  const fixture = await createFixture();
  let executeCalls = 0;
  const runtimeRuns: RuntimeRun[] = [];
  try {
    const noBoundaryRun = exactRun(fixture, "no-boundary");
    const noBoundaryRuntime = await startRuntimeRun(fixture, noBoundaryRun);
    runtimeRuns.push(noBoundaryRuntime);
    const noBoundary = fixture.createPort(async () => void executeCalls++);
    await assert.rejects(
      noBoundary.stopExactRun({
        sessionId: noBoundaryRun.sessionId,
        runId: noBoundaryRun.runId,
        reason: "must stop",
      }),
      /host has no stop boundary/u,
    );
    await noBoundaryRuntime.finish("cancelled", "test cleanup");

    const unownedRun = exactRun(fixture, "unowned");
    const unownedRuntime = await startRuntimeRun(fixture, unownedRun);
    runtimeRuns.push(unownedRuntime);
    const unowned = fixture.createPort(
      async () => void executeCalls++,
      () => false,
    );
    await assert.rejects(
      unowned.stopExactRun({
        sessionId: unownedRun.sessionId,
        runId: unownedRun.runId,
        reason: "must stop",
      }),
      /not owned by this host/u,
    );
    await unownedRuntime.finish("cancelled", "test cleanup");

    const racingRun = exactRun(fixture, "terminal-race");
    const racingRuntime = await startRuntimeRun(fixture, racingRun);
    runtimeRuns.push(racingRuntime);
    const racing = fixture.createPort(
      async () => void executeCalls++,
      async () => {
        await racingRuntime.finish("cancelled", "terminal won the stop race");
        return false;
      },
    );
    assert.equal(
      await racing.stopExactRun({
        sessionId: racingRun.sessionId,
        runId: racingRun.runId,
        reason: "race with terminal",
      }),
      "already_terminal",
    );
    assert.equal(executeCalls, 0);
  } finally {
    await Promise.all(
      runtimeRuns.map((runtimeRun) => runtimeRun.finish("cancelled", "test cleanup")),
    );
    await fixture.close();
  }
});

test("Graph exact Run rejects mismatched Session and store authorities before dispatch", async () => {
  const fixture = await createFixture();
  const foreignRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-foreign-store-"));
  const foreignStore = new SqliteRuntimeEventStore({ storageRoot: foreignRoot });
  let executeCalls = 0;
  let wrongSessionReleases = 0;
  try {
    const wrongSessionManager = {
      async getOrCreatePinned() {
        return {
          session: fixture.session,
          release: () => void wrongSessionReleases++,
        };
      },
    } as unknown as SessionManager;
    const wrongSessionPort = new SqliteAgentGraphExactRunPort({
      runtimeEventStore: fixture.store,
      sessionManager: wrongSessionManager,
      execute: async () => void executeCalls++,
    });
    await assert.rejects(
      wrongSessionPort.startExactRun({
        ...exactRun(fixture, "wrong-session"),
        sessionId: "another-session",
      }),
      /resolved to another Session authority/u,
    );
    assert.equal(wrongSessionReleases, 1);

    const wrongStorePort = new SqliteAgentGraphExactRunPort({
      runtimeEventStore: foreignStore,
      sessionManager: managerReturning(fixture.session),
      execute: async () => void executeCalls++,
    });
    await assert.rejects(
      wrongStorePort.startExactRun(exactRun(fixture, "wrong-store")),
      /resolved to another Session authority/u,
    );
    assert.equal(executeCalls, 0);
  } finally {
    foreignStore.close();
    await rm(foreignRoot, { recursive: true, force: true });
    await fixture.close();
  }
});

test("Graph exact Run rejects corrupt ledgers repeatedly without dispatch", async () => {
  const fixture = await createFixture();
  const run = exactRun(fixture, "corrupt-ledger");
  const start = exactStartEvent(run);
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly events: readonly RuntimeEvent[];
    readonly error: RegExp;
  }> = [
    {
      name: "missing start",
      events: [inputEvent(run, "user")],
      error: /exactly one run\.started fact/u,
    },
    {
      name: "duplicate starts",
      events: [start, { ...start, eventId: "duplicate-run-started" }],
      error: /exactly one run\.started fact/u,
    },
    {
      name: "mismatched exact start",
      events: [{ ...start, turnId: "another-turn" }],
      error: /does not match its preallocated Claim identity/u,
    },
    {
      name: "conflicting event identity",
      events: [start, { ...inputEvent(run, "user"), invocationId: "another-invocation" }],
      error: /conflicting event identity/u,
    },
    {
      name: "conflicting terminals",
      events: [
        start,
        terminalEvent(run, "terminal-one", "failed"),
        terminalEvent(run, "terminal-two", "cancelled"),
      ],
      error: /conflicting terminal facts/u,
    },
    {
      name: "poisoned deterministic input",
      events: [start, inputEvent(run, "assistant")],
      error: /bound to an incompatible Runtime fact/u,
    },
  ];
  try {
    for (const scenario of scenarios) {
      let executeCalls = 0;
      const runtimeEventStore = {
        storageRoot: fixture.store.storageRoot,
        readRun: async () => scenario.events,
      } as unknown as SqliteRuntimeEventStore;
      const port = new SqliteAgentGraphExactRunPort({
        runtimeEventStore,
        sessionManager: managerReturning(fixture.session),
        execute: async () => void executeCalls++,
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          port.startExactRun(run),
          scenario.error,
          `${scenario.name} must reject on attempt ${attempt + 1}`,
        );
      }
      assert.equal(executeCalls, 0, `${scenario.name} must not dispatch`);
    }
  } finally {
    await fixture.close();
  }
});

interface Fixture {
  readonly workDir: string;
  readonly session: Session;
  readonly store: SqliteRuntimeEventStore;
  createPort(
    execute: CreateAgentGraphExactRunPortOptions["execute"],
    requestStop?: CreateAgentGraphExactRunPortOptions["requestStop"],
  ): SqliteAgentGraphExactRunPort;
  close(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-exact-run-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const manager = new SessionManager({
    createSession: (id, targetWorkDir, options) =>
      new Session(id, targetWorkDir, {
        ...options,
        persistence: true,
        picoHome,
        runtimePort,
      }),
  });
  const owner = await manager.getOrCreatePinned(EXACT_RUN.sessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const store = owner.session.runtimeEventStore!;
  return {
    workDir,
    session: owner.session,
    store,
    createPort: (execute, requestStop) =>
      new SqliteAgentGraphExactRunPort({
        runtimeEventStore: store,
        sessionManager: manager,
        sessionOptions: { persistence: true, picoHome, runtimePort },
        execute,
        ...(requestStop ? { requestStop } : {}),
      }),
    async close() {
      owner.release();
      await manager.clearAndDrain();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function exactRun(fixture: Fixture, suffix: string): StartExactAgentGraphRunInput {
  return {
    claimId: `claim-${suffix}`,
    sessionId: EXACT_RUN.sessionId,
    turnId: `turn-${suffix}`,
    runId: `run-${suffix}`,
    invocationId: `invocation-${suffix}`,
    runStartedEventId: `run-started-${suffix}`,
    workDir: fixture.workDir,
    prompt: `execute ${suffix}`,
  };
}

function managerReturning(session: Session): SessionManager {
  return {
    async getOrCreatePinned() {
      return { session, release() {} };
    },
  } as unknown as SessionManager;
}

function startRuntimeRun(
  fixture: Fixture,
  input: StartExactAgentGraphRunInput,
): Promise<RuntimeRun> {
  return RuntimeRun.start({
    capability: fixture.session.runtimeEventCapability!,
    runId: input.runId,
    turnId: input.turnId,
    invocationId: input.invocationId,
    runStartedEventId: input.runStartedEventId,
  });
}

function exactEventBase(input: StartExactAgentGraphRunInput) {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    invocationId: input.invocationId,
    runId: input.runId,
    turnId: input.turnId,
    at: "2026-01-01T00:00:00.000Z",
    partial: false as const,
    visibility: "internal" as const,
  };
}

function exactStartEvent(
  input: StartExactAgentGraphRunInput,
): Extract<RuntimeEvent, { kind: "run.started" }> {
  return {
    ...exactEventBase(input),
    eventId: input.runStartedEventId,
    kind: "run.started",
    data: { workDir: input.workDir },
  };
}

function inputEvent(
  input: StartExactAgentGraphRunInput,
  role: "assistant" | "user",
): Extract<RuntimeEvent, { kind: "message.committed" }> {
  return {
    ...exactEventBase(input),
    eventId: agentGraphInputRuntimeEventId(input.claimId),
    visibility: "model",
    kind: "message.committed",
    data: { message: { role, content: input.prompt } },
  };
}

function terminalEvent(
  input: StartExactAgentGraphRunInput,
  eventId: string,
  status: Extract<RuntimeEvent, { kind: "run.terminal" }>["data"]["status"],
): Extract<RuntimeEvent, { kind: "run.terminal" }> {
  return {
    ...exactEventBase(input),
    eventId,
    kind: "run.terminal",
    data: { status },
  };
}

async function executePrestarted(
  input: ExecuteAgentGraphExactRunInput,
  onProviderDispatch: () => void,
): Promise<void> {
  const runtimeState = {
    dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
  } as unknown as SessionRuntime;
  const engine = {
    run: async (target: Session) => {
      const run = currentRuntimeRun()!;
      await run.recordModelCallStarted({ providerCallId: "provider-call-1", purpose: "main" });
      onProviderDispatch();
      await run.recordModelCallSettled({
        providerCallId: "provider-call-1",
        status: "succeeded",
        latencyMs: 1,
      });
      await target.commitMessages({ role: "assistant", content: "done" });
      return target.getHistory();
    },
  } as unknown as AgentEngine;
  await new RuntimeRunExecutor({
    session: input.session,
    runtimeState,
    engine,
    sessionSelection: { mode: "resume", sessionId: input.session.id },
    workDir: input.session.workDir,
    picoHome: input.session.picoHome,
    prompt: input.prompt,
    resumeExistingSession: false,
    prestartedRun: input.prestartedRun,
    prestartedUserInput: input.prestartedUserInput,
    traceEnabled: false,
    options: {},
  }).execute();
}
