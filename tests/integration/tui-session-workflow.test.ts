import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCliStartupSession } from "../../src/cli/session-args.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
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
    databasePath: resolvePicoPaths(workspace, { picoHome }).workspace.runtimeDatabase,
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
