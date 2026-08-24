import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  EvidenceBlobStore,
  withVerifiedEvidenceDirectory,
} from "../../src/context/evidence-blob-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { FileHistoryBlobStore } from "../../src/storage/file-history-blob-store.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import { withWorkspaceSqliteLease } from "../../src/storage/sqlite/workspace-scopes.js";
import { runWorkspaceBlobGcOnce } from "../../src/storage/workspace-blob-gc.js";

test("Blob GC consumes retention evidence intents idempotently", async () => {
  const fixture = createFixture("evidence");
  try {
    const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
    mkdirSync(paths.workspace.root, { recursive: true });
    const store = new EvidenceBlobStore(paths.workspace.evidence);
    const created = await store.putUtf8("orphaned evidence");
    const blobPath = join(
      paths.workspace.evidence,
      "blobs",
      "sha256",
      created.ref.digest.slice(0, 2),
      created.ref.digest,
    );
    insertRetentionIntent(
      paths.workspace.root,
      "retention-evidence",
      "evidence",
      created.ref.digest,
      created.ref.sizeBytes,
    );

    const first = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
    });
    assert.deepEqual(first, {
      status: "completed",
      processed: 1,
      completed: 1,
      retryable: 0,
      hasMore: false,
    });
    assert.equal(existsSync(blobPath), false);

    const second = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
    });
    assert.equal(second.processed, 0);
    withWorkspaceSqliteLease(paths.workspace.root, (lease) => {
      const row = lease.database
        .prepare(
          "SELECT status, attempt_count, completed_at FROM retention_gc_intents WHERE intent_id = ?",
        )
        .get("retention-evidence") as Record<string, unknown>;
      assert.equal(row["status"], "completed");
      assert.equal(row["attempt_count"], 1);
      assert.equal(typeof row["completed_at"], "number");
    });
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("File History GC holds the global mutation lease and waits for all workspace references", async () => {
  const fixture = createFixture("file-history");
  const secondWorkDir = join(fixture.root, "workspace-b");
  mkdirSync(secondWorkDir, { recursive: true });
  try {
    const sourcePaths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
    const survivorPaths = resolvePicoPaths(secondWorkDir, { picoHome: fixture.picoHome });
    const store = new FileHistoryBlobStore({ baseDir: sourcePaths.home.fileHistory });
    const created = await store.put("shared file history");
    insertHardCutIntent(
      sourcePaths.workspace.root,
      "hard-cut-file-history",
      "file_history_blob",
      created.ref.digest,
      created.ref.sizeBytes,
    );
    withWorkspaceSqliteLease(survivorPaths.workspace.root, (lease) => {
      lease.database
        .prepare(
          `INSERT INTO file_history (
             session_id, revision, snapshot_sequence, state_json, updated_at
           ) VALUES ('survivor', 1, 0, ?, '2026-08-24T00:00:00.000Z')`,
        )
        .run(JSON.stringify({ blob: created.ref }));
    });

    const blocked = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });
    assert.equal(blocked.retryable, 1);
    assert.equal(existsSync(created.path), true);

    withWorkspaceSqliteLease(survivorPaths.workspace.root, (lease) => {
      lease.database.prepare("DELETE FROM file_history WHERE session_id = 'survivor'").run();
    });
    const completed = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      now: () => new Date("2026-08-24T00:00:02.000Z"),
    });
    assert.equal(completed.completed, 1);
    assert.equal(existsSync(created.path), false);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("Runtime asset GC fails closed for paths outside the workspace storage root", async () => {
  const fixture = createFixture("runtime-asset");
  try {
    const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
    const outsideStore = new FileHistoryBlobStore({ baseDir: join(fixture.root, "outside") });
    const outside = await outsideStore.put("do not delete");
    insertHardCutIntent(
      paths.workspace.root,
      "hard-cut-runtime-asset",
      "runtime_asset",
      outside.ref.digest,
      outside.ref.sizeBytes,
      outside.path,
    );

    const result = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });
    assert.equal(result.retryable, 1);
    assert.equal(existsSync(outside.path), true);
    withWorkspaceSqliteLease(paths.workspace.root, (lease) => {
      const row = lease.database
        .prepare(
          "SELECT state, attempt_count, last_error FROM event_log_blob_gc_intents WHERE intent_id = ?",
        )
        .get("hard-cut-runtime-asset") as Record<string, unknown>;
      assert.equal(row["state"], "retryable");
      assert.equal(row["attempt_count"], 1);
      assert.match(String(row["last_error"]), /outside the workspace storage root/u);
    });
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("Retention runtime asset intents retain their URI and delete only verified in-root files", async () => {
  const fixture = createFixture("retention-runtime-asset");
  try {
    const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
    const assetDirectory = join(paths.workspace.root, "runtime-assets");
    const assetPath = join(assetDirectory, "asset.bin");
    const contents = Buffer.from("runtime asset", "utf8");
    const digest = createHash("sha256").update(contents).digest("hex");
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(assetPath, contents, { mode: 0o600 });
    insertRetentionIntent(
      paths.workspace.root,
      "retention-runtime-asset",
      "runtime_asset",
      digest,
      contents.byteLength,
      assetPath,
    );

    const result = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
    });
    assert.equal(result.completed, 1);
    assert.equal(existsSync(assetPath), false);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("Runtime asset GC rejects a symlink directory ancestor even when its target stays in-root", async () => {
  const fixture = createFixture("runtime-asset-symlink-parent");
  try {
    const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
    const realDirectory = join(paths.workspace.root, "real-runtime-assets");
    const linkedDirectory = join(paths.workspace.root, "runtime-assets");
    const contents = Buffer.from("runtime asset behind symlink", "utf8");
    const digest = createHash("sha256").update(contents).digest("hex");
    mkdirSync(realDirectory, { recursive: true });
    writeFileSync(join(realDirectory, "asset.bin"), contents, { mode: 0o600 });
    symlinkSync(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    insertHardCutIntent(
      paths.workspace.root,
      "hard-cut-runtime-asset-symlink-parent",
      "runtime_asset",
      digest,
      contents.byteLength,
      join(linkedDirectory, "asset.bin"),
    );

    const result = await runWorkspaceBlobGcOnce({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });
    assert.equal(result.retryable, 1);
    assert.equal(existsSync(join(realDirectory, "asset.bin")), true);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("Runtime asset directory witness rejects a replaced parent before unlink", async () => {
  const fixture = createFixture("runtime-asset-replaced-parent");
  try {
    const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
    const assetDirectory = join(paths.workspace.root, "runtime-assets");
    const displacedDirectory = join(paths.workspace.root, "runtime-assets-displaced");
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, "asset.bin"), "original", { mode: 0o600 });

    await assert.rejects(
      withVerifiedEvidenceDirectory(
        paths.workspace.root,
        ["runtime-assets"],
        { create: false },
        async (directory) => {
          const handle = await directory.openRegularFile("asset.bin", "Runtime asset GC target");
          try {
            renameSync(assetDirectory, displacedDirectory);
            mkdirSync(assetDirectory);
            writeFileSync(join(assetDirectory, "asset.bin"), "replacement", { mode: 0o600 });
            await directory.unlinkFile("asset.bin", handle, "Runtime asset GC target");
          } finally {
            await handle.close();
          }
        },
      ),
      /changed/u,
    );
    assert.equal(existsSync(join(displacedDirectory, "asset.bin")), true);
    assert.equal(existsSync(join(assetDirectory, "asset.bin")), true);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("Workspace Runtime drains more than one Blob GC batch without another event", async () => {
  const fixture = createFixture("runtime-drain");
  initializeGitWorkspace(fixture.workDir);
  const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
  for (let index = 0; index < 101; index++) {
    const digest = createHash("sha256").update(`missing-${index}`).digest("hex");
    insertRetentionIntent(
      paths.workspace.root,
      `retention-runtime-drain-${index}`,
      "runtime_asset",
      digest,
      0,
      join(paths.workspace.root, "runtime-assets", `missing-${index}`),
    );
  }
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: fixture.picoHome },
    execute: async () => undefined,
  });
  try {
    await service.getWorkspaceRuntime(fixture.workDir);
    await waitFor(() => countCompletedRetentionIntents(paths.workspace.root) === 101, 5_000);
    assert.equal(countCompletedRetentionIntents(paths.workspace.root), 101);
  } finally {
    await service.close();
    cleanupFixture(fixture.root);
  }
});

test("Workspace Runtime wakes a retryable Blob GC intent when its backoff expires", async () => {
  const fixture = createFixture("runtime-retry-wake");
  initializeGitWorkspace(fixture.workDir);
  const paths = resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome });
  const outsidePath = join(fixture.root, "outside.bin");
  const contents = Buffer.from("outside retry canary", "utf8");
  const digest = createHash("sha256").update(contents).digest("hex");
  writeFileSync(outsidePath, contents, { mode: 0o600 });
  insertHardCutIntent(
    paths.workspace.root,
    "hard-cut-runtime-retry-wake",
    "runtime_asset",
    digest,
    contents.byteLength,
    outsidePath,
  );
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: fixture.picoHome },
    execute: async () => undefined,
  });
  try {
    await service.getWorkspaceRuntime(fixture.workDir);
    await waitFor(
      () => hardCutAttemptCount(paths.workspace.root, "hard-cut-runtime-retry-wake") >= 2,
      5_000,
    );
    assert.equal(existsSync(outsidePath), true);
  } finally {
    await service.close();
    cleanupFixture(fixture.root);
  }
});

