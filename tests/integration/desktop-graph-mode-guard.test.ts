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

test("desktop rejects Graph to linear mode switch while the root epoch is open", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-graph-mode-guard-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(picoHome, { recursive: true }),
  ]);
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
