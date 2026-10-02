import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ALL_WORKSPACE_SQLITE_SCOPES,
  withWorkspaceSqliteLease,
} from "../../../packages/storage/src/sqlite/workspace-scopes.js";
import { prepareWorkspaceSqliteStorageSync } from "../../../packages/storage/src/sqlite/sqlite-workspace-storage.js";
import { SqliteSessionWorkbarRepository } from "../../../packages/storage/src/sqlite/sqlite-session-workbar-repository.js";
import { coordinateEventLogHardCut } from "../../../packages/storage/src/event-log-hard-cut-coordinator.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const legacyScopes = ALL_WORKSPACE_SQLITE_SCOPES.map((scope) =>
  scope.name === "workbar"
    ? { ...scope, migrations: new Map([...scope.migrations].filter(([version]) => version === 1)) }
    : scope,
);

test("旧 BLOB 库迁移为可恢复文件存储，重开、续传、去重和会话归属不变", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-artifact-files-"));
  try {
    const bytes = Buffer.from("legacy image/video bytes\0\xff".repeat(3000));
    const digest = hash(bytes);
    const old = prepareWorkspaceSqliteStorageSync(root, legacyScopes);
    coordinateEventLogHardCut(old.lease.database);
    old.lease.database.exec(
      "INSERT INTO sessions(session_id,work_dir,created_at,updated_at) VALUES ('chat','/work','2026','2026'),('other','/work','2026','2026')",
    );
    old.lease.database
      .prepare("INSERT INTO artifact_blobs(digest,size_bytes,content,created_at) VALUES (?,?,?,1)")
      .run(digest, bytes.length, bytes);
    old.lease.database
      .prepare(
        "INSERT INTO session_artifacts(artifact_id,session_id,title,mime_type,digest,size_bytes,created_at,updated_at) VALUES ('legacy','chat','image.png','image/png',?,?,1,1)",
      )
      .run(digest, bytes.length);
    old.lease.database
      .prepare(
        "INSERT INTO session_artifact_ingests(ingest_id,artifact_id,session_id,title,mime_type,content,created_at,updated_at) VALUES ('pending','continued','chat','video.webm','video/webm',?,1,1)",
      )
      .run(bytes.subarray(0, 32000));
    old.lease.release();

    const repository = new SqliteSessionWorkbarRepository({ storageRoot: root });
    const chunk = repository.readArtifactChunk({
      sessionId: "chat",
      artifactId: "legacy",
      offsetBytes: 19000,
      limitBytes: 32,
    });
    assert.deepEqual(Buffer.from(chunk.contentBase64, "base64"), bytes.subarray(19000, 19032));
    const backup = new DatabaseSync(join(root, "pico.sqlite.artifacts-v1.bak"), { readOnly: true });
    try {
      assert.deepEqual(
        Buffer.from(
          backup.prepare("SELECT content FROM artifact_blobs").get()!.content as Uint8Array,
        ),
        bytes,
      );
      assert.equal(
        backup
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope='workbar'")
          .get()!.version,
        1,
      );
    } finally {
      backup.close();
    }
    repository.abortArtifact({ sessionId: "other", ingestId: "pending" });
    withWorkspaceSqliteLease(root, ({ database }) => {
      for (const table of ["artifact_blobs", "session_artifact_ingests"])
        assert.ok(
          database
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .every((column) => column.type !== "BLOB"),
        );
      const blob = database
        .prepare("SELECT relative_path FROM artifact_blobs WHERE digest=?")
        .get(digest)!;
      assert.deepEqual(readFileSync(join(root, blob.relative_path as string)), bytes);
      const pending = database
        .prepare("SELECT relative_path FROM session_artifact_ingests WHERE ingest_id='pending'")
        .get()!;
      appendFileSync(join(root, pending.relative_path as string), "uncommitted crash tail");
    });
    repository.appendArtifactChunk({
      sessionId: "chat",
      ingestId: "pending",
      offsetBytes: 32000,
      content: bytes.subarray(32000, 64000),
    });
    repository.appendArtifactChunk({
      sessionId: "chat",
      ingestId: "pending",
      offsetBytes: 64000,
      content: bytes.subarray(64000),
    });
    const committed = repository.commitArtifact({
      sessionId: "chat",
      ingestId: "pending",
      expectedRevision: 0,
      idempotencyKey: "commit",
      expectedDigest: digest,
      expectedSizeBytes: bytes.length,
    });
    assert.equal(committed.artifact.digest, digest);
    assert.deepEqual(
      repository.commitArtifact({
        sessionId: "chat",
        ingestId: "pending",
        expectedRevision: 0,
        idempotencyKey: "commit",
        expectedDigest: digest,
        expectedSizeBytes: bytes.length,
      }),
      committed,
    );
    assert.throws(() => repository.readArtifactChunk({ sessionId: "other", artifactId: "legacy" }));
    withWorkspaceSqliteLease(root, ({ database }) =>
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM artifact_blobs").get()!.count,
        1,
      ),
    );
    assert.equal(
      new SqliteSessionWorkbarRepository({ storageRoot: root }).queryArtifacts({
        sessionId: "chat",
      }).artifacts.length,
      2,
    );

    const file = join(root, `artifacts/blobs/${digest.slice(0, 2)}/${digest}`);
    unlinkSync(file);
    const external = join(root, "outside.txt");
    appendFileSync(external, bytes);
    symlinkSync(external, file);
    assert.throws(
      () => repository.readArtifactChunk({ sessionId: "chat", artifactId: "legacy" }),
      "symlink content must never be followed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("损坏的旧媒体拒绝迁移，保留原库和升级前备份", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-artifact-invalid-"));
  try {
    const old = prepareWorkspaceSqliteStorageSync(root, legacyScopes);
    old.lease.database
      .prepare("INSERT INTO artifact_blobs(digest,size_bytes,content,created_at) VALUES (?,?,?,1)")
      .run("0".repeat(64), 3, Buffer.from("bad"));
    old.lease.release();
    assert.throws(
      () =>
        new SqliteSessionWorkbarRepository({ storageRoot: root }).queryArtifacts({
          sessionId: "chat",
        }),
      /digest mismatch/u,
    );
    assert.ok(existsSync(join(root, "pico.sqlite.artifacts-v1.bak")));
    const database = new DatabaseSync(join(root, "pico.sqlite"), { readOnly: true });
    try {
      assert.equal(
        database
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope='workbar'")
          .get()!.version,
        1,
      );
      assert.deepEqual(
        Buffer.from(
          database.prepare("SELECT content FROM artifact_blobs").get()!.content as Uint8Array,
        ),
        Buffer.from("bad"),
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
