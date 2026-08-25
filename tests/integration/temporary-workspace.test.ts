import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseDesktopRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type WorkspaceStatusResult,
} from "../../packages/protocol/src/index.js";
import { createRuntimeRequest } from "../../src/daemon/protocol.js";
import { DesktopRuntimeService } from "../../src/daemon/desktop-runtime-service.js";
import {
  TemporaryWorkspaceAuthority,
  TemporaryWorkspaceUnavailableError,
} from "../../src/daemon/temporary-workspace-authority.js";
import { WorkspaceRegistrationStore } from "../../src/daemon/workspace-registration.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { Session } from "../../src/engine/session.js";

test("temporary workspace protocol is strict and requires the temporary marker", () => {
  assert.deepEqual(parseStrictRuntimeParams("workspace.temporary.ensure", {}), {});
  assert.throws(
    () => parseStrictRuntimeParams("workspace.temporary.ensure", { workspacePath: "/tmp" }),
    RuntimeProtocolError,
  );

  const status = temporaryStatus("/state/temporary-workspace");
  assert.deepEqual(parseDesktopRuntimeResult("workspace.temporary.ensure", status), status);
  const { temporary: _temporary, ...ordinary } = status;
  assert.throws(
    () => parseDesktopRuntimeResult("workspace.temporary.ensure", ordinary),
    RuntimeProtocolError,
  );
  assert.throws(
    () =>
      parseDesktopRuntimeResult("workspace.temporary.ensure", {
        ...status,
        temporary: false,
      }),
    RuntimeProtocolError,
  );
  assert.throws(
    () =>
      parseDesktopRuntimeResult("workspace.temporary.ensure", {
        ...status,
        registered: false,
      }),
    RuntimeProtocolError,
  );
  assert.throws(
    () =>
      parseDesktopRuntimeResult("workspace.temporary.ensure", {
        ...status,
        secret: "must-not-cross-ipc",
      }),
    RuntimeProtocolError,
  );
});

test("temporary workspace authority creates a private persistent directory exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-temporary-authority-"));
  const picoHome = join(root, "pico-home");
  t.after(() => rm(root, { recursive: true, force: true }));
  let registrations = 0;
  let trusts = 0;
  const authority = new TemporaryWorkspaceAuthority({
    picoHome,
    register: async (workspacePath) => {
      registrations += 1;
      return workspacePath;
    },
    trust: async () => {
      trusts += 1;
    },
  });

  const [first, concurrent] = await Promise.all([authority.ensure(), authority.ensure()]);
  assert.equal(first, concurrent);
  assert.equal(first, await realpath(join(picoHome, "temporary-workspace")));
  assert.equal(registrations, 1);
  assert.equal(trusts, 1);
  assert.equal((await lstat(first)).mode & 0o777, 0o700);

  await writeFile(join(first, "persistent.txt"), "kept across restarts\n", "utf8");
  const restarted = new TemporaryWorkspaceAuthority({
    picoHome,
    register: async (workspacePath) => workspacePath,
    trust: async () => undefined,
  });
  assert.equal(await restarted.ensure(), first);
  assert.equal((await lstat(join(first, "persistent.txt"))).isFile(), true);
});

for (const placeholder of ["file", "symlink"] as const) {
  test(`temporary workspace authority rejects a ${placeholder} placeholder`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `pico-temporary-${placeholder}-`));
    const picoHome = join(root, "pico-home");
    const workspacePath = join(picoHome, "temporary-workspace");
    await mkdir(picoHome, { recursive: true });
    if (placeholder === "file") await writeFile(workspacePath, "occupied", "utf8");
    else {
      const target = join(root, "redirected");
      await mkdir(target);
      await symlink(target, workspacePath);
    }
    t.after(() => rm(root, { recursive: true, force: true }));
    const authority = new TemporaryWorkspaceAuthority({
      picoHome,
      register: async () => assert.fail("unsafe path must not be registered"),
      trust: async () => assert.fail("unsafe path must not be trusted"),
    });

    await assert.rejects(authority.ensure(), TemporaryWorkspaceUnavailableError);
  });
}