test("Workspace Runtime close clears a scheduled Blob GC wake timer", async () => {
  const fixture = createFixture("runtime-close-timer");
  initializeGitWorkspace(fixture.workDir);
  let calls = 0;
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: fixture.picoHome },
    execute: async () => undefined,
    runBlobGc: async () => {
      calls += 1;
      return {
        status: "completed",
        processed: 0,
        completed: 0,
        retryable: 0,
        hasMore: false,
        nextWakeAt: Date.now() + 60_000,
      };
    },
  });
  try {
    await service.getWorkspaceRuntime(fixture.workDir);
    await waitFor(() => scheduledBlobGcTimerCount(service) === 1, 2_000);
    await service.close();
    assert.equal(scheduledBlobGcTimerCount(service), 0);
    await delay(25);
    assert.equal(calls, 1);
  } finally {
    await service.close();
    cleanupFixture(fixture.root);
  }
});

function insertRetentionIntent(
  storageRoot: string,
  intentId: string,
  kind: "evidence" | "file_history" | "runtime_asset",
  digest: string,
  byteLength: number,
  storageUri?: string,
): void {
  withWorkspaceSqliteLease(storageRoot, (lease) => {
    lease.database
      .prepare(
        `INSERT INTO retention_gc_intents (
           intent_id, blob_kind, digest, byte_length, storage_uri, status, attempt_count,
           last_error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, 1, 1, NULL)`,
      )
      .run(intentId, kind, digest, byteLength, storageUri ?? null);
  });
}

