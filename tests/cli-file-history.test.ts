import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Session } from "../src/engine/session.js";
import {
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
} from "../src/safety/file-history.js";
import {
  formatFileHistorySnapshots,
  listFileHistorySnapshotSummaries,
  rewindFileHistoryFromCli,
} from "../src/cli/file-history.js";

describe("CLI FileHistory 1.5.8", () => {
  let workDir: string;
  let session: Session;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-cli-rewind-"));
    session = new Session(`cli-rewind-${Date.now()}-${Math.random().toString(16).slice(2)}`, workDir, {
      persistence: false,
    });
  });

  afterEach(() => {
    session.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(join(homedir(), ".pico", "file-history", session.id), { recursive: true, force: true });
  });

  async function createSnapshot(messageId = "turn-1"): Promise<string> {
    const filePath = join(workDir, "file.txt");
    writeFileSync(filePath, "original\n");
    session.append({ role: "user", content: "改文件" });
    session.append({ role: "assistant", content: "已修改" });

    await fileHistoryTrackEdit(session.fileHistory, filePath, messageId, session.id);
    writeFileSync(filePath, "modified\n");
    await fileHistoryMakeSnapshot(
      session.fileHistory,
      messageId,
      session.id,
      undefined,
      session.length,
    );
    return filePath;
  }

  it("--list-snapshots 列出 messageId、timestamp、跟踪文件数和统计", async () => {
    await createSnapshot("turn-1");

    const summaries = listFileHistorySnapshotSummaries(session);
    const output = formatFileHistorySnapshots(session.id, summaries);

    expect(summaries).toEqual([
      expect.objectContaining({
        messageId: "turn-1",
        trackedFileCount: 1,
        backedUpFileCount: 1,
        deletedFileCount: 0,
      }),
    ]);
    expect(output).toContain("turn-1");
    expect(output).toContain("tracked=1");
    expect(output).toContain("backups=1");
    expect(output).toContain("timestamp=");
  });

  it("--list-snapshots 空快照时给出清晰提示并视为成功", () => {
    const output = formatFileHistorySnapshots(session.id, listFileHistorySnapshotSummaries(session));

    expect(output).toContain(`session ${session.id}`);
    expect(output).toContain("没有文件历史快照");
  });

  it("--rewind 无 messageId 时列出可选快照点", async () => {
    await createSnapshot("turn-1");

    const result = await rewindFileHistoryFromCli(session, undefined, "both");

    expect(result.changed).toBe(false);
    expect(result.output).toContain("可回滚快照");
    expect(result.output).toContain("turn-1");
  });

  it("--rewind <message-id> --rewind-mode code 只恢复文件", async () => {
    const filePath = await createSnapshot("turn-1");
    session.append({ role: "user", content: "继续聊" });
    session.append({ role: "assistant", content: "继续" });
    const beforeLength = session.length;

    const result = await rewindFileHistoryFromCli(session, "turn-1", "code");

    expect(result.changed).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("original\n");
    expect(session.length).toBe(beforeLength);
  });

  it("--rewind-mode code 支持缺少 messageIndex 的旧快照", async () => {
    const filePath = join(workDir, "legacy.txt");
    writeFileSync(filePath, "old\n");
    await fileHistoryTrackEdit(session.fileHistory, filePath, "legacy-snapshot", session.id);
    writeFileSync(filePath, "new\n");
    await fileHistoryMakeSnapshot(session.fileHistory, "legacy-snapshot", session.id);

    await rewindFileHistoryFromCli(session, "legacy-snapshot", "code");

    expect(readFileSync(filePath, "utf8")).toBe("old\n");
  });

  it("--rewind <message-id> --rewind-mode conversation 只截断对话", async () => {
    const filePath = await createSnapshot("turn-1");
    writeFileSync(filePath, "after snapshot\n");
    session.append({ role: "user", content: "继续聊" });
    session.append({ role: "assistant", content: "继续" });

    const result = await rewindFileHistoryFromCli(session, "turn-1", "conversation");

    expect(result.changed).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("after snapshot\n");
    expect(session.getHistory().map((msg) => msg.content)).toEqual(["改文件", "已修改"]);
  });

  it("--rewind <message-id> --rewind-mode both 同时恢复文件并截断对话", async () => {
    const filePath = await createSnapshot("turn-1");
    session.append({ role: "user", content: "继续聊" });
    session.append({ role: "assistant", content: "继续" });

    const result = await rewindFileHistoryFromCli(session, "turn-1", "both");

    expect(result.changed).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("original\n");
    expect(session.getHistory().map((msg) => msg.content)).toEqual(["改文件", "已修改"]);
  });

  it("--rewind both 回滚到新建文件快照时删除文件", async () => {
    const filePath = join(workDir, "new.txt");
    session.append({ role: "user", content: "新增文件" });
    session.append({ role: "assistant", content: "已新增" });

    await fileHistoryTrackEdit(session.fileHistory, filePath, "turn-1", session.id);
    writeFileSync(filePath, "created\n");
    await fileHistoryMakeSnapshot(
      session.fileHistory,
      "turn-1",
      session.id,
      undefined,
      session.length,
    );

    await rewindFileHistoryFromCli(session, "turn-1", "both");

    expect(existsSync(filePath)).toBe(false);
    expect(session.length).toBe(2);
  });
});
