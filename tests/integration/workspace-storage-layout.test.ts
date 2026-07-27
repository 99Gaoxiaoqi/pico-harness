import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitFileTransactionSync,
  FileLockTimeoutError,
  FileStorageIntegrityError,
  withFileLockSync,
} from "../../src/storage/local-file-storage.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import {
  adoptWorkspaceStorageRootIdentitySync,
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_DIRECTORY,
  WORKSPACE_STORAGE_LAYOUT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "../../src/storage/workspace-storage-layout.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import { hashTaskRunInput, TaskRunStore, taskRunDigest } from "../../src/tasks/task-run-store.js";

test("workspace storage copies legacy Runtime JSON without modifying rollback ledgers", async (t) => {
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

  const store = new RuntimeEventStore({ storageRoot });
  assert.equal((await store.readSessionManifest(sessionId))?.sessionId, sessionId);

  assert.equal(
    await readFile(join(storageRoot, "sessions", digest, "session.jsonl"), "utf8"),
    legacyLedger,
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

test("workspace storage migration fails closed when canonical and legacy Session data conflict", async (t) => {
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
      /migration conflicts with existing target/u.test(error.message),
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
