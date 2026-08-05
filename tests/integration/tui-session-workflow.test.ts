import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCliStartupSession } from "../../src/cli/session-args.js";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import { SessionManager } from "../../src/engine/session.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { StorageOperationJournal } from "../../src/storage/operation-journal.js";

test("--session and -S reject a missing session in the current workspace", async (context) => {
  const fixture = await createFixture("strict-resume");
  context.after(() => fixture.dispose());
  const previousPicoHome = process.env.PICO_HOME;
  process.env.PICO_HOME = fixture.picoHome;
  context.after(() => restoreEnvironment("PICO_HOME", previousPicoHome));

  await assert.rejects(
    resolveCliStartupSession(["--dir", fixture.workspace, "--session", "missing"]),
    /无法恢复 session missing/u,
  );
  await assert.rejects(
    resolveCliStartupSession(["--dir", fixture.workspace, "-S", "missing"]),
    /无法恢复 session missing/u,
  );

  assert.equal(await fixture.store.readSessionManifest("missing"), undefined);
});

test("--session and -S resume an existing session in the current workspace", async (context) => {
  const fixture = await createFixture("existing-resume");
  context.after(() => fixture.dispose());
  const previousPicoHome = process.env.PICO_HOME;
  process.env.PICO_HOME = fixture.picoHome;
  context.after(() => restoreEnvironment("PICO_HOME", previousPicoHome));
  await fixture.store.initializeSession({ sessionId: "known", workDir: fixture.workspace });

  for (const flag of ["--session", "-S"] as const) {
    const resolved = await resolveCliStartupSession(["--dir", fixture.workspace, flag, "known"]);
    assert.deepEqual(resolved.sessionSelection, { mode: "resume", sessionId: "known" });
  }
});

test("/new requests an idle atomic switch without creating a session eagerly", async (context) => {
  const fixture = await createFixture("new-command");
  context.after(() => fixture.dispose());
  const registry = await createPicoCommandRegistry({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
    provider: "openai",
    model: "test-model",
    tools: [],
  });

  const processed = await processUserInput("/new", { registry });
  assert.equal(processed.type, "local-command");
  if (processed.type !== "local-command") return;
  assert.deepEqual(processed.result.data, { mode: "new" });
  assert.equal(processed.result.action, "resume");
  assert.deepEqual(await fixture.store.listSessionManifests(), []);
});

test("/plan and legacy mode commands keep collaboration and permission independent", async (context) => {
  const fixture = await createFixture("plan-command-compatibility");
  context.after(() => fixture.dispose());
  const registry = await createPicoCommandRegistry({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
    provider: "openai",
    model: "test-model",
    tools: [],
  });

  const plan = await processUserInput("/plan", { registry });
  assert.equal(plan.type, "local-command");
  if (plan.type !== "local-command") return;
  assert.deepEqual(plan.result.data, {
    ok: true,
    collaborationMode: "plan",
    permissionMode: "yolo",
  });

  const permission = await processUserInput("/mode auto", { registry });
  assert.equal(permission.type, "local-command");
  if (permission.type !== "local-command") return;
  assert.equal((permission.result.data as { collaborationMode: string }).collaborationMode, "plan");
  assert.equal((permission.result.data as { permissionMode: string }).permissionMode, "auto");

  const compatibility = await processUserInput("/permissions plan", { registry });
  assert.equal(compatibility.type, "local-command");
  if (compatibility.type !== "local-command") return;
  assert.equal(
    (compatibility.result.data as { collaborationMode: string }).collaborationMode,
    "plan",
  );
  assert.equal((compatibility.result.data as { permissionMode: string }).permissionMode, "auto");

  const off = await processUserInput("/plan off", { registry });
  assert.equal(off.type, "local-command");
  if (off.type !== "local-command") return;
  assert.equal((off.result.data as { collaborationMode: string }).collaborationMode, "agent");
  assert.equal((off.result.data as { permissionMode: string }).permissionMode, "auto");
});

test("/explore starts a durable read-only Discovery prompt and supports status and cancel", async (context) => {
  const fixture = await createFixture("explore-command");
  const sessionId = "explore-command-session";
  const manager = new SessionManager();
  const session = await manager.getOrCreate(sessionId, fixture.workspace, {
    persistence: true,
    picoHome: fixture.picoHome,
  });
  context.after(async () => {
    await manager.delete(sessionId, fixture.workspace, { picoHome: fixture.picoHome })?.close();
    await fixture.dispose();
  });
  const registry = await createPicoCommandRegistry({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
    provider: "openai",
    model: "test-model",
    modelRouteId: "test/test-model",
    session,
    sessionId,
    tools: [],
  });

  const started = await processUserInput("/explore deep 定位权限检查入口", { registry });
  assert.equal(started.type, "prompt-command");
  if (started.type !== "prompt-command") return;
  assert.match(started.result.prompt, /Forage.*Focus.*Deepen.*Verify/u);
  assert.ok(started.result.execution?.allowedTools?.includes("repo_map"));
  assert.ok(started.result.execution?.allowedTools?.includes("code_definition"));
  assert.equal(started.result.execution?.allowedTools?.includes("write_file"), false);
  assert.equal(started.result.execution?.discoveryRun, true);
  const coordinator = new DiscoveryCoordinator(session.runtimeEventStore!, {
    sessionId,
    invocationId: "test-explore-command",
    runId: "test-explore-command",
    turnId: "test-explore-command",
  });
  assert.equal((await coordinator.project()).active?.depth, "deep");

  const status = await processUserInput("/explore status", { registry });
  assert.equal(status.type, "local-command");
  if (status.type !== "local-command") return;
  assert.match(status.result.message ?? "", /Discovery active.*deep/u);

  const cancelled = await processUserInput("/explore cancel 用户取消", { registry });
  assert.equal(cancelled.type, "local-command");
  assert.equal((await coordinator.project()).latest?.status, "cancelled");
});

test("/resume and /fork reject an unpublished fork target", async (context) => {
  const fixture = await createFixture("unpublished-fork-command");
  context.after(() => fixture.dispose());
  await fixture.store.initializeSession({
    sessionId: "unfinished-fork",
    workDir: fixture.workspace,
  });
  await new StorageOperationJournal({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).create({
    kind: "fork",
    operationId: "unfinished-fork-operation",
    sessionId: "source",
    sourceSessionId: "source",
    sourceCursor: { logId: "source", seq: 1, epoch: 0, eventId: "source-event" },
    targetSessionId: "unfinished-fork",
    targetMode: "default",
    stagingDirectory: join(fixture.root, "staging", "unfinished-fork"),
  });
  const registry = await createPicoCommandRegistry({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
    provider: "openai",
    model: "test-model",
    tools: [],
  });

  for (const command of ["/resume unfinished-fork", "/fork unfinished-fork"]) {
    const processed = await processUserInput(command, { registry });
    assert.equal(processed.type, "local-command");
    if (processed.type !== "local-command") continue;
    assert.equal(processed.result.action, "message");
    assert.match(processed.result.message ?? "", /no saved session was found/u);
  }
});

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
  readonly store: RuntimeEventStore;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workspace, { picoHome }).workspace.root,
  });
  return {
    root,
    workspace,
    picoHome,
    store,
    async dispose() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
