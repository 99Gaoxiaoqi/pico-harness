import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  commitFileTransactionSync,
  FileLockTimeoutError,
  FileStorageIntegrityError,
  withFileLockSync,
} from "../../src/storage/local-file-storage.js";
import {
  readExistingRuntimeSessionProjection,
  RuntimeEventStore,
} from "../../src/storage/runtime-event-store.js";
import {
  adoptWorkspaceStorageRootIdentitySync,
  WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_DIRECTORY,
  WORKSPACE_STORAGE_LAYOUT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "../../src/storage/workspace-storage-layout.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import { hashTaskRunInput, TaskRunStore, taskRunDigest } from "../../src/tasks/task-run-store.js";

test("workspace storage leaves legacy Session ledgers unsupported and untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-migrate-"));
  const workDir = join(root, "project");
  const storageRoot = join(root, "state");
  const sessionId = "legacy-session";
  const digest = sessionDigest(sessionId);
  const legacySessionRoot = join(storageRoot, "runtime", "sessions", digest);
  const legacyLogPath = join(legacySessionRoot, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workDir, { mode: 0o700 });
  await mkdir(legacySessionRoot, { recursive: true, mode: 0o700 });
  const tombstonePath = join(storageRoot, "runtime", `.lock.tombstone-${"a".repeat(64)}`);
  const candidatePath = join(
    storageRoot,
    "runtime",
    ".lock.candidate-12345678-1234-4234-9234-123456789abc",
  );
  await mkdir(tombstonePath, { mode: 0o700 });
  await mkdir(candidatePath, { mode: 0o700 });
  const legacyLedger = `${JSON.stringify({
    type: "session",
    schemaVersion: 1,
    sessionId,
    workDir,
    historySource: "runtime-event-v1",
    createdAt: "2026-07-25T00:00:00.000Z",
  })}\n`;
  await writeFile(legacyLogPath, legacyLedger, { mode: 0o600 });

  assert.equal(await readExistingRuntimeSessionProjection({ storageRoot, sessionId }), undefined);
  await assert.rejects(stat(join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE)), { code: "ENOENT" });

  const store = new RuntimeEventStore({ storageRoot });
  assert.equal(await store.readSessionManifest(sessionId), undefined);

  await assert.rejects(
    stat(join(storageRoot, "sessions", digest, "session.jsonl")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  assert.equal(await readFile(legacyLogPath, "utf8"), legacyLedger);
  assert.equal(
    JSON.parse(await readFile(join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE), "utf8"))
      .migratedFrom,
    "runtime-directory-v1",
  );
  assert.equal((await stat(join(storageRoot, "runtime"))).isDirectory(), true);
  assert.equal((await stat(tombstonePath)).isDirectory(), true);
  assert.equal((await stat(candidatePath)).isDirectory(), true);
  assert.equal((await stat(join(storageRoot, "runtime", "lock"))).isDirectory(), true);
  assert.throws(
    () =>
      withFileLockSync(join(storageRoot, "runtime", "lock"), "obsolete-runtime-writer", () => {}, {
        timeoutMs: 20,
        retryIntervalMs: 2,
      }),
    FileLockTimeoutError,
  );
});

test("workspace storage rejects a symbolic-link root without touching its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link setup requires elevated privileges on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-root-link-"));
  const realStorageRoot = join(root, "real-state");
  const aliasStorageRoot = join(root, "alias-state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: realStorageRoot });
  await store.initializeSession({
    sessionId: "protected-session",
    workDir: root,
  });
  await symlink(realStorageRoot, aliasStorageRoot, "dir");

  assert.throws(
    () => new RuntimeEventStore({ storageRoot: aliasStorageRoot }),
    /Storage root must be a real directory/u,
  );
  assert.throws(
    () => new RuntimeEventStore({ storageRoot: aliasStorageRoot }, { readOnly: true }),
    /Storage root must be a real directory/u,
  );
  assert.equal(
    (await store.readSessionManifest("protected-session"))?.sessionId,
    "protected-session",
  );
});

test("workspace storage revalidates a cached root before following a replacement symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link setup requires elevated privileges on Windows");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-cached-link-"));
  const storageRoot = join(root, "state");
  const movedStorageRoot = join(root, "moved-state");
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot }).close();
  await rename(storageRoot, movedStorageRoot);
  await symlink(movedStorageRoot, storageRoot, "dir");

  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot }),
    /Storage root must be a real directory/u,
  );
  assert.equal((await stat(join(movedStorageRoot, WORKSPACE_STORAGE_LAYOUT_FILE))).isFile(), true);
});

