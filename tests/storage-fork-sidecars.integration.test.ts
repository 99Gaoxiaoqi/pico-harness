import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactCloneConflictError,
  ArtifactIntegrityError,
  ToolResultArtifactStore,
} from "../src/context/artifact-store.js";
import {
  FileSessionSummaryStore,
  SummaryCloneConflictError,
  SummaryIntegrityError,
} from "../src/memory/summary-store.js";
import {
  createFileHistoryState,
  FileHistoryCloneConflictError,
  FileHistoryDegradedError,
  fileHistoryCloneSession,
  fileHistoryLoadState,
  fileHistoryMakeSnapshot,
  fileHistoryRegisterRoot,
  fileHistoryTrackEdit,
  resolveBackupPath,
} from "../src/safety/file-history.js";

describe("fork sidecar clone integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("atomically clones File History, Summary and Artifact sidecars idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-fork-sidecars-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const fileHistoryDir = join(root, "file-history");
    const summaryIndex = join(root, ".claw", "memory", "summaries.json");
    const artifactDir = join(root, ".claw", "artifacts");
    const sourceSessionId = "source/session";
    const targetSessionId = "target/session";
    const sourceFile = join(workspace, "src", "a.ts");
    await mkdir(dirname(sourceFile), { recursive: true });
    await writeFile(sourceFile, "before\n");

    const sourceHistory = createFileHistoryState();
    fileHistoryRegisterRoot(sourceHistory, "workspace", workspace);
    await fileHistoryTrackEdit(
      sourceHistory,
      sourceFile,
      "message-1",
      sourceSessionId,
      fileHistoryDir,
    );
    await writeFile(sourceFile, "after\n");
    await fileHistoryMakeSnapshot(sourceHistory, "message-1", sourceSessionId, fileHistoryDir, 0, {
      userPrompt: "edit",
      sourceMessageEventId: "event-1",
      beforeSessionSeq: 1,
    });
    const sourceManifestPath = manifestPath(fileHistoryDir, sourceSessionId);
    const sourceManifestBefore = await readFile(sourceManifestPath, "utf8");

    const summaries = new FileSessionSummaryStore(summaryIndex);
    const basis = {
      throughEventId: "event-1",
      messageCount: 1,
      prefixDigest: createHash("sha256").update("prefix").digest("hex"),
    };
    summaries.save(sourceSessionId, "source summary", 1, basis);

    const artifacts = new ToolResultArtifactStore({ baseDir: artifactDir });
    const sourceArtifact = await artifacts.write({
      id: "artifact-a",
      sessionId: sourceSessionId,
      toolName: "bash",
      args: { command: "build" },
      output: "durable artifact",
    });

    const firstHistory = await fileHistoryCloneSession(
      sourceSessionId,
      targetSessionId,
      fileHistoryDir,
    );
    const firstSummary = summaries.cloneSession(sourceSessionId, targetSessionId);
    const firstArtifacts = await artifacts.cloneSession(sourceSessionId, targetSessionId);
    expect(firstHistory).toMatchObject({ created: true, blobCount: 1 });
    expect(firstSummary).toMatchObject({ created: true, summary: { basis } });
    expect(firstArtifacts.mappings).toHaveLength(1);
    expect(firstArtifacts.mappings[0]).toMatchObject({
      sourceId: "artifact-a",
      sourcePath: sourceArtifact.path,
      targetId: "artifact-a",
      created: true,
      targetMeta: {
        sessionId: targetSessionId,
        safeSessionId: expect.not.stringMatching(sourceArtifact.safeSessionId),
      },
    });

    const targetArtifact = firstArtifacts.mappings[0]!.targetMeta;
    expect(targetArtifact.path).toBe(firstArtifacts.mappings[0]!.targetPath);
    expect(await artifacts.read(targetArtifact)).toBe("durable artifact");
    const sourceStat = await stat(sourceArtifact.path);
    const targetStat = await stat(targetArtifact.path);
    expect({ dev: targetStat.dev, ino: targetStat.ino }).toEqual({
      dev: sourceStat.dev,
      ino: sourceStat.ino,
    });

    const targetHistory = createFileHistoryState();
    await expect(
      fileHistoryLoadState(targetHistory, targetSessionId, fileHistoryDir),
    ).resolves.toBe(true);
    expect(targetHistory.snapshots[0]?.trackedFileBackups.get(sourceFile)?.blobRef).toEqual(
      sourceHistory.snapshots[0]?.trackedFileBackups.get(sourceFile)?.blobRef,
    );
    expect(new FileSessionSummaryStore(summaryIndex).get(targetSessionId)).toMatchObject({
      sessionId: targetSessionId,
      summary: "source summary",
      basis,
    });

    const secondHistory = await fileHistoryCloneSession(
      sourceSessionId,
      targetSessionId,
      fileHistoryDir,
    );
    const secondSummary = summaries.cloneSession(sourceSessionId, targetSessionId);
    const secondArtifacts = await artifacts.cloneSession(sourceSessionId, targetSessionId);
    expect(secondHistory.created).toBe(false);
    expect(secondSummary.created).toBe(false);
    expect(secondArtifacts.mappings[0]?.created).toBe(false);
    expect(await readFile(sourceManifestPath, "utf8")).toBe(sourceManifestBefore);

    const conflictHistoryId = "history-conflict";
    const conflictHistory = createFileHistoryState();
    fileHistoryRegisterRoot(conflictHistory, "workspace", workspace);
    await fileHistoryMakeSnapshot(
      conflictHistory,
      "different-message",
      conflictHistoryId,
      fileHistoryDir,
      0,
      { userPrompt: "different" },
    );
    await expect(
      fileHistoryCloneSession(sourceSessionId, conflictHistoryId, fileHistoryDir),
    ).rejects.toBeInstanceOf(FileHistoryCloneConflictError);

    const legacySourceId = "legacy-source";
    const legacyTargetId = "legacy-target";
    const legacyBackupName = "legacy@v1";
    const legacyBackupPath = resolveBackupPath(legacySourceId, legacyBackupName, fileHistoryDir);
    await mkdir(dirname(legacyBackupPath), { recursive: true });
    await writeFile(legacyBackupPath, "legacy\n");
    const legacyManifest = legacyFileHistoryManifest(
      sourceFile,
      legacyBackupName,
      (await stat(legacyBackupPath)).size,
    );
    await writeFile(
      manifestPath(fileHistoryDir, legacySourceId),
      `${JSON.stringify(legacyManifest)}\n`,
    );
    await expect(
      fileHistoryCloneSession(legacySourceId, legacyTargetId, fileHistoryDir),
    ).resolves.toMatchObject({ created: true, migratedLegacySource: true, blobCount: 1 });
    expect(
      JSON.parse(await readFile(manifestPath(fileHistoryDir, legacySourceId), "utf8")),
    ).toMatchObject({ schemaVersion: 2, sessionId: legacySourceId });

    const brokenLegacyId = "legacy-broken";
    await mkdir(dirname(manifestPath(fileHistoryDir, brokenLegacyId)), { recursive: true });
    await writeFile(
      manifestPath(fileHistoryDir, brokenLegacyId),
      `${JSON.stringify(legacyFileHistoryManifest(sourceFile, "missing@v1", 7))}\n`,
    );
    await expect(
      fileHistoryCloneSession(brokenLegacyId, "legacy-broken-target", fileHistoryDir),
    ).rejects.toBeInstanceOf(FileHistoryDegradedError);

    const conflictSummaryId = "summary-conflict";
    summaries.save(conflictSummaryId, "different summary", 0);
    expect(() => summaries.cloneSession(sourceSessionId, conflictSummaryId)).toThrow(
      SummaryCloneConflictError,
    );
    const brokenSummaryId = "summary-broken";
    summaries.save(brokenSummaryId, "will be corrupt", 0);
    await writeFile(summaryPath(summaryIndex, brokenSummaryId), "{broken");
    expect(() => summaries.cloneSession(brokenSummaryId, "summary-broken-target")).toThrow(
      SummaryIntegrityError,
    );
    const legacySummaryIndex = join(root, ".claw", "legacy-memory", "summaries.json");
    await mkdir(dirname(legacySummaryIndex), { recursive: true });
    await writeFile(
      legacySummaryIndex,
      `${JSON.stringify({
        version: 1,
        summaries: {
          "legacy-summary-source": {
            sessionId: "legacy-summary-source",
            summary: "legacy summary",
            messageCount: 2,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      })}\n`,
    );
    const legacySummaries = new FileSessionSummaryStore(legacySummaryIndex);
    expect(
      legacySummaries.cloneSession("legacy-summary-source", "legacy-summary-target"),
    ).toMatchObject({
      created: true,
      summary: {
        sessionId: "legacy-summary-target",
        basis: { throughEventId: null, messageCount: 2, prefixDigest: null },
      },
    });
    expect(legacySummaries.get("legacy-summary-source")).toMatchObject({
      basis: { throughEventId: null, messageCount: 2, prefixDigest: null },
    });

    const conflictArtifactId = "artifact-conflict";
    await artifacts.write({
      id: "artifact-a",
      sessionId: conflictArtifactId,
      toolName: "bash",
      args: { command: "different" },
      output: "different artifact",
    });
    await expect(
      artifacts.cloneSession(sourceSessionId, conflictArtifactId),
    ).rejects.toBeInstanceOf(ArtifactCloneConflictError);
    const brokenArtifact = await artifacts.write({
      id: "artifact-broken",
      sessionId: "artifact-broken-source",
      toolName: "bash",
      args: {},
      output: "valid before corruption",
    });
    await writeFile(brokenArtifact.path, "corrupt");
    await expect(
      artifacts.cloneSession("artifact-broken-source", "artifact-broken-target"),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);

    await artifacts.deleteSessionArtifacts(sourceSessionId);
    expect(await artifacts.read(targetArtifact)).toBe("durable artifact");
  });
});

function manifestPath(baseDir: string, sessionId: string): string {
  const directory = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(baseDir, directory, "manifest.json");
}

function summaryPath(indexPath: string, sessionId: string): string {
  const directory = join(dirname(indexPath), "summaries");
  const name = createHash("sha256").update(sessionId).digest("hex");
  return join(directory, `${name}.json`);
}

function legacyFileHistoryManifest(
  sourcePath: string,
  backupFileName: string,
  size: number,
): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    snapshots: [
      {
        messageId: "legacy-message",
        trackedFileBackups: [
          [
            sourcePath,
            {
              backupFileName,
              version: 1,
              backupTime: timestamp,
              originSize: size,
              originMode: 0o600,
            },
          ],
        ],
        timestamp,
        userPrompt: "legacy",
      },
    ],
    trackedFiles: [sourcePath],
    snapshotSequence: 1,
    fileVersions: [[sourcePath, 1]],
  };
}
