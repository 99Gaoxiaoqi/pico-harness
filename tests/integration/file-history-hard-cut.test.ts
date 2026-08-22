import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createFileHistoryState,
  type FileHistoryIo,
  fileHistoryBeginRewindPoint,
  fileHistoryBindSourceEvent,
  fileHistoryLoadState,
  fileHistoryRegisterRoot,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";
import { readFileHistoryManifestRow } from "../../src/storage/sqlite/file-history-manifest-store.js";

interface FileHistoryFixture {
  readonly root: string;
  readonly baseDir: string;
  readonly storageRoot: string;
  readonly io: FileHistoryIo;
  readonly workspace: string;
}

async function fileHistoryFixture(
  context: TestContext,
  prefix: string,
): Promise<FileHistoryFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const baseDir = join(root, "file-history");
  const storageRoot = join(root, "workspace-storage");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, baseDir, storageRoot, workspace, io: { baseDir, storageRoot } };
}

/** 直连 pico.sqlite 篡改行,等价旧测试里手写畸形 manifest.json。 */
function tamperSnapshotRow(
  fixture: FileHistoryFixture,
  sessionId: string,
  rewrite: (snapshotJson: string) => string,
): void {
  const database = new DatabaseSync(join(fixture.storageRoot, "pico.sqlite"));
  try {
    const rows = database
      .prepare("SELECT ordinal, snapshot_json FROM file_history_snapshots WHERE session_id = ?")
      .all(sessionId) as Array<{ ordinal: number; snapshot_json: string }>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      database
        .prepare(
          "UPDATE file_history_snapshots SET snapshot_json = ? WHERE session_id = ? AND ordinal = ?",
        )
        .run(rewrite(row.snapshot_json), sessionId, row.ordinal);
    }
  } finally {
    database.close();
  }
}

function tamperStateJson(fixture: FileHistoryFixture, sessionId: string, stateJson: string): void {
  const database = new DatabaseSync(join(fixture.storageRoot, "pico.sqlite"));
  try {
    database
      .prepare("UPDATE file_history SET state_json = ? WHERE session_id = ?")
      .run(stateJson, sessionId);
  } finally {
    database.close();
  }
}

test("File History writes manifest rows and no manifest.json; reload restores checkpoints", async (context) => {
  const fixture = await fileHistoryFixture(context, "pico-file-history-current-");
  const sessionId = "file-history-current";

  const state = createFileHistoryState();
  fileHistoryRegisterRoot(state, "workspace", fixture.workspace);
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
    fixture.io,
  );
  fileHistoryBindSourceEvent(state, {
    messageId: "message-1",
    sourceMessageEventId: "user-message:message-1",
    beforeSessionSeq: 3,
  });

  // 票 08:manifest 不再是 PICO_HOME 下的 JSON 文件,拆行进 workspace pico.sqlite。
  const row = readFileHistoryManifestRow(fixture.storageRoot, sessionId);
  assert.ok(row, "manifest 行必须落库");
  assert.equal(row.revision, 1);
  assert.equal(row.snapshotSequence, 1);
  assert.equal(row.snapshots.length, 1);
  const snapshotRow = row.snapshots[0]!;
  assert.equal(snapshotRow.messageId, "message-1");
  assert.equal(snapshotRow.beforeSessionSeq, 3);
  const snapshotDetail = JSON.parse(snapshotRow.snapshotJson) as {
    transcriptIndex?: number;
  };
  assert.equal(snapshotDetail.transcriptIndex, 4);

  const restored = createFileHistoryState();
  assert.equal(await fileHistoryLoadState(restored, sessionId, fixture.io), true);
  assert.equal(restored.snapshots[0]?.sourceMessageEventId, "user-message:message-1");
  assert.equal(restored.snapshots[0]?.beforeSessionSeq, 3);
  assert.equal(restored.snapshots[0]?.messageIndex, 2);
  assert.equal(restored.snapshots[0]?.userPrompt, "修改文件");
  assert.deepEqual([...restored.snapshots[0]!.editedFilePaths], []);

  // 不存在的会话:无行即 false,不抛。
  assert.equal(
    await fileHistoryLoadState(createFileHistoryState(), "missing-session", fixture.io),
    false,
  );

  await assert.rejects(
    fileHistoryTrackEdit(
      createFileHistoryState(),
      join(fixture.workspace, "orphan.txt"),
      "turn-1",
      "orphan-session",
      fixture.io,
    ),
    /找不到 canonical user rewind point/u,
  );
});

test("File History rejects corrupted manifest rows (missing canonical boundary metadata)", async (context) => {
  const fixture = await fileHistoryFixture(context, "pico-file-history-hard-cut-");
  const sessionId = "file-history-hard-cut";

  const state = createFileHistoryState();
  fileHistoryRegisterRoot(state, "workspace", fixture.workspace);
  await fileHistoryBeginRewindPoint(
    state,
    {
      messageId: "message-1",
      sourceMessageEventId: "user-message:message-1",
      beforeSessionSeq: 0,
      messageIndex: 0,
      userPrompt: "current prompt",
    },
    sessionId,
    fixture.io,
  );

  // 基线:合法行可加载。
  assert.equal(await fileHistoryLoadState(createFileHistoryState(), sessionId, fixture.io), true);

  // state_json 非 JSON → 降级。
  tamperStateJson(fixture, sessionId, "not-json");
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, fixture.io),
    FileHistoryDegradedErrorCtor(),
  );

  // 重建快照缺字段 → parse 拒绝(错误信息与 JSONL 纪元同源)。
  for (const field of [
    "sourceMessageEventId",
    "beforeSessionSeq",
    "messageIndex",
    "userPrompt",
    "editedFilePaths",
  ] as const) {
    await fileHistoryBeginRewindPoint(
      state,
      {
        messageId: `message-${field}`,
        sourceMessageEventId: `user-message:message-${field}`,
        beforeSessionSeq: 1,
        messageIndex: 1,
        userPrompt: "current prompt",
      },
      sessionId,
      fixture.io,
    );
  }
  tamperSnapshotRow(fixture, sessionId, (snapshotJson) => {
    const parsed = JSON.parse(snapshotJson) as Record<string, unknown>;
    const damaged = { ...parsed };
    delete damaged["editedFilePaths"];
    return JSON.stringify(damaged);
  });
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, fixture.io),
    /editedFilePaths/u,
  );
});

test("File History rejects legacy backup names inside otherwise canonical v2 snapshots", async (context) => {
  const fixture = await fileHistoryFixture(context, "pico-file-history-legacy-backup-");
  const sessionId = "file-history-legacy-backup";

  const state = createFileHistoryState();
  fileHistoryRegisterRoot(state, "workspace", fixture.workspace);
  await fileHistoryBeginRewindPoint(
    state,
    {
      messageId: "message-1",
      sourceMessageEventId: "user-message:message-1",
      beforeSessionSeq: 0,
      messageIndex: 0,
      userPrompt: "current prompt",
    },
    sessionId,
    fixture.io,
  );
  tamperSnapshotRow(fixture, sessionId, () =>
    JSON.stringify({
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
      editedFilePaths: [],
    }),
  );
  await assert.rejects(
    fileHistoryLoadState(createFileHistoryState(), sessionId, fixture.io),
    /legacyBackupFileName 不再受支持/u,
  );
});

/** FileHistoryDegradedError 构造断言(避免 import 类型以外的耦合)。 */
function FileHistoryDegradedErrorCtor(): RegExp {
  return /File History manifest 无效|not-json/u;
}
