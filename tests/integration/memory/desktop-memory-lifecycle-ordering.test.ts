import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createRuntimeRequest,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
} from "../../../packages/protocol/src/index.js";
import {
  DesktopAtomicMemoryService,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../../src/daemon/index.js";
import { memorySessionKey } from "../../../src/memory/atomic/runtime-contracts.js";
import { sessionMemoryLane } from "../../../src/memory/atomic/session-lane.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("session deletion waits for atomic memory work and preserves committed items across restart", async (context) => {
  const fixture = await createFixture("atomic-delete");
  const canonical = await realpath(fixture.workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env: fixture.env, execute: async () => undefined });
  const memory = new DesktopAtomicMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    memoryService: memory,
    env: fixture.env,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pendingWork: Promise<unknown>[] = [];
  context.after(async () => {
    release.resolve();
    await Promise.allSettled(pendingWork);
    await desktop.close();
    memory.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const sessionId = await createSession(desktop, canonical);
  const paths = resolvePicoPaths(canonical, { picoHome: fixture.picoHome });
  let itemId = "";
  const memoryWork = sessionMemoryLane.run(
    fixture.picoHome + ":" + memorySessionKey(paths.workspace.id, sessionId),
    "background",
    async () => {
      entered.resolve();
      await release.promise;
      itemId = (await memory.create(canonical, "项目发布前运行 npm test。")).item.itemId;
    },
  );
  pendingWork.push(memoryWork);
  await entered.promise;
  let deleted = false;
  const deleting = desktop
    .handle(createRuntimeRequest("session.delete", { workspacePath: canonical, sessionId }))
    .then((result) => {
      deleted = true;
      return result;
    });
  pendingWork.push(deleting);
  await delay(30);
  assert.equal(deleted, false, "deletion must wait for the active memory lane");
  const retained = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.get", { workspacePath: canonical, sessionId }),
    ),
  );
  assert.equal(asRecord(retained["session"])["sessionId"], sessionId);
  release.resolve();
  await memoryWork;
  assert.deepEqual(await deleting, { sessionId, deleted: true });
  await assert.rejects(
    desktop.handle(createRuntimeRequest("session.get", { workspacePath: canonical, sessionId })),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.NOT_FOUND,
  );
  memory.close();
  const restarted = new DesktopAtomicMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  try {
    const item = (await restarted.get(canonical, itemId)).item;
    assert.equal(item.content, "项目发布前运行 npm test。");
    assert.equal(item.lifecycleState, "active");
  } finally {
    restarted.close();
  }
});

async function createSession(
  desktop: DesktopRuntimeService,
  workspacePath: string,
): Promise<string> {
  const created = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath, title: "Memory" }),
    ),
  );
  const sessionId = asRecord(created["session"])["sessionId"];
  assert.equal(typeof sessionId, "string");
  return sessionId as string;
}

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly picoHome: string;
  readonly workspace: string;
  readonly env: Readonly<Record<string, string>>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-lifecycle-${name}-`));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(picoHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeDesktopModelRouting(picoHome);
  return {
    root,
    picoHome,
    workspace,
    env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
