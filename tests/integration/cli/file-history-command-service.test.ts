import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertFileHistoryCliFlags,
  formatFileHistorySnapshots,
  listFileHistorySnapshotSummaries,
  listRewindPointSummaries,
  parseRewindMode,
  rewindFileHistoryFromCli,
  type FileHistoryForkSessionPort,
} from "@pico/pico-host/file-history";
import { defaultCliSessionId as legacyDefaultCliSessionId } from "@pico/pico-host/file-history";

function createSession(): FileHistoryForkSessionPort<{ readonly kind: "fork-runtime" }> {
  return {
    id: "session-a",
    fileHistory: {
      snapshots: [
        {
          messageId: "checkpoint-a",
          timestamp: new Date("2026-09-14T00:00:00.000Z"),
          userPrompt: "重构 package 边界",
          messageIndex: 4,
          transcriptIndex: 7,
          collaborationMode: "agent",
          permissionMode: "ask",
          editedFilePaths: new Set(["src/a.ts", "src/b.ts"]),
          trackedFileBackups: new Map([
            ["src/a.ts", { backupFileName: "a.backup" }],
            ["src/b.ts", { backupFileName: null }],
          ]),
          journalWarnings: ["additional root was not captured"],
        },
      ],
    },
    async getRewindPointChangeStat(messageId) {
      assert.equal(messageId, "checkpoint-a");
      return {
        changedFileCount: 3,
        addedLines: 12,
        removedLines: 5,
        files: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }],
        incomplete: true,
        warnings: ["additional root was not captured"],
      };
    },
    async forkFromCheckpoint(checkpointId, mode, runtimePort, createTargetSessionId) {
      assert.equal(checkpointId, "checkpoint-a");
      assert.equal(mode, "both");
      assert.deepEqual(runtimePort, { kind: "fork-runtime" });
      return { targetSessionId: createTargetSessionId() };
    },
  };
}

test("file-history command service projects checkpoints through its host port", async () => {
  const session = createSession();
  const summaries = listFileHistorySnapshotSummaries(session);
  assert.deepEqual(summaries, [
    {
      messageId: "checkpoint-a",
      timestamp: "2026-09-14T00:00:00.000Z",
      userPrompt: "重构 package 边界",
      changedFileCount: 2,
      backedUpFileCount: 1,
      deletedFileCount: 1,
      changeSummary: "1 个文件有备份, 1 个文件将在 rewind 时删除",
      messageIndex: 4,
      transcriptIndex: 7,
      collaborationMode: "agent",
      permissionMode: "ask",
      incomplete: true,
      warnings: ["additional root was not captured"],
    },
  ]);

  const rewindPoints = await listRewindPointSummaries(session);
  assert.deepEqual(rewindPoints[0], {
    ...summaries[0],
    changedFileCount: 3,
    addedLines: 12,
    removedLines: 5,
    changedFiles: ["src/a.ts", "src/b.ts"],
    incomplete: true,
    warnings: ["additional root was not captured"],
  });
  assert.match(formatFileHistorySnapshots(session.id, rewindPoints), /coverage=incomplete/);
});

test("file-history command service keeps non-destructive fork and legacy export behavior", async () => {
  const session = createSession();
  const result = await rewindFileHistoryFromCli(session, "checkpoint-a", "both", {
    kind: "fork-runtime",
  });
  assert.equal(result.changed, true);
  assert.match(result.output, /已从 checkpoint fork 新 session cli-rewind:/);
  assert.match(result.output, /原 session session-a 未改动/);

  assert.equal(parseRewindMode(undefined), "both");
  assert.equal(parseRewindMode("code"), "code");
  assert.throws(() => parseRewindMode("destroy"), /不支持的 rewind mode/);
  assert.throws(
    () => assertFileHistoryCliFlags({ listSnapshots: true, rewind: true }),
    /不能和 --rewind 同时使用/,
  );
  assert.equal(legacyDefaultCliSessionId("/workspace"), "console:/workspace");
});
