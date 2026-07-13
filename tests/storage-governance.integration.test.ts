import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { createSessionIdentity } from "../src/engine/session-identity.js";
import { SessionStore } from "../src/engine/session-store.js";
import { FileSessionSummaryStore } from "../src/memory/summary-store.js";
import { ContentAddressedBlobGarbageCollector } from "../src/storage/blob-garbage-collector.js";
import { FileHistoryBlobStore } from "../src/storage/file-history-blob-store.js";
import {
  DEFAULT_STORAGE_RETENTION_POLICY,
  assertStorageRetentionPolicy,
} from "../src/storage/retention-policy.js";
import { StorageDoctor } from "../src/storage/storage-doctor.js";
import { RuntimeStore } from "../src/tasks/runtime-store.js";

describe("storage governance integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("scans healthy authoritative stores and v2 sidecars without mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-storage-doctor-healthy-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const fileHistoryDir = join(root, "file-history");
    const sessionPath = join(workDir, ".claw", "sessions", "session-a.jsonl");
    const sessionStore = new SessionStore(
      sessionPath,
      createSessionIdentity({ sessionId: "session-a", cwd: workDir }),
    );
    await sessionStore.commitMessage({ role: "user", content: "keep this durable" });
    await sessionStore.close();

    const runtime = new RuntimeStore({ workDir });
    runtime.close();

    const blobStore = new FileHistoryBlobStore({ baseDir: fileHistoryDir });
    const blob = await blobStore.put("before\n");
    await writeManifest(fileHistoryDir, "session-a", blob.ref.digest, blob.ref.sizeBytes);

    const summaryIndex = join(workDir, ".claw", "memory", "summaries.json");
    new FileSessionSummaryStore(summaryIndex).save("session-a", "summary", 1, {
      throughEventId: "event-1",
      messageCount: 1,
      prefixDigest: createHash("sha256").update("prefix").digest("hex"),
    });
    await new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
    }).write({
      id: "artifact-a",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "verified output",
    });

    const report = await new StorageDoctor({ workDir, fileHistoryDir }).scan();
    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.scanned).toMatchObject({
      session: 1,
      runtime: 1,
      file_history: 1,
      summary: 1,
      artifact: 1,
    });
    expect(() => assertStorageRetentionPolicy(DEFAULT_STORAGE_RETENTION_POLICY)).not.toThrow();
  });

  it("quarantines an explicitly selected bad derived sidecar without touching Session truth", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-storage-doctor-repair-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const sessionPath = join(workDir, ".claw", "sessions", "session-a.jsonl");
    const sessionStore = new SessionStore(
      sessionPath,
      createSessionIdentity({ sessionId: "session-a", cwd: workDir }),
    );
    await sessionStore.commitMessage({ role: "user", content: "authoritative" });
    await sessionStore.close();
    const before = await readFile(sessionPath);

    const badSummaryPath = join(
      workDir,
      ".claw",
      "memory",
      "summaries",
      `${createHash("sha256").update("session-a").digest("hex")}.json`,
    );
    await mkdir(dirname(badSummaryPath), { recursive: true });
    await writeFile(badSummaryPath, "{broken", "utf8");
    const doctor = new StorageDoctor({ workDir, fileHistoryDir: join(root, "file-history") });
    await expect(doctor.scan()).resolves.toMatchObject({
      healthy: false,
      findings: [expect.objectContaining({ code: "summary_malformed", authority: "derived" })],
    });

    const repaired = await doctor.repair({ quarantineMalformedSidecars: true });
    expect(repaired.quarantined).toHaveLength(1);
    await expect(readFile(sessionPath)).resolves.toEqual(before);
    await expect(new SessionStore(sessionPath).loadStrict()).resolves.toHaveLength(1);
    await expect(stat(repaired.quarantined[0]!.quarantinePath)).resolves.toBeDefined();
    await expect(doctor.scan()).resolves.toMatchObject({ healthy: true, findings: [] });
  });

  it("accepts a strictly replayable legacy Session and recommends non-destructive migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-storage-doctor-legacy-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const sessionPath = join(workDir, ".claw", "sessions", "legacy.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        seq: 0,
        message: { role: "user", content: "legacy but valid" },
      })}\n`,
      "utf8",
    );

    const report = await new StorageDoctor({
      workDir,
      fileHistoryDir: join(root, "file-history"),
    }).scan();
    expect(report).toMatchObject({
      healthy: true,
      findings: [
        expect.objectContaining({
          code: "session_legacy",
          severity: "warning",
          authority: "authoritative",
        }),
      ],
    });
  });

  it("keeps reachable blobs and only deletes old unreachable blobs after explicit apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-storage-gc-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const fileHistoryDir = join(root, "file-history");
    const blobs = new FileHistoryBlobStore({ baseDir: fileHistoryDir });
    const reachable = await blobs.put("reachable");
    const unreachable = await blobs.put("unreachable");
    await writeManifest(fileHistoryDir, "session-a", reachable.ref.digest, reachable.ref.sizeBytes);
    await utimes(reachable.path, new Date(0), new Date(0));
    await utimes(unreachable.path, new Date(0), new Date(0));

    const collector = new ContentAddressedBlobGarbageCollector({
      workDir,
      baseDir: fileHistoryDir,
      gracePeriodMs: 60_000,
      now: () => 120_000,
    });
    const dryRun = await collector.run();
    expect(dryRun).toMatchObject({
      dryRun: true,
      candidatePaths: [unreachable.path],
      deletedPaths: [],
    });
    expect(dryRun.reachableDigests).toContain(reachable.ref.digest);
    await expect(stat(reachable.path)).resolves.toBeDefined();
    await expect(stat(unreachable.path)).resolves.toBeDefined();

    const applied = await collector.run({ apply: true });
    expect(applied.deletedPaths).toEqual([unreachable.path]);
    await expect(stat(reachable.path)).resolves.toBeDefined();
    await expect(stat(unreachable.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks both dry-run and apply when authoritative references cannot be parsed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-storage-gc-blocked-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const fileHistoryDir = join(root, "file-history");
    const blobs = new FileHistoryBlobStore({ baseDir: fileHistoryDir });
    const oldBlob = await blobs.put("must remain while mark is uncertain");
    await utimes(oldBlob.path, new Date(0), new Date(0));
    const manifestPath = join(fileHistoryDir, "unknown-session", "manifest.json");
    const operationPath = join(workDir, ".claw", "storage-operations", "broken.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await mkdir(dirname(operationPath), { recursive: true });
    await writeFile(manifestPath, "{broken", "utf8");
    await writeFile(operationPath, "{broken", "utf8");
    const collector = new ContentAddressedBlobGarbageCollector({
      workDir,
      baseDir: fileHistoryDir,
      gracePeriodMs: 1,
      now: () => 120_000,
    });

    const dryRun = await collector.run();
    expect(dryRun).toMatchObject({
      dryRun: true,
      blocked: true,
      candidatePaths: [],
      deletedPaths: [],
      blockedReasons: [
        expect.objectContaining({ component: "file_history", path: manifestPath }),
        expect.objectContaining({ component: "operation", path: operationPath }),
      ],
    });
    const apply = await collector.run({ apply: true });
    expect(apply).toMatchObject({ dryRun: true, blocked: true, deletedPaths: [] });
    await expect(stat(oldBlob.path)).resolves.toBeDefined();
  });
});

async function writeManifest(
  fileHistoryDir: string,
  sessionId: string,
  digest: string,
  sizeBytes: number,
): Promise<void> {
  const sessionDirectory = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const path = join(fileHistoryDir, sessionDirectory, "manifest.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      sessionId,
      roots: [{ rootId: "workspace", absolutePath: join(fileHistoryDir, "workspace-root") }],
      snapshots: [
        {
          messageId: "message-1",
          sourceMessageEventId: "event-1",
          beforeSessionSeq: 0,
          trackedFileBackups: [
            {
              location: { rootId: "workspace", relativePath: "src/a.ts" },
              backup: {
                kind: "blob",
                blob: { algorithm: "sha256", digest, sizeBytes },
                version: 1,
                backupTime: "2026-07-13T00:00:00.000Z",
              },
            },
          ],
          timestamp: "2026-07-13T00:00:00.000Z",
        },
      ],
      trackedFiles: [],
      snapshotSequence: 1,
      fileVersions: [],
    })}\n`,
    "utf8",
  );
}
