import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntimeRequest, parseRuntimeResult } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";

test("project registration groups linked worktrees and migrates legacy paths durably", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-registration-"));
  const picoHome = join(root, "pico-home");
  const repository = join(root, "maka-harness");
  const linkedWorktree = join(root, "maka-harness-feature");
  const independentClone = join(root, "maka-harness-clone");
  const folder = join(root, "notes");
  const temporaryWorkspace = join(picoHome, `temporary-workspace-${randomUUID()}`);
  const registryPath = join(picoHome, "daemon-workspaces.json");
  await Promise.all([
    mkdir(picoHome, { recursive: true }),
    mkdir(repository, { recursive: true }),
    mkdir(folder, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  runGit(["init", "--quiet", "--initial-branch=main"], repository);
  runGit(
    [
      "-c",
      "user.name=Pico Test",
      "-c",
      "user.email=pico@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "baseline",
    ],
    repository,
  );
  runGit(["worktree", "add", "--quiet", "-b", "feature", linkedWorktree], repository);
  runGit(["clone", "--quiet", repository, independentClone], root);
  await mkdir(temporaryWorkspace, { recursive: true });

  const paths = await Promise.all(
    [repository, linkedWorktree, independentClone, folder, temporaryWorkspace].map((path) =>
      realpath(path),
    ),
  );
  await writeFile(registryPath, `${JSON.stringify({ version: 1, workspaces: paths }, null, 2)}\n`);
  const firstStore = new WorkspaceRegistrationStore(registryPath);
  const registrations = await firstStore.listRegistrations();
  assert.deepEqual(
    new Set(registrations.map((entry) => entry.workspacePath)),
    new Set(paths),
    "the migrated registry retains each exact worktree and folder path",
  );
  const byPath = new Map(registrations.map((entry) => [entry.workspacePath, entry]));
  const canonicalRepository = paths[0]!;
  const canonicalLinkedWorktree = paths[1]!;
  const canonicalClone = paths[2]!;
  const canonicalFolder = paths[3]!;
  const canonicalTemporary = paths[4]!;
  const main = byPath.get(canonicalRepository)!;
  const linked = byPath.get(canonicalLinkedWorktree)!;
  const clone = byPath.get(canonicalClone)!;
  const ordinary = byPath.get(canonicalFolder)!;
  const temporary = byPath.get(canonicalTemporary)!;

  assert.ok(main.projectId);
  assert.equal(linked.projectId, main.projectId);
  assert.equal(main.projectName, basename(canonicalRepository));
  assert.ok(clone.projectId);
  assert.notEqual(
    clone.projectId,
    main.projectId,
    "independent clones retain separate project identities",
  );
  assert.ok(ordinary.projectId);
  assert.notEqual(ordinary.projectId, main.projectId);
  assert.equal(ordinary.projectName, basename(canonicalFolder));
  assert.equal(temporary.projectId, null);
  assert.equal(temporary.projectName, null);

  const migrated = JSON.parse(await readFile(registryPath, "utf8")) as { version: number };
  assert.equal(migrated.version, 2, "legacy path lists are replaced by the project registry");

  const restartedStore = new WorkspaceRegistrationStore(registryPath);
  const restarted = new Map(
    (await restartedStore.listRegistrations()).map((entry) => [entry.workspacePath, entry]),
  );
  assert.equal(restarted.get(canonicalRepository)?.projectId, main.projectId);
  assert.equal(restarted.get(canonicalLinkedWorktree)?.projectId, main.projectId);
  assert.equal(restarted.get(canonicalClone)?.projectId, clone.projectId);

  await restartedStore.unregister(canonicalLinkedWorktree);
  const reRegistered = await restartedStore.register(canonicalLinkedWorktree);
  assert.equal(reRegistered, canonicalLinkedWorktree);
  assert.equal(
    (await restartedStore.projectMetadata(canonicalLinkedWorktree)).projectId,
    main.projectId,
  );

  runGit(["worktree", "remove", "--force", canonicalLinkedWorktree], canonicalRepository);
  await mkdir(canonicalLinkedWorktree, { recursive: true });
  runGit(["init", "--quiet", "--initial-branch=main"], canonicalLinkedWorktree);
  runGit(
    [
      "-c",
      "user.name=Pico Test",
      "-c",
      "user.email=pico@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "replacement repository",
    ],
    canonicalLinkedWorktree,
  );
  await restartedStore.register(canonicalLinkedWorktree);
  const replacement = await restartedStore.projectMetadata(canonicalLinkedWorktree);
  assert.ok(replacement.projectId);
  assert.notEqual(
    replacement.projectId,
    main.projectId,
    "a different repository created at a previously registered path receives a new project ID",
  );
  assert.equal(
    (await restartedStore.projectMetadata(canonicalRepository)).projectId,
    main.projectId,
    "re-registering a replaced path does not rewrite the remaining worktree's project",
  );
});

test("workspace.list exposes registered project identity and display name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-list-"));
  const picoHome = join(root, "pico-home");
  const workspacePath = join(root, "workspace-list-project");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const registrationStore = new WorkspaceRegistrationStore(
    join(picoHome, "daemon-workspaces.json"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  await registrationStore.register(workspacePath);
  const canonicalWorkspacePath = await realpath(workspacePath);
  const runtimeService = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    registrationStore,
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService,
    registrationStore,
    env: { PICO_HOME: picoHome },
  });
  t.after(() => desktop.close());
  const result = parseRuntimeResult(
    "workspace.list",
    await desktop.handle(createRuntimeRequest("workspace.list", {})),
  );
  const workspace = result.workspaces.find(
    (entry) => entry.workspacePath === canonicalWorkspacePath,
  );
  assert.ok(workspace?.projectId);
  assert.equal(workspace.projectName, basename(workspacePath));
});

