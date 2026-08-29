import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentOutputRecordIdFor, graphIdFor } from "../../src/agent-graph/core/index.js";
import { formatEvidenceUri } from "../../src/context/evidence-archive.js";
import { wakeIdFor } from "../../src/agent-graph/core/ids.js";
import { Session } from "../../src/engine/session.js";
import { SessionManager } from "../../src/engine/session-manager.js";
import {
  assertAgentGraphRootRunSettled,
  createAgentGraphWorkspaceHost,
  type AgentGraphRunToolBinding,
  type CreateAgentGraphWorkspaceHostOptions,
} from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { formatAgentGraphArtifactRef } from "../../src/runtime/agent-graph-resource-authority.js";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../src/storage/runtime-event.js";
import {
  agentOutputFingerprint,
  agentOutputIdempotencyKey,
  type CommitAgentOutputInput,
  type GraphOperatorActivationContext,
} from "../../src/tools/agent-output-tool.js";
import { SqliteSessionWorkbarRepository } from "../../src/storage/sqlite/sqlite-session-workbar-repository.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { withWorkspaceSqliteLease } from "../../src/storage/sqlite/workspace-scopes.js";
import { seedRuntimeToolExchange } from "./helpers/legacy-evidence-fixture.js";

test("workspace Graph host exposes one root binding and owns application lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-host-"));
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
  const owner = await manager.getOrCreatePinned("root-session", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const host = createAgentGraphWorkspaceHost({
    workDir,
    storageRoot: owner.session.runtimeEventStore!.storageRoot,
    runtimeEventStore: owner.session.runtimeEventStore!,
    sessionManager: manager,
    sessionOptions: { persistence: true, picoHome, runtimePort },
    execute: async () => undefined,
  });
  try {
    await host.start();
    const graph = host.openRootEpoch("root-session");
    const binding = host.rootBinding({
      graphId: graph.graphId,
      epoch: graph.epoch,
      rootSessionId: "root-session",
      rootTurnId: "root-turn",
      rootRunId: "root-run",
    });
    assert.equal(binding.kind, "root");
    if (binding.kind !== "root") return;
    assert.deepEqual(binding.getRootContext(), {
      kind: "graph_root_supervisor",
      graphId: graph.graphId,
      epoch: 1,
      rootSessionId: "root-session",
      rootTurnId: "root-turn",
      rootRunId: "root-run",
    });
    const projection = await binding.toolPort.readProjection({
      graphId: graph.graphId,
      epoch: 1,
      rootSessionId: "root-session",
    });
    assert.equal(projection.graph.headRevision, 0);
    assert.equal(host.store.listGraphs("root-session").length, 1);
  } finally {
    await host.close();
    owner.release();
    await manager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  }
});

