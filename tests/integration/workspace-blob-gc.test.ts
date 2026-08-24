import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceBlobStore } from "../../src/context/evidence-blob-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
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
