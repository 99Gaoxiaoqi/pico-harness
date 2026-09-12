import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveCliStartupSession } from "../../../src/cli/session-args.js";
import {
  createClientCommandRegistry,
  processClientInput,
} from "../../../src/tui/client-commands.js";
import {
  ClientSessionRuntime,
  type DaemonSessionClient,
} from "../../../src/tui/client-session-runtime.js";
import { TuiReporter } from "../../../src/tui/tui-reporter.js";
import { DesktopRuntimeService } from "../../../src/daemon/desktop-runtime-service.js";
import { WorkspaceRuntimeService } from "../../../src/daemon/workspace-runtime-service.js";
import { createRuntimeRequest, type RuntimeMethod, type JsonValue } from "@pico/protocol";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";

import { StorageOperationJournal } from "../../../src/storage/operation-journal.js";

test("--resume and -S reject a missing session in the current workspace", async (context) => {
  const fixture = await createFixture("strict-resume");
  context.after(() => fixture.dispose());
  const previousPicoHome = process.env.PICO_HOME;
  process.env.PICO_HOME = fixture.picoHome;
  context.after(() => restoreEnvironment("PICO_HOME", previousPicoHome));

  await assert.rejects(
    resolveCliStartupSession(["--dir", fixture.workspace, "--resume", "missing"]),
    /无法恢复 session missing/u,
  );
  await assert.rejects(
    resolveCliStartupSession(["--dir", fixture.workspace, "-S", "missing"]),
    /无法恢复 session missing/u,
  );

  assert.equal(await fixture.store.readSessionManifest("missing"), undefined);
});

test("--resume and -S resume an existing session in the current workspace", async (context) => {
  const fixture = await createFixture("existing-resume");
  context.after(() => fixture.dispose());
  const previousPicoHome = process.env.PICO_HOME;
  process.env.PICO_HOME = fixture.picoHome;
  context.after(() => restoreEnvironment("PICO_HOME", previousPicoHome));
  await fixture.store.initializeSession({ sessionId: "known", workDir: fixture.workspace });

  for (const flag of ["--resume", "-S"] as const) {
    const resolved = await resolveCliStartupSession(["--dir", fixture.workspace, flag, "known"]);
    assert.deepEqual(resolved.sessionSelection, { mode: "resume", sessionId: "known" });
  }
});

test("/new requests an idle atomic switch without creating a session eagerly", async (context) => {
  const fixture = await createFixture("new-command");
  const client = await createCommandClient(fixture);
  context.after(async () => {
    await client.dispose();
    await fixture.dispose();
  });
  const processed = await client.run("/new");
  assert.deepEqual(processed.result?.data, { mode: "new" });
  assert.equal(processed.result?.action, "resume");
  assert.equal(client.runtime.activeSessionId, undefined);
  assert.deepEqual(client.requests, []);
  assert.deepEqual(await fixture.store.listSessionManifests(), []);
});

test("/compact refuses legacy environment credentials without a user model router", async (context) => {
  const fixture = await createFixture("compact-user-model-route");
  await fixture.store.initializeSession({
    sessionId: "compact-user-model-route",
    workDir: fixture.workspace,
  });
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

  const client = await createCommandClient(fixture, "compact-user-model-route");
  context.after(async () => {
    await client.dispose();
    await fixture.dispose();
  });
  const processed = await client.run("/compact");
  assert.equal(processed.kind, "local");
  assert.match(processed.result?.message ?? "", /model|模型|provider/i);
  assert.equal(client.providerCalls(), 0, "legacy environment cannot activate a model provider");
  assert.deepEqual(client.requests, ["session.compact"]);
});

test("/plan and /mode keep collaboration and permission independent", async (context) => {
  const fixture = await createFixture("plan-command-compatibility");
  const client = await createCommandClient(fixture);
  context.after(async () => {
    await client.dispose();
    await fixture.dispose();
  });
  await client.run("/plan");
  assert.equal(client.runtime.preSessionSettings.collaborationMode, "plan");
  assert.equal(client.runtime.preSessionSettings.permissionMode, "ask");
  await client.run("/mode auto");
  assert.equal(client.runtime.preSessionSettings.collaborationMode, "plan");
  assert.equal(client.runtime.preSessionSettings.permissionMode, "auto");
  await client.run("/mode agent");
  assert.equal(client.runtime.preSessionSettings.collaborationMode, "agent");
  assert.equal(client.runtime.preSessionSettings.permissionMode, "auto");
  await client.run("/mode plan");
  assert.equal(client.runtime.preSessionSettings.collaborationMode, "plan");
  assert.equal(client.runtime.preSessionSettings.permissionMode, "auto");
  assert.deepEqual(client.requests, []);
});

test("/resume and /fork reject an unpublished fork target", async (context) => {
  const fixture = await createFixture("unpublished-fork-command");
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
    targetCollaborationMode: "agent",
    targetPermissionMode: "ask",
    stagingDirectory: join(fixture.root, "staging", "unfinished-fork"),
  });
  const client = await createCommandClient(fixture);
  context.after(async () => {
    await client.dispose();
    await fixture.dispose();
  });
  const resumed = await client.run("/resume unfinished-fork");
  assert.match(resumed.result?.message ?? "", /不存在/u);
  const forked = await client.run("/fork unfinished-fork");
  assert.match(forked.result?.message ?? "", /分叉失败.*(?:不存在|not found|no saved session)/iu);
  assert.equal(client.runtime.activeSessionId, undefined);
  assert.deepEqual(client.requests, ["session.get", "session.fork"]);
  assert.equal((await fixture.store.listSessionManifests()).length, 1);
});

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
  readonly store: SqliteRuntimeEventStore;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-${name}-`));
  const workspaceSeed = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspaceSeed, { recursive: true });
  const workspace = await realpath(workspaceSeed);
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

async function createCommandClient(
  fixture: { workspace: string; picoHome: string },
  sessionId?: string,
) {
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(fixture.workspace);
  const env = { ...process.env, PICO_HOME: fixture.picoHome };
  let calls = 0;
  const desktop = new DesktopRuntimeService({
    runtimeService: new WorkspaceRuntimeService({ env, execute: async () => undefined }),
    trustStore,
    env,
    initializeDefaultProvider: false,
    providerFactory: () => {
      calls += 1;
      throw new Error("unexpected model provider activation");
    },
  });
  const requests: string[] = [];
  const runtime = new ClientSessionRuntime({
    client: {
      request: (method: RuntimeMethod, params: JsonValue) => {
        requests.push(method);
        return desktop.handle(createRuntimeRequest(method, params));
      },
      subscribeSessionFrames: () => ({ dispose: () => undefined }),
    } as unknown as DaemonSessionClient,
    workspacePath: fixture.workspace,
    sessionId,
    reporter: new TuiReporter({ onProjectionUpdate: () => undefined }),
  });
  const registry = createClientCommandRegistry({ runtime, workspacePath: fixture.workspace });
  return {
    runtime,
    requests,
    providerCalls: () => calls,
    run: (input: string) => processClientInput(input, registry, runtime),
    dispose: async () => {
      await runtime.dispose();
      await desktop.close();
    },
  };
}