test("Graph root Run can settle only after finish or a durable yield", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-settlement-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot: root });
  try {
    const graph = store.openRootEpoch("root-session").record;
    const input = {
      graphId: graph.graphId,
      rootSessionId: "root-session",
      rootRunId: "root-run",
    };
    assert.throws(() => assertAgentGraphRootRunSettled(store, input), /cannot complete/u);
    store.registerYieldInterest({
      permitId: "permit-1",
      graphId: graph.graphId,
      rootSessionId: "root-session",
      rootTurnId: "root-turn",
      rootRunId: "root-run",
      toolCallId: "yield-call-1",
    });
    assert.doesNotThrow(() => assertAgentGraphRootRunSettled(store, input));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace Graph host executes an exact operator with owner-fenced output and observes terminal replay", async () => {
  const executions: Parameters<CreateAgentGraphWorkspaceHostOptions["execute"]>[0][] = [];
  let postTerminalBinding: AgentGraphRunToolBinding | undefined;
  let retainedArtifact:
    | { readonly storageRoot: string; readonly sessionId: string; readonly artifactId: string }
    | undefined;
  const fixture = await createHostFixture(async (input) => {
    executions.push(input);
    assert.equal(input.binding.kind, "operator");
    if (input.binding.kind !== "operator") return;
    postTerminalBinding = input.binding;
    const activation = input.binding.getActivationContext();
    assert.ok(activation);
    assert.equal(input.orchestrationMode, "default");
    assert.equal(input.requestedModel, "test/operator-model");
    assert.deepEqual(input.allowedTools, ["read_file", "glob", "grep", "repo_map", "agent_output"]);

    const runtimeRun = await attachHostedRuntimeRun(input);
    const storageRoot = input.session.runtimeEventStore!.storageRoot;
    const artifacts = new SqliteSessionWorkbarRepository({ storageRoot });
    const begun = artifacts.beginArtifact({
      sessionId: input.session.id,
      title: "operator report",
      mimeType: "text/plain",
      expectedRevision: 0,
      idempotencyKey: "begin-operator-report",
    });
    artifacts.appendArtifactChunk({
      sessionId: input.session.id,
      ingestId: begun.ingestId,
      offsetBytes: 0,
      content: Buffer.from("durable artifact", "utf8"),
    });
    const committedArtifact = artifacts.commitArtifact({
      sessionId: input.session.id,
      ingestId: begun.ingestId,
      expectedRevision: 0,
      idempotencyKey: "commit-operator-report",
    }).artifact;
    retainedArtifact = {
      storageRoot,
      sessionId: input.session.id,
      artifactId: committedArtifact.artifactId,
    };
    const artifactRef = formatAgentGraphArtifactRef({
      sessionId: input.session.id,
      artifactId: committedArtifact.artifactId,
      digest: committedArtifact.digest,
    });
    const evidenceRef = await seedRuntimeToolExchange({
      evidenceRoot: join(storageRoot, "evidence"),
      storageRoot,
      sessionId: input.session.id,
      toolCallId: "operator-source-tool",
      toolName: "read_file",
      rawArguments: "{}",
      rawOutput: "durable evidence",
      isError: false,
    });
    const committed = await input.binding.outputPort.commitAgentOutput(
      agentOutputInput(activation, "operator result", {
        evidenceRefs: [formatEvidenceUri(evidenceRef)],
        artifactRefs: [artifactRef],
      }),
    );
    assert.equal(committed.replayed, false);
    assert.ok(committed.recordId);
    await runtimeRun.finish("completed");
    input.onTerminal();
    input.onTerminal();
  });
  try {
    const graphId = graphIdFor(fixture.owner.session.id, 1);
    await scheduleOperator(fixture, graphId, "intent-operator");

    const projection = await fixture.host.application.toolPort.readProjection({
      graphId,
      epoch: 1,
      rootSessionId: fixture.owner.session.id,
    });
    assert.equal(executions.length, 1);
    assert.equal(projection.claims[0]?.state, "executing");
    assert.equal(projection.records.length, 1);
    assert.deepEqual(
      projection.results.records[0]?.resources.map(({ kind, bytes }) => ({ kind, bytes })),
      [
        { kind: "evidence", bytes: Buffer.byteLength("durable evidence", "utf8") },
        { kind: "artifact", bytes: Buffer.byteLength("durable artifact", "utf8") },
      ],
    );
    const reopened = new SqliteAgentGraphControlStore({
      storageRoot: fixture.owner.session.runtimeEventStore!.storageRoot,
    });
    try {
      assert.deepEqual(
        reopened.listResourceRefsByClaim(projection.claims[0]!.claimId).map(({ kind }) => kind),
        ["evidence", "artifact"],
      );
    } finally {
      reopened.close();
    }
    assert.equal(projection.records[0]?.sourceRunId, executions[0]?.prestartedRun.runId);

    assert.ok(postTerminalBinding?.kind === "operator");
    if (postTerminalBinding?.kind === "operator") {
      const activation = postTerminalBinding.getActivationContext();
      assert.ok(activation);
      await assert.rejects(
        postTerminalBinding.outputPort.commitAgentOutput(
          agentOutputInput(activation, "operator result"),
        ),
        /Session is not live/u,
      );
    }

    await fixture.host.application.supervisor.notifyGraph(graphId);
    assert.equal(executions.length, 1, "terminal exact Run must be observed without redispatch");
    const events = await fixture.owner.session.runtimeEventStore!.readRun(
      executions[0]!.session.id,
      executions[0]!.prestartedRun.runId,
    );
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "agent.output").length, 1);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 1);
    assert.ok(retainedArtifact);
    const artifacts = new SqliteSessionWorkbarRepository({
      storageRoot: retainedArtifact.storageRoot,
    });
    artifacts.deleteArtifact({
      sessionId: retainedArtifact.sessionId,
      artifactId: retainedArtifact.artifactId,
      expectedRevision: 1,
      idempotencyKey: "delete-retained-operator-report",
    });
    withWorkspaceSqliteLease(retainedArtifact.storageRoot, ({ database }) => {
      const resource = database
        .prepare(
          `SELECT content_digest FROM agent_graph_resource_refs
           WHERE kind = 'artifact' AND source_resource_id = ?`,
        )
        .get(retainedArtifact!.artifactId) as { content_digest: string } | undefined;
      assert.ok(resource);
      assert.ok(
        database
          .prepare("SELECT 1 FROM artifact_blobs WHERE digest = ?")
          .get(resource.content_digest),
        "Graph-retained artifact blob must survive Session artifact deletion",
      );
    });
  } finally {
    await fixture.close();
  }
});

