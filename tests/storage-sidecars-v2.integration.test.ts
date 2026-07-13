import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactIntegrityError, ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { FileSessionSummaryStore } from "../src/memory/summary-store.js";
import {
  createFileHistoryState,
  fileHistoryLoadState,
  fileHistoryMakeSnapshot,
  fileHistoryPrepareRewind,
  fileHistoryRegisterRoot,
  fileHistoryTrackEdit,
  resolveBackupPath,
} from "../src/safety/file-history.js";
import { FileHistoryBlobStore } from "../src/storage/file-history-blob-store.js";
import { StorageOperationJournal } from "../src/storage/operation-journal.js";
import {
  RewindOperationCoordinator,
  type RewindWorkspaceTarget,
} from "../src/storage/rewind-operation-coordinator.js";

describe("storage sidecars v2 integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("publishes a strict CAS file-history manifest and safely migrates legacy v1", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-sidecar-file-history-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const baseDir = join(root, "file-history");
    const sourcePath = join(workspace, "src", "a.ts");
    const sessionId = "session-v2";
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "before\n");

    const state = createFileHistoryState();
    fileHistoryRegisterRoot(state, "workspace", workspace);
    await fileHistoryTrackEdit(state, sourcePath, "message-1", sessionId, baseDir);
    await writeFile(sourcePath, "after\n");
    await fileHistoryMakeSnapshot(state, "message-1", sessionId, baseDir, 0, {
      userPrompt: "edit a",
      sourceMessageEventId: "event-1",
      beforeSessionSeq: 4,
    });

    const manifestPath = resolveManifestPathForTest(baseDir, sessionId);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ schemaVersion: 2, revision: 1, sessionId });
    expect(manifest).toMatchObject({ roots: [{ rootId: "workspace", absolutePath: workspace }] });
    expect(JSON.stringify(manifest)).not.toContain(sourcePath);
    expect(JSON.stringify(manifest)).toContain('"sourceMessageEventId":"event-1"');
    expect(JSON.stringify(manifest)).toContain('"algorithm":"sha256"');

    const reloaded = createFileHistoryState();
    await expect(fileHistoryLoadState(reloaded, sessionId, baseDir)).resolves.toBe(true);
    expect(reloaded).toMatchObject({ revision: 1, storageStatus: "healthy" });
    await expect(
      fileHistoryPrepareRewind(reloaded, "message-1", sessionId, baseDir),
    ).resolves.toMatchObject({ messageId: "message-1", revision: 1 });

    const legacySessionId = "legacy-session";
    const legacyManifestPath = resolveManifestPathForTest(baseDir, legacySessionId);
    const legacySource = join(workspace, "legacy.txt");
    await writeFile(legacySource, "legacy-before\n");
    const legacyBackupName = "legacy@v1";
    const legacyBackupPath = resolveBackupPath(legacySessionId, legacyBackupName, baseDir);
    await mkdir(dirname(legacyBackupPath), { recursive: true });
    await writeFile(legacyBackupPath, "legacy-before\n");
    const now = new Date().toISOString();
    const legacyManifest = {
      snapshots: [
        {
          messageId: "legacy-message",
          trackedFileBackups: [
            [
              legacySource,
              {
                backupFileName: legacyBackupName,
                version: 1,
                backupTime: now,
                originMtimeMs: (await stat(legacySource)).mtimeMs,
                originSize: 14,
                originMode: 0o644,
              },
            ],
          ],
          timestamp: now,
          userPrompt: "legacy",
        },
      ],
      trackedFiles: [legacySource],
      snapshotSequence: 1,
      fileVersions: [[legacySource, 1]],
    };
    await writeFile(legacyManifestPath, `${JSON.stringify(legacyManifest)}\n`);
    const legacyState = createFileHistoryState();
    await fileHistoryLoadState(legacyState, legacySessionId, baseDir);
    expect(legacyState.storageStatus).toBe("legacy");
    await fileHistoryMakeSnapshot(legacyState, "legacy-message-2", legacySessionId, baseDir, 1, {
      userPrompt: "continue",
    });
    expect(JSON.parse(await readFile(legacyManifestPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      revision: 1,
    });
    expect(await readFile(`${legacyManifestPath}.v1.bak`, "utf8")).toBe(
      `${JSON.stringify(legacyManifest)}\n`,
    );

    const brokenSessionId = "legacy-broken";
    const brokenManifestPath = resolveManifestPathForTest(baseDir, brokenSessionId);
    const brokenManifest = structuredClone(legacyManifest);
    brokenManifest.snapshots[0]!.trackedFileBackups[0]![1]!.backupFileName = "missing@v1";
    await mkdir(dirname(brokenManifestPath), { recursive: true });
    const brokenRaw = `${JSON.stringify(brokenManifest)}\n`;
    await writeFile(brokenManifestPath, brokenRaw);
    const brokenState = createFileHistoryState();
    await fileHistoryLoadState(brokenState, brokenSessionId, baseDir);
    await expect(
      fileHistoryMakeSnapshot(brokenState, "legacy-broken-2", brokenSessionId, baseDir, 1, {
        userPrompt: "must not overwrite",
      }),
    ).rejects.toThrow("v1 迁移失败");
    expect(brokenState.storageStatus).toBe("degraded");
    expect(await readFile(brokenManifestPath, "utf8")).toBe(brokenRaw);
  });

  it("forward-reconciles a rewind and marks external workspace conflicts for attention", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-sidecar-rewind-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const sourcePath = join(workspace, "src", "a.ts");
    await mkdir(dirname(sourcePath), { recursive: true });
    const blobStore = new FileHistoryBlobStore({ baseDir: join(root, "file-history") });
    const before = await blobStore.put("before\n");
    const after = await blobStore.put("after\n");
    await writeFile(sourcePath, "after\n", { mode: 0o644 });
    await chmod(sourcePath, 0o644);
    const journal = new StorageOperationJournal({ workDir: workspace });
    const phases: string[] = [];
    let failSessionOnce = true;
    const callbacks = {
      resolveRoot: (rootId: string) => (rootId === "workspace" ? workspace : undefined),
      applyWorkspace: async (_operation: unknown, targets: readonly RewindWorkspaceTarget[]) => {
        phases.push("workspace");
        for (const target of targets) {
          if (target.state.kind === "missing") {
            await rm(target.absolutePath, { force: true });
          } else {
            await mkdir(dirname(target.absolutePath), { recursive: true });
            await writeFile(target.absolutePath, target.contents!);
            await chmod(target.absolutePath, target.state.mode);
          }
        }
      },
      commitSession: async () => {
        phases.push("session");
        if (failSessionOnce) {
          failSessionOnce = false;
          throw new Error("simulated host crash");
        }
      },
      commitSidecars: async () => {
        phases.push("sidecars");
      },
    };
    const coordinator = new RewindOperationCoordinator({ journal, blobStore, callbacks });
    const input = {
      operationId: "rewind-forward",
      kind: "rewind" as const,
      sessionId: "session-a",
      mode: "both" as const,
      precondition: {
        sessionLastSeq: 8,
        effectiveHistoryDigest: "history",
        fileHistoryRevision: 2,
      },
      target: { messageId: "message-a", messageIndex: 1 },
      files: [
        {
          rootId: "workspace",
          relativePath: "src/a.ts",
          before: {
            kind: "file" as const,
            blobSha256: before.ref.digest,
            sizeBytes: before.ref.sizeBytes,
            mode: 0o644,
          },
          after: {
            kind: "file" as const,
            blobSha256: after.ref.digest,
            sizeBytes: after.ref.sizeBytes,
            mode: 0o644,
          },
        },
      ],
    };

    await expect(coordinator.execute(input)).rejects.toThrow("simulated host crash");
    await expect(journal.get("rewind-forward")).resolves.toMatchObject({
      state: "workspace_applied",
    });
    await expect(coordinator.reconcileUnfinished()).resolves.toEqual([
      { operationId: "rewind-forward", state: "completed" },
    ]);
    expect(await readFile(sourcePath, "utf8")).toBe("before\n");
    expect(phases).toEqual(["workspace", "session", "session", "sidecars"]);

    await writeFile(sourcePath, "external\n");
    const conflict = await coordinator.execute({ ...input, operationId: "rewind-conflict" });
    expect(conflict).toMatchObject({
      state: "needs_attention",
      error: { conflictingPaths: [sourcePath] },
    });
  });

  it("stores per-session summary bases and artifact v2 commit metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-sidecar-summary-artifact-"));
    cleanup.push(root);
    const summaryIndex = join(root, ".claw", "memory", "summaries.json");
    const summaries = new FileSessionSummaryStore(summaryIndex);
    const basis = {
      throughEventId: "event-4",
      messageCount: 4,
      prefixDigest: createHash("sha256").update("prefix").digest("hex"),
    };
    summaries.save("session-a", "summary-a", 4, basis);
    const entries = await readdir(join(root, ".claw", "memory", "summaries"));
    expect(entries).toHaveLength(1);
    expect(new FileSessionSummaryStore(summaryIndex).get("session-a")).toMatchObject({ basis });
    expect(
      summaries.invalidateIfBeyond("session-a", {
        throughEventId: "event-2",
        messageCount: 2,
        prefixDigest: null,
      }),
    ).toBe(true);

    const artifacts = new ToolResultArtifactStore({ baseDir: join(root, ".claw", "artifacts") });
    const meta = await artifacts.write({
      id: "artifact-a",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "durable output",
    });
    expect(meta).toMatchObject({
      schemaVersion: 2,
      availability: "available",
      contentHash: createHash("sha256").update("durable output").digest("hex"),
    });
    await writeFile(meta.path, "corrupt");
    await expect(artifacts.read(meta)).rejects.toBeInstanceOf(ArtifactIntegrityError);
    await writeFile(meta.path, "durable output");
    await expect(artifacts.markEvicted(meta.id, meta.sessionId)).resolves.toMatchObject({
      availability: "evicted",
    });
    await expect(artifacts.read(meta.id)).resolves.toBeUndefined();
  });
});

function resolveManifestPathForTest(baseDir: string, sessionId: string): string {
  const sessionDirectory = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(baseDir, sessionDirectory, "manifest.json");
}
