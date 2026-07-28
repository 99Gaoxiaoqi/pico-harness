import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileHistoryState, fileHistoryLoadState } from "../../src/safety/file-history.js";

test("File History accepts only canonical v2 manifests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-history-hard-cut-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "file-history-hard-cut";
  const sessionDirectory = join(
    root,
    createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
  );
  const manifestPath = join(sessionDirectory, "manifest.json");
  const workspace = join(root, "workspace");
  await mkdir(sessionDirectory, { recursive: true });
  await mkdir(workspace);

  const canonical = {
    schemaVersion: 2,
    revision: 1,
    sessionId,
    roots: [{ rootId: "workspace", absolutePath: workspace }],
    snapshots: [],
    trackedFiles: [],
    snapshotSequence: 0,
    fileVersions: [],
  };
  await writeFile(manifestPath, `${JSON.stringify(canonical)}\n`);
  assert.equal(await fileHistoryLoadState(createFileHistoryState(), sessionId, root), true);

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      snapshots: [],
      trackedFiles: [],
      snapshotSequence: 0,
      fileVersions: [],
    })}\n`,
  );
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, root),
    /schemaVersion 不支持/u,
  );

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      ...canonical,
      snapshots: [
        {
          messageId: "message-1",
          sourceMessageEventId: null,
          beforeSessionSeq: null,
          trackedFileBackups: [
            {
              location: { rootId: "workspace", relativePath: "file.txt" },
              backup: {
                kind: "blob",
                blob: { algorithm: "sha256", digest: "a".repeat(64), sizeBytes: 1 },
                legacyBackupFileName: "legacy@v1",
                version: 1,
                backupTime: "2026-01-01T00:00:00.000Z",
              },
            },
          ],
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    })}\n`,
  );
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, root),
    /legacyBackupFileName 不再受支持/u,
  );
});