test("workspace Graph host executes one exact root wake and observes its terminal replay", async () => {
  const executions: Parameters<CreateAgentGraphWorkspaceHostOptions["execute"]>[0][] = [];
  const fixture = await createHostFixture(async (input) => {
    executions.push(input);
    assert.equal(input.binding.kind, "root");
    if (input.binding.kind !== "root") return;
    assert.equal(input.orchestrationMode, "graph");
    assert.equal(input.requestedModel, undefined);
    assert.deepEqual(input.allowedTools, [
      "view_agent_graph",
      "update_agent_graph",
      "yield_agent_graph",
    ]);
    const context = input.binding.getRootContext();
    assert.ok(context);
    assert.equal(context.graphId, "graph-root-wake");
    assert.equal(context.rootSessionId, fixture.owner.session.id);
    assert.equal(context.rootTurnId, input.prestartedRun.turnId);
    assert.equal(context.rootRunId, input.prestartedRun.runId);

    const runtimeRun = await attachHostedRuntimeRun(input);
    await runtimeRun.finish("completed");
    input.onTerminal();
  });
  try {
    fixture.host.store.createGraph({
      graphId: "graph-root-wake",
      rootSessionId: fixture.owner.session.id,
      epoch: 1,
    });
    fixture.host.store.enqueueSupervisorWake({
      wakeId: "wake-root-execute",
      graphId: "graph-root-wake",
      dedupeKey: "record:operator-completed",
      wakeFingerprint: "sha256:root-wake",
      cause: "runtime_terminal",
      payload: { recordId: "record-1" },
    });

    await fixture.host.application.supervisor.scanRecoverableWakes();
    assert.equal(executions.length, 1);
    assert.equal(fixture.host.store.getSupervisorWake("wake-root-execute")?.status, "delivered");
    await fixture.host.application.supervisor.scanRecoverableWakes();
    assert.equal(executions.length, 1, "delivered root wake must not redispatch");
    const events = await fixture.owner.session.runtimeEventStore!.readRun(
      fixture.owner.session.id,
      executions[0]!.prestartedRun.runId,
    );
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 1);
  } finally {
    await fixture.close();
  }
});

