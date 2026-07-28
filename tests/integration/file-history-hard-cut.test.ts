import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFileHistoryState,
  fileHistoryBeginRewindPoint,
  fileHistoryBindSourceEvent,
  fileHistoryLoadState,
  fileHistoryRegisterRoot,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";

function sessionDirectory(root: string, sessionId: string): string {
  return join(root, createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
}

test("File History writes and reloads only canonical v2 user-message checkpoints", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-history-current-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "file-history-current";
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  const state = createFileHistoryState();
  fileHistoryRegisterRoot(state, "workspace", workspace);
  await fileHistoryBeginRewindPoint(
    state,
    {
      messageId: "message-1",
      sourceMessageEventId: "user-message:message-1",
      beforeSessionSeq: 3,
      messageIndex: 2,
      userPrompt: "修改文件",
      transcriptIndex: 4,
    },
    sessionId,
    root,
  );
  fileHistoryBindSourceEvent(state, {
    messageId: "message-1",
    sourceMessageEventId: "user-message:message-1",
    beforeSessionSeq: 3,
  });

  const manifest = JSON.parse(
    await readFile(join(sessionDirectory(root, sessionId), "manifest.json"), "utf8"),
  ) as { snapshots: Array<Record<string, unknown>> };
  assert.deepEqual(manifest.snapshots[0], {
    messageId: "message-1",
    sourceMessageEventId: "user-message:message-1",
    beforeSessionSeq: 3,
    messageIndex: 2,
    userPrompt: "修改文件",
    trackedFileBackups: [],
    timestamp: manifest.snapshots[0]?.["timestamp"],
    transcriptIndex: 4,
    editedFilePaths: [],
  });

  const restored = createFileHistoryState();
  assert.equal(await fileHistoryLoadState(restored, sessionId, root), true);
  assert.equal(restored.snapshots[0]?.sourceMessageEventId, "user-message:message-1");
  assert.equal(restored.snapshots[0]?.beforeSessionSeq, 3);
  assert.equal(restored.snapshots[0]?.messageIndex, 2);
  assert.equal(restored.snapshots[0]?.userPrompt, "修改文件");
  assert.deepEqual([...restored.snapshots[0]!.editedFilePaths], []);

  await assert.rejects(
    fileHistoryTrackEdit(
      createFileHistoryState(),
      join(workspace, "orphan.txt"),
      "turn-1",
      "orphan-session",
      root,
    ),
    /找不到 canonical user rewind point/u,
  );
});

test("File History rejects v1 and v2 snapshots missing canonical user boundary metadata", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-history-hard-cut-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "file-history-hard-cut";
  const directory = sessionDirectory(root, sessionId);
  const manifestPath = join(directory, "manifest.json");
  const workspace = join(root, "workspace");
  await mkdir(directory, { recursive: true });
  await mkdir(workspace);

  const snapshot = {
    messageId: "message-1",
    sourceMessageEventId: "user-message:message-1",
    beforeSessionSeq: 0,
    messageIndex: 0,
    userPrompt: "current prompt",
    trackedFileBackups: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    editedFilePaths: [],
  };
  const canonical = {
    schemaVersion: 2,
    revision: 1,
    sessionId,
    roots: [{ rootId: "workspace", absolutePath: workspace }],
    snapshots: [snapshot],
    trackedFiles: [],
    snapshotSequence: 1,
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

  for (const field of [
    "sourceMessageEventId",
    "beforeSessionSeq",
    "messageIndex",
    "userPrompt",
    "editedFilePaths",
  ] as const) {
    const incomplete = { ...snapshot } as Record<string, unknown>;
    delete incomplete[field];
    await writeFile(manifestPath, `${JSON.stringify({ ...canonical, snapshots: [incomplete] })}\n`);
    await assert.rejects(
      fileHistoryLoadState(createFileHistoryState(), sessionId, root),
      new RegExp(`snapshots\\[0\\]\\.${field}`, "u"),
    );
  }

  for (const [field, value] of [
    ["sourceMessageEventId", null],
    ["beforeSessionSeq", null],
  ] as const) {
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        ...canonical,
        snapshots: [{ ...snapshot, [field]: value }],
      })}\n`,
    );
    await assert.rejects(
      fileHistoryLoadState(createFileHistoryState(), sessionId, root),
      new RegExp(`snapshots\\[0\\]\\.${field}`, "u"),
    );
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      ...canonical,
      snapshots: [{ ...snapshot, sourceMessageEventId: "user-message:another-message" }],
    })}\n`,
  );
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, root),
    /sourceMessageEventId 与 canonical 用户消息事件不匹配/u,
  );
});

test("File History rejects legacy backup names inside otherwise canonical v2 snapshots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-history-legacy-backup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "file-history-legacy-backup";
  const directory = sessionDirectory(root, sessionId);
  const manifestPath = join(directory, "manifest.json");
  const workspace = join(root, "workspace");
  await mkdir(directory, { recursive: true });
  await mkdir(workspace);
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      sessionId,
      roots: [{ rootId: "workspace", absolutePath: workspace }],
      snapshots: [
        {
          messageId: "message-1",
          sourceMessageEventId: "user-message:message-1",
          beforeSessionSeq: 0,
          messageIndex: 0,
          userPrompt: "current prompt",
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
          editedFilePaths: [],
        },
      ],
      trackedFiles: [],
      snapshotSequence: 1,
      fileVersions: [],
    })}\n`,
  );
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, root),
    /legacyBackupFileName 不再受支持/u,
  );
});
