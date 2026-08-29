import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRuntimeRequest,
  DesktopRuntimeService,
  RuntimeProtocolError,
  RUNTIME_ERROR_CODES,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { createAgentGraphApplicationService } from "../../src/agent-graph/service.js";
import type { AgentGraphApplicationService } from "../../src/agent-graph/service.js";

test("desktop rejects Graph to linear mode switch while the root epoch is open", async () => {
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
  } finally {
    graphStore?.close();
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