test("workspace Graph host recovers a non-live indeterminate operator on startup without redispatch", async () => {
  const executions: Parameters<CreateAgentGraphWorkspaceHostOptions["execute"]>[0][] = [];
  let failedBinding: AgentGraphRunToolBinding | undefined;
  let operatorExecutions = 0;
  let rootExecutions = 0;
  const execute: CreateAgentGraphWorkspaceHostOptions["execute"] = async (input) => {
    executions.push(input);
    if (input.binding.kind === "root") {
      rootExecutions++;
      const runtimeRun = await attachHostedRuntimeRun(input);
      await runtimeRun.finish("completed");
      input.onTerminal();
      return;
    }
    operatorExecutions++;
    failedBinding = input.binding;
    const turnId = input.prestartedRun.turnId;
    assert.ok(turnId);
    const ownerFence = await input.session.assertRuntimeEventWriteAllowed();
    await input.session.runtimeEventStore!.append(
      {
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        eventId: "provider-dispatch-before-crash",
        sessionId: input.session.id,
        invocationId: input.prestartedRun.invocationId,
        runId: input.prestartedRun.runId,
        turnId,
        at: new Date().toISOString(),
        partial: false,
        visibility: "internal",
        kind: "model.call.started",
        data: {
          providerCallId: "provider-dispatch-before-crash",
          purpose: "main",
        },
      },
      { ownerFence },
    );
    throw new Error("simulated hosted execution crash");
  };
  const fixture = await createHostFixture(execute);
  let recoveredHost: ReturnType<typeof createAgentGraphWorkspaceHost> | undefined;
  try {
    const graphId = graphIdFor(fixture.owner.session.id, 1);
    fixture.host.store.createGraph({
      graphId,
      rootSessionId: fixture.owner.session.id,
      epoch: 1,
    });
    fixture.host.store.registerYieldInterest({
      permitId: "yield-before-indeterminate-crash",
      graphId,
      rootSessionId: fixture.owner.session.id,
      rootTurnId: "root-turn-before-indeterminate-crash",
      rootRunId: "root-run-before-indeterminate-crash",
      toolCallId: "yield-tool-before-indeterminate-crash",
    });
    await scheduleOperator(fixture, graphId, "intent-crash");
    assert.equal(operatorExecutions, 1);
    assert.ok(failedBinding?.kind === "operator");
    if (failedBinding?.kind === "operator") {
      const activation = failedBinding.getActivationContext();
      assert.ok(activation);
      await assert.rejects(
        failedBinding.outputPort.commitAgentOutput(agentOutputInput(activation, "late output")),
        /Session is not live/u,
      );
    }

    await fixture.host.close();
    recoveredHost = createAgentGraphWorkspaceHost({
      workDir: fixture.owner.session.workDir,
      storageRoot: fixture.owner.session.runtimeEventStore!.storageRoot,
      runtimeEventStore: fixture.owner.session.runtimeEventStore!,
      sessionManager: fixture.manager,
      sessionOptions: {
        persistence: true,
        picoHome: fixture.owner.session.picoHome,
        runtimePort: createEngineRuntimePort(),
      },
      execute,
    });
    await recoveredHost.start();
    assert.equal(operatorExecutions, 1, "startup recovery must not redispatch an unsafe Run");
    assert.equal(rootExecutions, 1, "startup recovery must wake the registered root exactly once");
    const events = await fixture.owner.session.runtimeEventStore!.readRun(
      executions[0]!.session.id,
      executions[0]!.prestartedRun.runId,
    );
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "model.call.started").length, 1);
    assert.equal(
      events.some((event) => event.kind === "run.terminal"),
      false,
    );
    const view = await recoveredHost.application.toolPort.readProjection({
      graphId,
      epoch: 1,
      rootSessionId: fixture.owner.session.id,
    });
    assert.equal(view.runtimeClaims[0]?.status, "interrupted");
    const wakeId = wakeIdFor(
      graphId,
      `runtime-terminal:${executions[0]!.prestartedRun.runId}:interrupted`,
    );
    assert.equal(recoveredHost.store.getSupervisorWake(wakeId)?.status, "delivered");
    assert.equal(
      recoveredHost.store.getYieldInterest("yield-before-indeterminate-crash")?.state,
      "consumed",
    );
    await recoveredHost.application.supervisor.notifyGraph(graphId);
    assert.equal(operatorExecutions, 1);
    assert.equal(rootExecutions, 1);
  } finally {
    await recoveredHost?.close();
    await fixture.close();
  }
});