test("active stores fail closed when the storage root directory is replaced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-replaced-root-"));
  const storageRoot = join(root, "state");
  const movedStorageRoot = join(root, "original-state");
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeStore({ workDir: root, storageRoot });
  const originalLayoutPath = join(movedStorageRoot, WORKSPACE_STORAGE_LAYOUT_FILE);

  await rename(storageRoot, movedStorageRoot);
  await mkdir(join(storageRoot, ".storage"), { recursive: true, mode: 0o700 });
  await copyFile(originalLayoutPath, join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE));

  assert.throws(() => store.listJobs(), /Workspace storage root identity changed/u);
});

test("copied storage roots require explicit adoption and preserve the stable root ID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-adopt-"));
  const sourceRoot = join(root, "source");
  const copiedRoot = join(root, "copied");
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot: sourceRoot }).close();
  const sourceLayout = JSON.parse(
    await readFile(join(sourceRoot, WORKSPACE_STORAGE_LAYOUT_FILE), "utf8"),
  ) as { schemaVersion: number; storageRootId: string };
  await cp(sourceRoot, copiedRoot, { recursive: true, preserveTimestamps: true });

  assert.equal(sourceLayout.schemaVersion, 2);
  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot: copiedRoot }),
    /requires explicit adoption/u,
  );
  assert.throws(
    () => adoptWorkspaceStorageRootIdentitySync(copiedRoot, "wrong-root-id"),
    /does not match explicit adoption request/u,
  );

  const adopted = adoptWorkspaceStorageRootIdentitySync(copiedRoot, sourceLayout.storageRootId);
  assert.equal(adopted.storageRootId, sourceLayout.storageRootId);
  new RuntimeStore({ workDir: root, storageRoot: copiedRoot }).close();
  const copiedLayout = JSON.parse(
    await readFile(join(copiedRoot, WORKSPACE_STORAGE_LAYOUT_FILE), "utf8"),
  ) as { schemaVersion: number; storageRootId: string; adoptedAt?: string };
  assert.equal(copiedLayout.schemaVersion, 2);
  assert.equal(copiedLayout.storageRootId, sourceLayout.storageRootId);
  assert.equal(typeof copiedLayout.adoptedAt, "string");
});