test("desktop temporary workspace is registered, trusted, listed and protected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-temporary-desktop-"));
  const picoHome = join(root, "pico-home");
  const env = { PICO_HOME: picoHome };
  const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const runtime = new WorkspaceRuntimeService({
    env,
    registrationStore,
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, registrationStore, env });
  t.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });

  const ensured = (await desktop.handle(
    createRuntimeRequest("workspace.temporary.ensure", {}),
  )) as WorkspaceStatusResult & { readonly temporary: true };
  assert.equal(ensured.temporary, true);
  assert.equal(ensured.registered, true);
  assert.equal(ensured.mode, "folder");
  assert.equal(ensured.workspacePath, await realpath(join(picoHome, "temporary-workspace")));
  assert.deepEqual(
    await desktop.handle(
      createRuntimeRequest("workspace.trustStatus", { workspacePath: ensured.workspacePath }),
    ),
    { workspacePath: ensured.workspacePath, trusted: true },
  );
  const listed = (await desktop.handle(createRuntimeRequest("workspace.list", {}))) as {
    readonly workspaces: readonly WorkspaceStatusResult[];
  };
  assert.equal(listed.workspaces.length, 1);
  assert.equal(listed.workspaces[0]?.workspacePath, ensured.workspacePath);
  assert.equal(listed.workspaces[0]?.temporary, true);

  for (const request of [
    createRuntimeRequest("workspace.trust", {
      workspacePath: ensured.workspacePath,
      trusted: false,
    }),
    createRuntimeRequest("workspace.unregister", { workspacePath: ensured.workspacePath }),
  ]) {
    await assert.rejects(
      desktop.handle(request),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === RUNTIME_ERROR_CODES.FORBIDDEN,
    );
  }
});

test("temporary workspace sessions recover from the persisted workspace path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-temporary-restart-"));
  const picoHome = join(root, "pico-home");
  const env = { PICO_HOME: picoHome };
  t.after(() => rm(root, { recursive: true, force: true }));

  const firstRegistrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const firstRuntime = new WorkspaceRuntimeService({
    env,
    registrationStore: firstRegistrationStore,
    execute: async () => undefined,
  });
  const firstDesktop = new DesktopRuntimeService({
    runtimeService: firstRuntime,
    registrationStore: firstRegistrationStore,
    env,
  });
  const firstStatus = (await firstDesktop.handle(
    createRuntimeRequest("workspace.temporary.ensure", {}),
  )) as WorkspaceStatusResult & { readonly temporary: true };
  const sessionId = "temporary-restart-session";
  const session = new Session(sessionId, firstStatus.workspacePath, {
    persistence: true,
    picoHome,
  });
  await session.recover();
  await session.close();
  await firstDesktop.close();

  const secondRegistrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const secondRuntime = new WorkspaceRuntimeService({
    env,
    registrationStore: secondRegistrationStore,
    execute: async () => undefined,
  });
  const secondDesktop = new DesktopRuntimeService({
    runtimeService: secondRuntime,
    registrationStore: secondRegistrationStore,
    env,
  });
  t.after(() => secondDesktop.close());
  const secondStatus = (await secondDesktop.handle(
    createRuntimeRequest("workspace.temporary.ensure", {}),
  )) as WorkspaceStatusResult & { readonly temporary: true };
  assert.equal(secondStatus.workspacePath, firstStatus.workspacePath);
  const sessions = (await secondDesktop.handle(
    createRuntimeRequest("session.list", { workspacePath: secondStatus.workspacePath }),
  )) as { readonly sessions: readonly { readonly sessionId: string }[] };
  assert.equal(
    sessions.sessions.some((item) => item.sessionId === sessionId),
    true,
  );
});

function temporaryStatus(workspacePath: string) {
  return {
    workspacePath,
    registered: true,
    temporary: true as const,
    schedulerStatus: "unknown" as const,
    mode: "folder" as const,
    branch: "",
    capabilities: {
      foregroundRuns: true,
      fileHistory: true,
      isolatedWorktrees: false,
      branchMerge: false,
    },
    eventLog: null,
  };
}
