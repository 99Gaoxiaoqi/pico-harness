import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCliStartupSession } from "../../src/cli/session-args.js";
import { Session } from "../../src/engine/session.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

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

test("/compact refuses legacy environment credentials without a user model router", async (context) => {
  const fixture = await createFixture("compact-user-model-route");
  context.after(() => fixture.dispose());
  const session = new Session("compact-user-model-route", fixture.workspace, {
    persistence: false,
    picoHome: fixture.picoHome,
  });
  context.after(() => session.close());

  const legacyEnvironment = {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL,
  };
  process.env.LLM_BASE_URL = "https://legacy-provider.invalid/v1";
  process.env.LLM_API_KEY = "legacy-key-must-not-be-used";
  process.env.LLM_MODEL = "legacy-model";
  context.after(() => {
    restoreEnvironment("LLM_BASE_URL", legacyEnvironment.LLM_BASE_URL);
    restoreEnvironment("LLM_API_KEY", legacyEnvironment.LLM_API_KEY);
    restoreEnvironment("LLM_MODEL", legacyEnvironment.LLM_MODEL);
  });

  const registry = await createPicoCommandRegistry({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
    provider: "openai",
    model: "legacy-model",
    modelRouteId: "legacy/legacy-model",
    session,
    tools: [],
  });
  const processed = await processUserInput("/compact", { registry });
  assert.equal(processed.type, "local-command");
  if (processed.type !== "local-command") return;
  assert.match(processed.result.message ?? "", /user model configuration is not available/u);
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
  readonly store: SqliteRuntimeEventStore;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({
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