test("copied roots never recover pending commits before explicit adoption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-adopt-pending-"));
  const sourceRoot = join(root, "source");
  const copiedRoot = join(root, "copied");
  const sourceStatePath = join(sourceRoot, "control", "state.json");
  const copiedStatePath = join(copiedRoot, "control", "state.json");
  const copiedCommitPath = join(copiedRoot, WORKSPACE_STORAGE_COMMIT_FILE);
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot: sourceRoot }).close();
  const sourceLayout = JSON.parse(
    await readFile(join(sourceRoot, WORKSPACE_STORAGE_LAYOUT_FILE), "utf8"),
  ) as { storageRootId: string };
  const before = JSON.parse(await readFile(sourceStatePath, "utf8")) as {
    revision: number;
    lastTransactionId?: string;
  };
  const next = {
    ...before,
    revision: before.revision + 1,
    lastTransactionId: "copied-root-pending-recovery",
  };
  assert.equal(before.revision, 1);
  assert.throws(
    () =>
      withFileLockSync(
        join(sourceRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "copied-root-pending-crash",
        () =>
          commitFileTransactionSync(
            sourceRoot,
            {
              replacements: [
                {
                  relativePath: "control/state.json",
                  content: `${JSON.stringify(next, null, 2)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId: "copied-root-pending-recovery",
              onStage(stage) {
                if (stage === "commit-published") throw new Error("simulated source crash");
              },
            },
          ),
      ),
    /simulated source crash/u,
  );
  await cp(sourceRoot, copiedRoot, { recursive: true, preserveTimestamps: true });
  const commitBefore = await readFile(copiedCommitPath, "utf8");
  const rootMtimeBefore = (await stat(copiedRoot)).mtimeMs;
  const coordinatorMtimeBefore = (await stat(join(copiedRoot, WORKSPACE_STORAGE_DIRECTORY)))
    .mtimeMs;

  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot: copiedRoot }),
    /requires explicit adoption/u,
  );
  assert.throws(
    () => new RuntimeEventStore({ storageRoot: copiedRoot }),
    /requires explicit adoption/u,
  );
  assert.throws(() => new TaskRunStore({ storageRoot: copiedRoot }), /requires explicit adoption/u);

  assert.deepEqual(JSON.parse(await readFile(copiedStatePath, "utf8")), before);
  assert.equal(await readFile(copiedCommitPath, "utf8"), commitBefore);
  assert.equal((await stat(copiedRoot)).mtimeMs, rootMtimeBefore);
  assert.equal(
    (await stat(join(copiedRoot, WORKSPACE_STORAGE_DIRECTORY))).mtimeMs,
    coordinatorMtimeBefore,
  );

  const adopted = adoptWorkspaceStorageRootIdentitySync(copiedRoot, sourceLayout.storageRootId);
  assert.equal(adopted.storageRootId, sourceLayout.storageRootId);
  assert.deepEqual(JSON.parse(await readFile(copiedStatePath, "utf8")), next);
  await assert.rejects(stat(copiedCommitPath), { code: "ENOENT" });
});

test("copied version 1 roots validate a pending version 2 layout identity before recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-v1-copy-pending-"));
  const sourceRoot = join(root, "source");
  const copiedRoot = join(root, "copied");
  const sourceStatePath = join(sourceRoot, "control", "state.json");
  const sourceLayoutPath = join(sourceRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
  const copiedStatePath = join(copiedRoot, "control", "state.json");
  const copiedLayoutPath = join(copiedRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
  const copiedCommitPath = join(copiedRoot, WORKSPACE_STORAGE_COMMIT_FILE);
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot: sourceRoot }).close();
  const version2Layout = JSON.parse(await readFile(sourceLayoutPath, "utf8")) as {
    schemaVersion: 2;
    storageRootId: string;
    createdAt: string;
    physicalIdentity: {
      canonicalPath: string;
      device: string;
      inode: string;
    };
  };
  assert.equal(version2Layout.physicalIdentity.canonicalPath, await realpath(sourceRoot));
  const version1Layout = `${JSON.stringify(
    {
      schemaVersion: 1,
      layout: "session-centric-v1",
      createdAt: version2Layout.createdAt,
    },
    null,
    2,
  )}\n`;
  await writeFile(sourceLayoutPath, version1Layout, { mode: 0o600 });
  const stateBefore = JSON.parse(await readFile(sourceStatePath, "utf8")) as {
    revision: number;
    lastTransactionId?: string;
  };
  const stateAfter = {
    ...stateBefore,
    revision: stateBefore.revision + 1,
    lastTransactionId: "v1-layout-upgrade-pending",
  };
  assert.equal(stateBefore.revision, 1);
  assert.throws(
    () =>
      withFileLockSync(
        join(sourceRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "v1-layout-upgrade-crash",
        () =>
          commitFileTransactionSync(
            sourceRoot,
            {
              replacements: [
                {
                  relativePath: "control/state.json",
                  content: `${JSON.stringify(stateAfter, null, 2)}\n`,
                },
                {
                  relativePath: WORKSPACE_STORAGE_LAYOUT_FILE,
                  content: `${JSON.stringify(version2Layout, null, 2)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
              transactionId: "v1-layout-upgrade-pending",
              onStage(stage) {
                if (stage === "commit-published") {
                  throw new Error("simulated v1 layout upgrade crash");
                }
              },
            },
          ),
      ),
    /simulated v1 layout upgrade crash/u,
  );
  await cp(sourceRoot, copiedRoot, { recursive: true, preserveTimestamps: true });
  const copiedStateBefore = await readFile(copiedStatePath);
  const copiedLayoutBefore = await readFile(copiedLayoutPath);
  const copiedCommitBefore = await readFile(copiedCommitPath);

  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot: copiedRoot }),
    /requires explicit adoption/u,
  );

  assert.deepEqual(await readFile(copiedStatePath), copiedStateBefore);
  assert.deepEqual(await readFile(copiedLayoutPath), copiedLayoutBefore);
  assert.deepEqual(await readFile(copiedCommitPath), copiedCommitBefore);

  new RuntimeStore({ workDir: root, storageRoot: sourceRoot }).close();
  assert.deepEqual(JSON.parse(await readFile(sourceStatePath, "utf8")), stateAfter);
  await assert.rejects(stat(join(sourceRoot, WORKSPACE_STORAGE_COMMIT_FILE)), {
    code: "ENOENT",
  });

  const adopted = adoptWorkspaceStorageRootIdentitySync(copiedRoot, version2Layout.storageRootId);
  assert.equal(adopted.storageRootId, version2Layout.storageRootId);
  assert.deepEqual(JSON.parse(await readFile(copiedStatePath, "utf8")), stateAfter);
  const copiedLayoutAfter = JSON.parse(await readFile(copiedLayoutPath, "utf8")) as {
    schemaVersion: number;
    storageRootId: string;
    adoptedAt?: string;
    physicalIdentity: { canonicalPath: string };
  };
  assert.equal(copiedLayoutAfter.schemaVersion, 2);
  assert.equal(copiedLayoutAfter.storageRootId, version2Layout.storageRootId);
  assert.equal(copiedLayoutAfter.physicalIdentity.canonicalPath, await realpath(copiedRoot));
  assert.equal(typeof copiedLayoutAfter.adoptedAt, "string");
  await assert.rejects(stat(copiedCommitPath), { code: "ENOENT" });
});