function insertHardCutIntent(
  storageRoot: string,
  intentId: string,
  assetScope: "evidence_blob" | "file_history_blob" | "runtime_asset",
  digest: string,
  byteLength: number,
  storageUri?: string,
): void {
  withWorkspaceSqliteLease(storageRoot, (lease) => {
    const cutover = lease.database
      .prepare("SELECT cutover_id FROM event_log_epoch WHERE singleton_id = 1")
      .get() as Record<string, unknown>;
    lease.database
      .prepare(
        `INSERT INTO event_log_blob_gc_intents (
           intent_id, cutover_id, asset_scope, storage_uri, content_digest, byte_length,
           requires_reference_check, state, attempt_count, next_attempt_at, last_error,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
      )
      .run(
        intentId,
        String(cutover["cutover_id"]),
        assetScope,
        storageUri ?? null,
        digest,
        byteLength,
        assetScope === "runtime_asset" ? 0 : 1,
        "2026-08-24T00:00:00.000Z",
        "2026-08-24T00:00:00.000Z",
      );
  });
}

function initializeGitWorkspace(workDir: string): void {
  execFileSync("git", ["init", "--quiet", workDir], { stdio: "ignore" });
}

function countCompletedRetentionIntents(storageRoot: string): number {
  return withWorkspaceSqliteLease(storageRoot, (lease) => {
    const row = lease.database
      .prepare("SELECT COUNT(*) AS count FROM retention_gc_intents WHERE completed_at IS NOT NULL")
      .get() as Record<string, unknown>;
    return Number(row["count"]);
  });
}

function hardCutAttemptCount(storageRoot: string, intentId: string): number {
  return withWorkspaceSqliteLease(storageRoot, (lease) => {
    const row = lease.database
      .prepare("SELECT attempt_count FROM event_log_blob_gc_intents WHERE intent_id = ?")
      .get(intentId) as Record<string, unknown>;
    return Number(row["attempt_count"]);
  });
}

function scheduledBlobGcTimerCount(service: WorkspaceRuntimeService): number {
  return (
    service as unknown as {
      readonly blobGcTimers: ReadonlyMap<string, unknown>;
    }
  ).blobGcTimers.size;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Blob GC state");
    await delay(20);
  }
}

function createFixture(label: string): {
  readonly root: string;
  readonly picoHome: string;
  readonly workDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), `pico-blob-gc-${label}-`));
  const picoHome = join(root, "pico-home");
  const workDir = join(root, "workspace-a");
  mkdirSync(workDir, { recursive: true });
  return { root, picoHome, workDir };
}

function cleanupFixture(root: string): void {
  closeAllOperationalDatabasesForTest();
  rmSync(root, { recursive: true, force: true });
}