test("legacy migration keeps the old file on write failure and retries later", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("directory write permissions are not enforceable in this environment");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pico-project-migration-retry-"));
  const picoHome = join(root, "pico-home");
  const workspacePath = join(root, "migration-workspace");
  const registryPath = join(picoHome, "daemon-workspaces.json");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const canonicalWorkspacePath = await realpath(workspacePath);
  await writeFile(
    registryPath,
    `${JSON.stringify({ version: 1, workspaces: [canonicalWorkspacePath] })}\n`,
  );
  const store = new WorkspaceRegistrationStore(registryPath);
  t.after(async () => {
    await chmod(picoHome, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await chmod(picoHome, 0o500);
  let fallbackProjectId: string | null;
  try {
    const [workspace] = await store.listRegistrations();
    fallbackProjectId = workspace?.projectId ?? null;
    assert.ok(fallbackProjectId, "in-memory fallback still groups registered workspaces");
    assert.equal(
      (JSON.parse(await readFile(registryPath, "utf8")) as { version: number }).version,
      1,
      "failed migration leaves the original registry file untouched",
    );
    assert.ok(store.diagnostics().some((message) => message.includes("迁移写入失败")));
  } finally {
    await chmod(picoHome, 0o700);
  }

  const retried = await store.listRegistrations();
  assert.equal(retried[0]?.projectId, fallbackProjectId);
  assert.equal(
    (JSON.parse(await readFile(registryPath, "utf8")) as { version: number }).version,
    2,
    "the next access retries and completes the migration",
  );
});

test("Git identity discovery failures are diagnosed and reconciled on a later registration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-discovery-retry-"));
  const picoHome = join(root, "pico-home");
  const repository = join(root, "retry-repository");
  const linkedWorktree = join(root, "retry-worktree");
  await mkdir(picoHome, { recursive: true });
  await mkdir(repository, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  runGit(["init", "--quiet", "--initial-branch=main"], repository);
  runGit(
    [
      "-c",
      "user.name=Pico Test",
      "-c",
      "user.email=pico@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "baseline",
    ],
    repository,
  );
  runGit(["worktree", "add", "--quiet", "-b", "feature", linkedWorktree], repository);
  const [canonicalRepository, canonicalWorktree] = await Promise.all([
    realpath(repository),
    realpath(linkedWorktree),
  ]);
  const store = new WorkspaceRegistrationStore(join(picoHome, "daemon-workspaces.json"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    await store.register(canonicalRepository);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  const fallbackProjectId = (await store.projectMetadata(canonicalRepository)).projectId;
  assert.ok(fallbackProjectId);
  assert.ok(store.diagnostics().some((message) => message.includes("common directory")));

  await store.register(canonicalWorktree);
  assert.equal((await store.projectMetadata(canonicalRepository)).projectId, fallbackProjectId);
  assert.equal((await store.projectMetadata(canonicalWorktree)).projectId, fallbackProjectId);
});

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], {
    cwd,
    stdio: "pipe",
    windowsHide: true,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
    ),
  });
}