test("copied roots with a missing marker validate the pending version 2 identity before recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-missing-copy-pending-"));
  const sourceRoot = join(root, "source");
  const copiedRoot = join(root, "copied");
  const sourceStatePath = join(sourceRoot, "control", "state.json");
  const sourceLayoutPath = join(sourceRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
  const sourceCommitPath = join(sourceRoot, WORKSPACE_STORAGE_COMMIT_FILE);
  const copiedStatePath = join(copiedRoot, "control", "state.json");
  const copiedLayoutPath = join(copiedRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
  const copiedCommitPath = join(copiedRoot, WORKSPACE_STORAGE_COMMIT_FILE);
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot: sourceRoot }).close();
  const version2LayoutBytes = await readFile(sourceLayoutPath);
  const version2Layout = JSON.parse(version2LayoutBytes.toString("utf8")) as {
    schemaVersion: 2;
    storageRootId: string;
    physicalIdentity: { canonicalPath: string };
  };
  const stateBefore = JSON.parse(await readFile(sourceStatePath, "utf8")) as {
    revision: number;
    lastTransactionId?: string;
  };
  const stateAfter = {
    ...stateBefore,
    revision: stateBefore.revision + 1,
    lastTransactionId: "missing-layout-upgrade-pending",
  };
  await rm(sourceLayoutPath);
  assert.throws(
    () =>
      withFileLockSync(
        join(sourceRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "missing-layout-upgrade-crash",
        () =>
          commitFileTransactionSync(
            sourceRoot,
            {
              replacements: [
                {
                  relativePath: "control/state.json",
                  content: `${JSON.stringify(stateAfter, null, 2)}\n`,
                },
                {
                  relativePath: WORKSPACE_STORAGE_LAYOUT_FILE,
                  content: version2LayoutBytes,
                },
              ],
            },
            {
              ...WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
              transactionId: "missing-layout-upgrade-pending",
              onStage(stage) {
                if (stage === "commit-published") {
                  throw new Error("simulated missing layout upgrade crash");
                }
              },
            },
          ),
      ),
    /simulated missing layout upgrade crash/u,
  );
  await cp(sourceRoot, copiedRoot, { recursive: true, preserveTimestamps: true });
  const copiedStateBefore = await readFile(copiedStatePath);
  const copiedCommitBefore = await readFile(copiedCommitPath);
  const copiedRootMtimeBefore = (await stat(copiedRoot)).mtimeMs;
  const copiedCoordinatorMtimeBefore = (await stat(join(copiedRoot, WORKSPACE_STORAGE_DIRECTORY)))
    .mtimeMs;
  await assert.rejects(stat(copiedLayoutPath), { code: "ENOENT" });

  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot: copiedRoot }),
    /requires explicit adoption/u,
  );
  assert.deepEqual(await readFile(copiedStatePath), copiedStateBefore);
  assert.deepEqual(await readFile(copiedCommitPath), copiedCommitBefore);
  await assert.rejects(stat(copiedLayoutPath), { code: "ENOENT" });
  assert.equal((await stat(copiedRoot)).mtimeMs, copiedRootMtimeBefore);
  assert.equal(
    (await stat(join(copiedRoot, WORKSPACE_STORAGE_DIRECTORY))).mtimeMs,
    copiedCoordinatorMtimeBefore,
  );

  new RuntimeStore({ workDir: root, storageRoot: sourceRoot }).close();
  assert.deepEqual(JSON.parse(await readFile(sourceStatePath, "utf8")), stateAfter);
  assert.deepEqual(await readFile(sourceLayoutPath), version2LayoutBytes);
  await assert.rejects(stat(sourceCommitPath), { code: "ENOENT" });

  const adopted = adoptWorkspaceStorageRootIdentitySync(copiedRoot, version2Layout.storageRootId);
  assert.equal(adopted.storageRootId, version2Layout.storageRootId);
  assert.deepEqual(JSON.parse(await readFile(copiedStatePath, "utf8")), stateAfter);
  const copiedLayoutAfter = JSON.parse(await readFile(copiedLayoutPath, "utf8")) as {
    schemaVersion: number;
    storageRootId: string;
    adoptedAt?: string;
    physicalIdentity: { canonicalPath: string };
  };
  assert.equal(copiedLayoutAfter.schemaVersion, 2);
  assert.equal(copiedLayoutAfter.storageRootId, version2Layout.storageRootId);
  assert.equal(copiedLayoutAfter.physicalIdentity.canonicalPath, await realpath(copiedRoot));
  assert.equal(typeof copiedLayoutAfter.adoptedAt, "string");
  await assert.rejects(stat(copiedCommitPath), { code: "ENOENT" });
});

