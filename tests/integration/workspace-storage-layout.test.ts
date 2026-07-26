import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitFileTransactionSync,
  FileStorageIntegrityError,
} from "../../src/storage/local-file-storage.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import {
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_LAYOUT_FILE,
} from "../../src/storage/workspace-storage-layout.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";

test("workspace storage copies legacy Runtime JSON without modifying the rollback source", async (t) => {
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
      commitFileTransactionSync(
        storageRoot,
        {
          replacements: [
            { relativePath: "control/state.json", content: `${JSON.stringify(next, null, 2)}\n` },
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

function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}