test("workspace runtime idempotently installs a trusted exact Run id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-exact-workspace-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtime = await WorkspaceTaskRuntime.create({ workDir });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = runtime.startExactRun(
      "exact-run-1",
      { description: "Graph root wake", sessionId: "root-session" },
      async () => gate,
    );
    const replay = runtime.startExactRun(
      "exact-run-1",
      { description: "Graph root wake", sessionId: "root-session" },
      async () => {
        throw new Error("replay must not install a second executor");
      },
    );
    assert.equal(first.runId, "exact-run-1");
    assert.equal(replay.version, first.version);
    assert.throws(
      () =>
        runtime.startExactRun(
          "exact-run-1",
          { description: "another request", sessionId: "root-session" },
          async () => undefined,
        ),
      /其他请求/,
    );
    release();
    assert.equal((await runtime.waitForRun("exact-run-1")).status, "succeeded");
  } finally {
    release();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace runtime admits a trusted exact operator beside the foreground root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-foreground-operator-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtime = await WorkspaceTaskRuntime.create({ workDir });
  const foreground = deferred();
  const operator = deferred();
  const foregroundStarted = deferred();
  const operatorStarted = deferred();
  try {
    const rootRun = runtime.startRun({ description: "foreground root" }, async () => {
      foregroundStarted.resolve();
      await foreground.promise;
    });
    const operatorRun = runtime.startExactRun(
      "operator-run-1",
      { description: "Graph operator", sessionId: "operator-session" },
      async () => {
        operatorStarted.resolve();
        await operator.promise;
      },
    );

    await Promise.all([foregroundStarted.promise, operatorStarted.promise]);
    assert.equal(rootRun.status, "running");
    assert.equal(operatorRun.status, "running");
    assert.throws(
      () => runtime.startRun({ description: "another foreground" }, async () => undefined),
      /已有活跃 Run/,
    );

    foreground.resolve();
    operator.resolve();
    assert.equal((await runtime.waitForRun(rootRun.runId)).status, "succeeded");
    assert.equal((await runtime.waitForRun(operatorRun.runId)).status, "succeeded");
  } finally {
    foreground.resolve();
    operator.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace runtime admits concurrent trusted exact Graph Runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-concurrent-exact-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtime = await WorkspaceTaskRuntime.create({ workDir });
  const firstGate = deferred();
  const secondGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  try {
    const first = runtime.startExactRun(
      "operator-run-1",
      { description: "first operator", sessionId: "operator-session-1" },
      async () => {
        firstStarted.resolve();
        await firstGate.promise;
      },
    );
    const second = runtime.startExactRun(
      "root-wake-run-1",
      { description: "root wake", sessionId: "root-session" },
      async () => {
        secondStarted.resolve();
        await secondGate.promise;
      },
    );

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    assert.deepEqual(
      runtime
        .listRuns()
        .filter((run) => run.status === "running")
        .map((run) => run.runId)
        .sort(),
      [first.runId, second.runId].sort(),
    );

    firstGate.resolve();
    secondGate.resolve();
    assert.equal((await runtime.waitForRun(first.runId)).status, "succeeded");
    assert.equal((await runtime.waitForRun(second.runId)).status, "succeeded");
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace runtime reattaches a failed exact Run with monotonic versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-reattach-failed-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  let now = 1_000;
  const runtime = await WorkspaceTaskRuntime.create({ workDir, now: () => ++now });
  const versions: number[] = [];
  const unsubscribe = runtime.subscribe((event) => {
    if (event.run?.runId === "reattach-run-1") versions.push(event.resourceVersion);
  });
  try {
    runtime.startExactRun(
      "reattach-run-1",
      { description: "Graph operator", sessionId: "operator-session" },
      async () => {
        throw new Error("attach failed");
      },
    );
    const failed = await runtime.waitForRun("reattach-run-1");
    assert.equal(failed.status, "failed");
    assert.equal(failed.version, 2);

    const reattached = runtime.reattachExactRun(
      "reattach-run-1",
      { description: "Graph operator", sessionId: "operator-session" },
      async () => ({ recovered: true }),
    );
    assert.equal(reattached.status, "running");
    assert.equal(reattached.version, 3);
    assert.equal(reattached.startedAt, failed.startedAt);
    assert.equal(reattached.finishedAt, undefined);
    assert.equal(reattached.error, undefined);

    const succeeded = await runtime.waitForRun("reattach-run-1");
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.version, 4);
    assert.deepEqual(succeeded.result, { recovered: true });
    assert.deepEqual(versions, [1, 2, 3, 4]);
  } finally {
    unsubscribe();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace runtime serializes concurrent exact reattach and rejects identity conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-reattach-race-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtime = await WorkspaceTaskRuntime.create({ workDir });
  const gate = deferred();
  const started = deferred();
  let installs = 0;
  try {
    runtime.startExactRun(
      "reattach-run-1",
      { description: "Graph operator", sessionId: "operator-session" },
      async () => {
        throw new Error("attach failed");
      },
    );
    await runtime.waitForRun("reattach-run-1");

    const reinstall = () =>
      runtime.reattachExactRun(
        "reattach-run-1",
        { description: "Graph operator", sessionId: "operator-session" },
        async () => {
          installs++;
          started.resolve();
          await gate.promise;
        },
      );
    const first = reinstall();
    const replay = reinstall();
    await started.promise;
    assert.equal(installs, 1);
    assert.equal(replay.version, first.version);
    assert.throws(
      () =>
        runtime.reattachExactRun(
          "reattach-run-1",
          { description: "other request", sessionId: "operator-session" },
          async () => undefined,
        ),
      /其他请求/,
    );

    gate.resolve();
    assert.equal((await runtime.waitForRun("reattach-run-1")).status, "succeeded");
    const succeededReplay = runtime.reattachExactRun(
      "reattach-run-1",
      { description: "Graph operator", sessionId: "operator-session" },
      async () => {
        installs++;
      },
    );
    await Promise.resolve();
    assert.equal(succeededReplay.status, "succeeded");
    assert.equal(installs, 1);
  } finally {
    gate.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createHostFixture(
  execute: CreateAgentGraphWorkspaceHostOptions["execute"],
): Promise<{
  readonly host: ReturnType<typeof createAgentGraphWorkspaceHost>;
  readonly owner: Awaited<ReturnType<SessionManager["getOrCreatePinned"]>>;
  readonly manager: SessionManager;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-host-execute-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
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
  const owner = await manager.getOrCreatePinned("root-session", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  const host = createAgentGraphWorkspaceHost({
    workDir,
    storageRoot: owner.session.runtimeEventStore!.storageRoot,
    runtimeEventStore: owner.session.runtimeEventStore!,
    sessionManager: manager,
    sessionOptions: { persistence: true, picoHome, runtimePort },
    execute,
  });
  await host.start();
  return {
    host,
    owner,
    manager,
    close: async () => {
      await host.close();
      owner.release();
      await manager.clearAndDrain();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function scheduleOperator(
  fixture: Awaited<ReturnType<typeof createHostFixture>>,
  graphId: string,
  intentId: string,
): Promise<void> {
  const graph = fixture.host.openRootEpoch(fixture.owner.session.id);
  assert.equal(graph.graphId, graphId);
  assert.equal(graph.epoch, 1);
  await fixture.host.application.toolPort.commitUpdate({
    graphId,
    epoch: 1,
    expectedRevision: 0,
    operationId: `add:${intentId}`,
    rootModelRouteId: "test/operator-model",
    source: {
      sessionId: fixture.owner.session.id,
      turnId: "root-turn-1",
      runId: "root-run-1",
      toolCallId: `tool:${intentId}`,
    },
    commands: [
      {
        kind: "add",
        operator: {
          graphId,
          operatorId: "researcher",
          generation: 1,
          role: "researcher",
          profileId: "explore",
          workspacePolicy: { kind: "shared" },
        },
        intent: {
          graphId,
          intentId,
          operatorId: "researcher",
          operatorGeneration: 1,
          instruction: "research the requested topic",
          expectedOutputRecordId: agentOutputRecordIdFor(graphId, intentId),
          inputRefs: [],
          createdAtRevision: 1,
          requestedBy: {
            sessionId: fixture.owner.session.id,
            turnId: "root-turn-1",
            runId: "root-run-1",
            toolCallId: `tool:${intentId}`,
          },
        },
      },
    ],
  });
  await fixture.host.application.supervisor.notifyGraph(graphId);
}

async function attachHostedRuntimeRun(
  input: Parameters<CreateAgentGraphWorkspaceHostOptions["execute"]>[0],
): Promise<RuntimeRun> {
  return RuntimeRun.start({
    capability: input.session.runtimeEventCapability!,
    ...(input.prestartedRun.presentation === "internal"
      ? {
          presentation: {
            audience: "internal" as const,
            source: "agent_graph_control" as const,
          },
        }
      : {}),
    runId: input.prestartedRun.runId,
    turnId: input.prestartedRun.turnId,
    invocationId: input.prestartedRun.invocationId,
    runStartedEventId: input.prestartedRun.runStartedEventId,
    now: () => new Date(input.prestartedRun.runStartedAt),
  });
}

function agentOutputInput(
  activation: GraphOperatorActivationContext,
  output: string,
  resources: {
    readonly evidenceRefs?: readonly string[];
    readonly artifactRefs?: readonly string[];
  } = {},
): CommitAgentOutputInput {
  const evidenceRefs = resources.evidenceRefs ?? [];
  const artifactRefs = resources.artifactRefs ?? [];
  const idempotencyKey = agentOutputIdempotencyKey(activation);
  const fingerprint = agentOutputFingerprint({
    status: "success",
    output,
    evidenceRefs,
    artifactRefs,
  });
  return {
    activation,
    toolCallId: "tool-call-agent-output",
    idempotencyKey,
    fingerprint,
    eventPayload: {
      schemaVersion: "pico.agent_output.v1",
      graphId: activation.graphId,
      operatorId: activation.operatorId,
      operatorGeneration: activation.operatorGeneration,
      activationId: activation.activationId,
      status: "success",
      output,
      outputBytes: Buffer.byteLength(output, "utf8"),
      evidenceRefs,
      artifactRefs,
      idempotencyKey,
      fingerprint,
    },
  };
}