test("missing layout markers fail closed when a pending transaction cannot verify identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-missing-unverified-"));
  const storageRoot = join(root, "state");
  const statePath = join(storageRoot, "control", "state.json");
  const layoutPath = join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
  const commitPath = join(storageRoot, WORKSPACE_STORAGE_COMMIT_FILE);
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot }).close();
  const layout = JSON.parse(await readFile(layoutPath, "utf8")) as {
    storageRootId: string;
  };
  const stateBefore = JSON.parse(await readFile(statePath, "utf8")) as {
    revision: number;
    lastTransactionId?: string;
  };
  const stateAfter = {
    ...stateBefore,
    revision: stateBefore.revision + 1,
    lastTransactionId: "missing-layout-unverified-pending",
  };
  await rm(layoutPath);
  assert.throws(
    () =>
      withFileLockSync(
        join(storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "missing-layout-unverified-crash",
        () =>
          commitFileTransactionSync(
            storageRoot,
            {
              replacements: [
                {
                  relativePath: "control/state.json",
                  content: `${JSON.stringify(stateAfter, null, 2)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId: "missing-layout-unverified-pending",
              onStage(stage) {
                if (stage === "commit-published") {
                  throw new Error("simulated unverified missing layout crash");
                }
              },
            },
          ),
      ),
    /simulated unverified missing layout crash/u,
  );
  const stateBytes = await readFile(statePath);
  const commitBytes = await readFile(commitPath);

  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot }),
    /pending transaction without a verifiable version 2 layout replacement.*verified manual recovery/u,
  );
  assert.throws(
    () => adoptWorkspaceStorageRootIdentitySync(storageRoot, layout.storageRootId),
    /cannot be explicitly adopted/u,
  );
  assert.deepEqual(await readFile(statePath), stateBytes);
  assert.deepEqual(await readFile(commitPath), commitBytes);
  await assert.rejects(stat(layoutPath), { code: "ENOENT" });
});

for (const [surface, relativePath] of [
  ["Session", join("sessions", "a".repeat(64), "session.jsonl")],
  ["TaskRun", join("task-runs", "b".repeat(64), "task.jsonl")],
  ["control", join("control", "state.json")],
] as const) {
  test(`missing layout markers fail closed over existing canonical ${surface} data`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-missing-canonical-"));
    const storageRoot = join(root, "state");
    const dataPath = join(storageRoot, relativePath);
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(dirname(dataPath), { recursive: true, mode: 0o700 });
    await writeFile(dataPath, "canonical data must stay bound\n", { mode: 0o600 });
    const dataBytes = await readFile(dataPath);
    const rootMtimeBefore = (await stat(storageRoot)).mtimeMs;

    assert.throws(
      () => new RuntimeStore({ workDir: root, storageRoot }),
      /canonical data without a workspace storage layout marker.*verified manual import/u,
    );
    assert.deepEqual(await readFile(dataPath), dataBytes);
    assert.equal((await stat(storageRoot)).mtimeMs, rootMtimeBefore);
    await assert.rejects(stat(join(storageRoot, WORKSPACE_STORAGE_DIRECTORY)), {
      code: "ENOENT",
    });
    await assert.rejects(stat(join(storageRoot, "runtime")), { code: "ENOENT" });
  });
}

test("version 1 runtime-only pending commits require verified manual recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-v1-runtime-pending-"));
  const storageRoot = join(root, "state");
  const statePath = join(storageRoot, "control", "state.json");
  const layoutPath = join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
  const commitPath = join(storageRoot, WORKSPACE_STORAGE_COMMIT_FILE);
  t.after(() => rm(root, { recursive: true, force: true }));
  new RuntimeStore({ workDir: root, storageRoot }).close();
  const version2Layout = JSON.parse(await readFile(layoutPath, "utf8")) as {
    storageRootId: string;
    createdAt: string;
  };
  const version1Layout = `${JSON.stringify(
    {
      schemaVersion: 1,
      layout: "session-centric-v1",
      createdAt: version2Layout.createdAt,
    },
    null,
    2,
  )}\n`;
  await writeFile(layoutPath, version1Layout, { mode: 0o600 });
  const stateBefore = JSON.parse(await readFile(statePath, "utf8")) as {
    revision: number;
    lastTransactionId?: string;
  };
  const stateAfter = {
    ...stateBefore,
    revision: stateBefore.revision + 1,
    lastTransactionId: "v1-runtime-only-pending",
  };
  assert.throws(
    () =>
      withFileLockSync(
        join(storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "v1-runtime-only-crash",
        () =>
          commitFileTransactionSync(
            storageRoot,
            {
              replacements: [
                {
                  relativePath: "control/state.json",
                  content: `${JSON.stringify(stateAfter, null, 2)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId: "v1-runtime-only-pending",
              onStage(stage) {
                if (stage === "commit-published") {
                  throw new Error("simulated v1 runtime crash");
                }
              },
            },
          ),
      ),
    /simulated v1 runtime crash/u,
  );
  const stateBytes = await readFile(statePath);
  const layoutBytes = await readFile(layoutPath);
  const commitBytes = await readFile(commitPath);

  assert.throws(
    () => new RuntimeStore({ workDir: root, storageRoot }),
    /without a verifiable version 2 layout replacement.*verified manual recovery/u,
  );
  assert.throws(
    () => adoptWorkspaceStorageRootIdentitySync(storageRoot, version2Layout.storageRootId),
    /cannot be explicitly adopted/u,
  );
  assert.deepEqual(await readFile(statePath), stateBytes);
  assert.deepEqual(await readFile(layoutPath), layoutBytes);
  assert.deepEqual(await readFile(commitPath), commitBytes);
});

test("opening a version 1 layout upgrades it once without changing its creation time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-v1-upgrade-"));
  const storageRoot = join(root, "state");
  const createdAt = "2026-07-25T00:00:00.000Z";
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(storageRoot, ".storage"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        layout: "session-centric-v1",
        createdAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  new RuntimeStore({ workDir: root, storageRoot }).close();

  const upgraded = JSON.parse(
    await readFile(join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE), "utf8"),
  ) as { schemaVersion: number; storageRootId?: string; createdAt: string };
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.createdAt, createdAt);
  assert.equal(typeof upgraded.storageRootId, "string");
});

