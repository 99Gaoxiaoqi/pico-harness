import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeNotification,
  createRuntimeRequest,
  RuntimeProtocolError,
  RUNTIME_ERROR_CODES,
} from "../../../packages/protocol/src/index.js";

import { DesktopRuntimeService, WorkspaceRuntimeService } from "../../../src/daemon/index.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { SqliteAgentGraphControlStore } from "../../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { createAgentGraphApplicationService } from "../../../src/agent-graph/service.js";
import type { AgentGraphApplicationService } from "../../../src/agent-graph/service.js";
import {
  agentOutputRecordIdFor,
  intentIdFor,
  operatorIdFor,
} from "../../../src/agent-graph/core/index.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../../src/agent-graph/operator-profile-catalog.js";
import { AgentGraphReconciler } from "../../../src/agent-graph/reconciler.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../../src/agent-graph/sqlite-control-store-adapter.js";

test("desktop rejects orchestration and permission switches while the root epoch is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-mode-guard-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  let graphStore: SqliteAgentGraphControlStore | undefined;
  try {
    const created = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    const sessionId = created.session.sessionId;
    await desktop.handle(
      createRuntimeRequest("session.settings.update", {
        workspacePath: canonical,
        sessionId,
        orchestrationMode: "graph",
        permissionMode: "ask",
      }),
    );
    graphStore = new SqliteAgentGraphControlStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
    });
    graphStore.openRootEpoch(sessionId);

    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: canonical,
          sessionId,
          orchestrationMode: "default",
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: canonical,
          sessionId,
          permissionMode: "full-access",
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
    );
  } finally {
    graphStore?.close();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("finished Graph reconciliation retires operator authority before permission switches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-permission-guard-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  const graphStore = new SqliteAgentGraphControlStore({
    storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
  });
  try {
    const createSession = async () =>
      (await desktop.handle(
        createRuntimeRequest("session.create", { workspacePath: canonical }),
      )) as { session: { sessionId: string } };
    const rootSessionId = (await createSession()).session.sessionId;
    const childSessionId = (await createSession()).session.sessionId;
    for (const sessionId of [rootSessionId, childSessionId]) {
      await desktop.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: canonical,
          sessionId,
          permissionMode: "ask",
        }),
      );
    }

    const graphId = "graph-permission-guard";
    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn",
      runId: "root-run",
      toolCallId: "root-tool",
    };
    graphStore.createGraph({ graphId, rootSessionId, epoch: 1 });
    const control = new SqliteAgentGraphControlStoreAdapter(graphStore);
    const operatorId = operatorIdFor(graphId, "permission-guard");
    const intentId = intentIdFor(graphId, "permission-guard", 0);
    const profileSnapshot = createBuiltinAgentGraphOperatorProfileCatalog().resolve({
      profileId: "explore",
      rootModelRouteId: "test/model",
    });
    control.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 0,
      operationId: "graph-permission-guard-add",
      source,
      commands: [
        {
          kind: "add",
          operator: {
            graphId,
            operatorId,
            generation: 1,
            role: "permission-guard",
            profileSnapshot,
            workspacePolicy: { kind: "shared" },
          },
          intent: {
            graphId,
            intentId,
            operatorId,
            operatorGeneration: 1,
            instruction: "Keep the permission epoch stable",
            expectedOutputRecordId: agentOutputRecordIdFor(graphId, intentId),
            inputRefs: [],
            createdAtRevision: 1,
            requestedBy: source,
          },
        },
      ],
    });
    const provision = graphStore.ensureOperatorProvision({
      provisionId: "graph-permission-guard-provision",
      graphId,
      operatorId,
      generation: 1,
      scheduleRevision: 1,
      provisionFingerprint: "graph-permission-guard-provision-fingerprint",
      childSessionId,
      profileSnapshot,
      workspaceBinding: { kind: "shared" },
    }).record;
    graphStore.transitionOperatorProvision({
      provisionId: provision.provisionId,
      expectedVersion: provision.version,
      from: "requested",
      to: "provisioned",
    });
    control.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 1,
      operationId: "graph-permission-guard-finish",
      source: { ...source, toolCallId: "root-tool-finish" },
      commands: [{ kind: "finish" }],
    });

    const switchPermission = (sessionId: string) =>
      desktop.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: canonical,
          sessionId,
          permissionMode: "full-access",
        }),
      );
    for (const sessionId of [rootSessionId, childSessionId]) {
      await assert.rejects(
        switchPermission(sessionId),
        (error: unknown) =>
          error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
      );
    }

    const unreachable = async (): Promise<never> => {
      throw new Error("finished Graph must only retire existing authority");
    };
    const reconciled = await new AgentGraphReconciler({
      store: control,
      runtime: {
        resolveInputFacts: unreachable,
        ensureOperator: unreachable,
        startOrObserveActivation: unreachable,
        observeActivation: unreachable,
        stopActivation: unreachable,
      },
    }).reconcile(graphId);
    assert.equal(reconciled.quiescent, true);
    assert.deepEqual(reconciled.errors, []);
    assert.equal(graphStore.listOperatorProvisions(graphId)[0]?.state, "stopped");

    for (const sessionId of [rootSessionId, childSessionId]) {
      const updated = (await switchPermission(sessionId)) as {
        settings: { permissionMode: string };
      };
      assert.equal(updated.settings.permissionMode, "full-access");
    }
  } finally {
    graphStore.close();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop session index excludes durable Graph operator Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-session-index-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
  });
  const graphStore = new SqliteAgentGraphControlStore({
    storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
  });
  let reloadedDesktop: DesktopRuntimeService | undefined;
  try {
    const created = [] as string[];
    for (let index = 0; index < 2; index++) {
      const result = (await desktop.handle(
        createRuntimeRequest("session.create", { workspacePath: canonical }),
      )) as { session: { sessionId: string } };
      created.push(result.session.sessionId);
    }
    const rootSessionId = created[0]!;
    const childSessionId = created[1]!;
    graphStore.createGraph({ graphId: "graph-session-index", rootSessionId, epoch: 1 });
    graphStore.commitScheduleRevision({
      graphId: "graph-session-index",
      expectedRevision: 0,
      operationId: "graph-session-index-add",
      requestFingerprint: "graph-session-index-add-fingerprint",
      kind: "add",
      command: { kind: "add" },
      sourceSessionId: rootSessionId,
      sourceTurnId: "root-turn",
      sourceRunId: "root-run",
      sourceToolCallId: "root-tool",
    });
    graphStore.ensureOperatorProvision({
      provisionId: "graph-session-index-provision",
      graphId: "graph-session-index",
      operatorId: "operator",
      generation: 1,
      scheduleRevision: 1,
      provisionFingerprint: "graph-session-index-provision-fingerprint",
      childSessionId,
      profileSnapshot: { profileId: "explore" },
      workspaceBinding: { kind: "shared" },
    });

    reloadedDesktop = new DesktopRuntimeService({
      runtimeService: new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) }),
      trustStore,
      env,
    });
    const listed = (await reloadedDesktop.handle(
      createRuntimeRequest("session.list", { workspacePath: canonical, includeArchived: true }),
    )) as { sessions: readonly { sessionId: string }[] };
    assert.deepEqual(
      listed.sessions.map((session) => session.sessionId),
      [rootSessionId],
    );
  } finally {
    graphStore.close();
    await reloadedDesktop?.close();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop workspace unregister closes and evicts its cached Graph store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-store-unregister-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  const graphStores = (
    desktop as unknown as {
      readonly agentGraphStores: Map<string, SqliteAgentGraphControlStore>;
    }
  ).agentGraphStores;
  try {
    await desktop.handle(createRuntimeRequest("workspace.register", { workspacePath: canonical }));
    await desktop.handle(
      createRuntimeRequest("session.list", { workspacePath: canonical, includeArchived: true }),
    );
    const cached = graphStores.get(canonical);
    assert.ok(cached);
    let closes = 0;
    const close = cached.close.bind(cached);
    cached.close = () => {
      closes += 1;
      close();
    };

    await desktop.handle(
      createRuntimeRequest("workspace.unregister", { workspacePath: canonical }),
    );
    assert.equal(closes, 1);
    assert.equal(graphStores.has(canonical), false);

    await desktop.handle(createRuntimeRequest("workspace.register", { workspacePath: canonical }));
    await desktop.handle(
      createRuntimeRequest("session.list", { workspacePath: canonical, includeArchived: true }),
    );
    assert.notStrictEqual(graphStores.get(canonical), cached);
  } finally {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop advances completed Graph transcripts without persisting internal run boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-run-boundary-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  let linearSessionId = "";
  let linearAdvances = 0;
  let graphSessionId = "";
  let graphAdvances = 0;
  let resolvePersisted!: () => void;
  const persisted = new Promise<void>((resolve) => {
    resolvePersisted = resolve;
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    onTranscriptAdvanced: (_workspacePath, sessionId) => {
      if (sessionId === linearSessionId && ++linearAdvances === 2) resolvePersisted();
      if (sessionId === graphSessionId) graphAdvances++;
    },
  });
  let closed = false;
  try {
    const graphSession = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    graphSessionId = graphSession.session.sessionId;
    const linearSession = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    linearSessionId = linearSession.session.sessionId;
    await desktop.handle(
      createRuntimeRequest("session.settings.update", {
        workspacePath: canonical,
        sessionId: graphSession.session.sessionId,
        orchestrationMode: "graph",
      }),
    );

    for (const [sessionId, runId] of [
      [graphSession.session.sessionId, "graph-root-run"],
      [linearSessionId, "linear-run"],
    ] as const) {
      runtime.publishDesktopNotification(
        runBoundaryNotification(canonical, sessionId, runId, "run.started", "running", 1),
      );
      runtime.publishDesktopNotification(
        runBoundaryNotification(canonical, sessionId, runId, "run.finished", "succeeded", 2),
      );
    }
    await persisted;
    await desktop.close();
    closed = true;
    assert.equal(
      graphAdvances,
      1,
      "Graph completion must notify the current durable transcript watermark",
    );

    const reloaded = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
    });
    try {
      const graphPage = await reloaded.readTranscriptProjectionPage({
        sessionId: graphSession.session.sessionId,
        maxBytes: 64 * 1024,
      });
      assert.equal(JSON.stringify(graphPage.items).includes("graph-root-run"), false);

      const linearPage = await reloaded.readTranscriptProjectionPage({
        sessionId: linearSessionId,
        maxBytes: 64 * 1024,
      });
      const linearBoundaries = linearPage.items.filter(
        (item) =>
          typeof item.payload === "object" &&
          item.payload !== null &&
          "kind" in item.payload &&
          item.payload.kind === "runBoundary",
      );
      assert.deepEqual(
        linearBoundaries.map((item) =>
          typeof item.payload === "object" && item.payload !== null && "status" in item.payload
            ? item.payload.status
            : undefined,
        ),
        ["running", "succeeded"],
      );
    } finally {
      reloaded.close();
    }
  } finally {
    if (!closed) await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop deletion retires the root Graph before removing its Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-delete-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const graphStore = new SqliteAgentGraphControlStore({
    storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
  });
  const graph = createAgentGraphApplicationService({
    store: graphStore,
    runtime: {} as never,
    rootWakePort: {} as never,
    resolveOperatorWorkspace: () => ({ workDir: canonical }),
  });
  const lifecycle: string[] = [];
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    retireAgentGraphRootSession: async (_workspacePath, sessionId, reason) => {
      lifecycle.push("retire");
      return graph.retireRootSession(sessionId, reason);
    },
  });
  try {
    const created = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    const sessionId = created.session.sessionId;
    const epoch = graph.openRootEpoch(sessionId);
    await desktop.handle(
      createRuntimeRequest("session.delete", { workspacePath: canonical, sessionId }),
    );
    lifecycle.push("deleted");

    assert.deepEqual(lifecycle, ["retire", "deleted"]);
    assert.equal(graphStore.getGraph(epoch.graphId)?.phase, "finished");
  } finally {
    await graph.close();
    graphStore.close();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

function runBoundaryNotification(
  workspacePath: string,
  sessionId: string,
  runId: string,
  topic: "run.started" | "run.finished",
  status: "running" | "succeeded",
  version: number,
) {
  return createRuntimeNotification({
    eventId: `${runId}:${topic}`,
    topic,
    scope: { workspacePath, sessionId, runId },
    resourceVersion: version,
    at: version,
    payload: {
      run: {
        runId,
        sessionId,
        workspacePath,
        description: runId,
        status,
        startedAt: 1,
        updatedAt: version,
        ...(status === "succeeded" ? { finishedAt: version } : {}),
        version,
      },
    },
  });
}

test("desktop Graph wake retry enforces Session and Graph ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-retry-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const retriedWakeIds: string[] = [];
  const graphApplication = {
    retryRootWake: async (wakeId: string) => {
      retriedWakeIds.push(wakeId);
      return true;
    },
    start: async () => undefined,
    close: async () => undefined,
  } as unknown as AgentGraphApplicationService;
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async () => ({ ok: true }),
    createAgentGraphApplicationService: () => graphApplication,
  });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  const graphStore = new SqliteAgentGraphControlStore({
    storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
  });
  try {
    const first = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    const second = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    graphStore.createGraph({
      graphId: "graph-first",
      rootSessionId: first.session.sessionId,
      epoch: 1,
    });
    graphStore.createGraph({
      graphId: "graph-second",
      rootSessionId: second.session.sessionId,
      epoch: 1,
    });
    graphStore.enqueueSupervisorWake({
      wakeId: "wake-first",
      graphId: "graph-first",
      dedupeKey: "runtime-terminal:first",
      wakeFingerprint: "wake-first-fingerprint",
      cause: "runtime_terminal",
      payload: { claimId: "claim-first" },
    });
    graphStore.enqueueSupervisorWake({
      wakeId: "wake-second",
      graphId: "graph-second",
      dedupeKey: "runtime-terminal:second",
      wakeFingerprint: "wake-second-fingerprint",
      cause: "runtime_terminal",
      payload: { claimId: "claim-second" },
    });

    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.graph.retryWake", {
          workspacePath: canonical,
          sessionId: second.session.sessionId,
          graphId: "graph-first",
          wakeId: "wake-first",
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.NOT_FOUND,
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.graph.retryWake", {
          workspacePath: canonical,
          sessionId: first.session.sessionId,
          graphId: "graph-first",
          wakeId: "wake-second",
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.NOT_FOUND,
    );
    assert.deepEqual(
      await desktop.handle(
        createRuntimeRequest("session.graph.retryWake", {
          workspacePath: canonical,
          sessionId: first.session.sessionId,
          graphId: "graph-first",
          wakeId: "wake-first",
        }),
      ),
      { retried: true },
    );
    assert.deepEqual(retriedWakeIds, ["wake-first"]);
  } finally {
    graphStore.close();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop stop replays delivery after Graph finish and rejects another Session's Graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-stop-retry-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const store = new SqliteAgentGraphControlStore({
    storageRoot: resolvePicoPaths(canonical, { picoHome }).workspace.root,
  });
  let deliveries = 0;
  const desktop = new DesktopRuntimeService({
    env,
    trustStore,
    runtimeService: new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) }),
    stopAgentGraph: async (_workspacePath, sessionId, graph) => {
      assert.equal(graph.epoch, 1);
      if (++deliveries === 1) {
        store.commitScheduleRevision({
          graphId: graph.graphId,
          expectedRevision: 0,
          operationId: "finish",
          requestFingerprint: "finish",
          kind: "finish",
          command: { kind: "finish" },
          sourceSessionId: sessionId,
          sourceTurnId: "turn",
          sourceRunId: "run",
          sourceToolCallId: "stop",
        });
        throw new Error("stop delivery failed after finish");
      }
      return true;
    },
  });
  try {
    const create = async () =>
      (await desktop.handle(
        createRuntimeRequest("session.create", { workspacePath: canonical }),
      )) as { session: { sessionId: string } };
    const owner = (await create()).session.sessionId;
    const other = (await create()).session.sessionId;
    const graph = store.openRootEpoch(owner).record;
    const stop = (sessionId: string) =>
      desktop.handle(
        createRuntimeRequest("session.graph.stop", {
          workspacePath: canonical,
          sessionId,
          graphId: graph.graphId,
        }),
      );
    await assert.rejects(stop(other), /不属于当前任务/u);
    assert.equal(deliveries, 0);
    await assert.rejects(stop(owner), /stop delivery failed after finish/u);
    assert.equal(store.getGraph(graph.graphId)?.phase, "finished");
    assert.deepEqual(await stop(owner), { stopped: true });
    assert.equal(deliveries, 2);
  } finally {
    await desktop.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