test("workspace storage fails closed when markerless canonical and legacy Session data conflict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-conflict-"));
  const storageRoot = join(root, "state");
  const digest = sessionDigest("conflicting-session");
  const legacyLogPath = join(storageRoot, "runtime", "sessions", digest, "session.jsonl");
  const targetLogPath = join(storageRoot, "sessions", digest, "session.jsonl");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(storageRoot, "runtime", "sessions", digest), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(storageRoot, "sessions", digest), { recursive: true, mode: 0o700 });
  await writeFile(legacyLogPath, '{"source":"legacy"}\n', { mode: 0o600 });
  await writeFile(targetLogPath, '{"source":"canonical"}\n', { mode: 0o600 });

  assert.throws(
    () => new RuntimeEventStore({ storageRoot }),
    (error: unknown) =>
      error instanceof FileStorageIntegrityError &&
      /canonical data without a workspace storage layout marker/u.test(error.message),
  );

  assert.equal(await readFile(legacyLogPath, "utf8"), '{"source":"legacy"}\n');
  assert.equal(await readFile(targetLogPath, "utf8"), '{"source":"canonical"}\n');
  await assert.rejects(stat(join(storageRoot, WORKSPACE_STORAGE_LAYOUT_FILE)), { code: "ENOENT" });
  await assert.rejects(stat(join(storageRoot, WORKSPACE_STORAGE_COMMIT_FILE)), { code: "ENOENT" });
});

test("opening RuntimeEventStore recovers a pending control transaction from the shared marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-cross-store-"));
  const workDir = join(root, "project");
  const storageRoot = join(root, "state");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workDir, { mode: 0o700 });

  const controlStore = new RuntimeStore({ workDir, storageRoot });
  const statePath = join(storageRoot, "control", "state.json");
  const before = JSON.parse(await readFile(statePath, "utf8")) as {
    revision: number;
    lastTransactionId?: string;
  };
  const next = {
    ...before,
    revision: before.revision + 1,
    lastTransactionId: "cross-store-control-recovery",
  };

  assert.throws(
    () =>
      withFileLockSync(
        join(storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "cross-store-control-crash",
        () =>
          commitFileTransactionSync(
            storageRoot,
            {
              replacements: [
                {
                  relativePath: "control/state.json",
                  content: `${JSON.stringify(next, null, 2)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId: "cross-store-control-recovery",
              onStage(stage) {
                if (stage === "commit-published") throw new Error("simulated control crash");
              },
            },
          ),
      ),
    /simulated control crash/u,
  );
  assert.equal(
    JSON.parse(await readFile(join(storageRoot, WORKSPACE_STORAGE_COMMIT_FILE), "utf8"))
      .transactionId,
    "cross-store-control-recovery",
  );
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), before);

  new RuntimeEventStore({ storageRoot }).close();

  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), next);
  await assert.rejects(stat(join(storageRoot, WORKSPACE_STORAGE_COMMIT_FILE)), { code: "ENOENT" });
  assert.deepEqual(controlStore.listJobs(), []);
  new RuntimeStore({ workDir, storageRoot }).close();
});

test("opening RuntimeStore recovers a pending TaskRun transaction from the shared marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-layout-task-recovery-"));
  const workDir = join(root, "project");
  const storageRoot = join(root, "state");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workDir, { mode: 0o700 });
  const input = { prompt: "recover the task transaction" };
  const tasks = new TaskRunStore({ storageRoot });
  await tasks.initializeTaskRun({
    taskRunId: "shared-task",
    workDir,
    adapter: {
      id: "shared.adapter",
      version: 1,
      input,
      inputHash: hashTaskRunInput(input),
    },
    maxAttempts: 3,
  });
  const batch = {
    type: "task-event-batch",
    schemaVersion: 1,
    txId: "cross-store-task-recovery",
    entries: [
      {
        sequence: 1,
        committedAt: "2026-07-27T00:00:00.000Z",
        event: {
          schemaVersion: 1,
          eventId: "task-parked",
          taskRunId: "shared-task",
          at: "2026-07-27T00:00:00.000Z",
          kind: "task.parked",
          data: { reasons: ["adapter_missing"] },
        },
      },
    ],
  };

  assert.throws(
    () =>
      withFileLockSync(
        join(storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "cross-store-task-crash",
        () =>
          commitFileTransactionSync(
            storageRoot,
            {
              appends: [
                {
                  relativePath: join("task-runs", taskRunDigest("shared-task"), "task.jsonl"),
                  content: `${JSON.stringify(batch)}\n`,
                },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId: "cross-store-task-recovery",
              onStage(stage) {
                if (stage === "commit-published") throw new Error("simulated TaskRun crash");
              },
            },
          ),
      ),
    /simulated TaskRun crash/u,
  );

  new RuntimeStore({ workDir, storageRoot }).close();

  assert.equal((await tasks.readTaskRunProjection("shared-task"))?.status, "parked");
  await assert.rejects(stat(join(storageRoot, WORKSPACE_STORAGE_COMMIT_FILE)), {
    code: "ENOENT",
  });
});

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}
