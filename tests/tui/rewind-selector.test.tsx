import { describe, expect, it } from "vitest";
import {
  formatRewindSelector,
  formatRewindUsage,
  latestSnapshotMessageId,
} from "../../src/tui/rewind-selector.js";

describe("RewindSelector", () => {
  it("展示当前 session 的可回滚点和变更摘要", () => {
    const output = formatRewindSelector("session-1", [
      {
        messageId: "turn-1",
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 2,
        backedUpFileCount: 1,
        deletedFileCount: 1,
        messageIndex: 4,
        changeSummary: "1 个文件有备份, 1 个文件将在 rewind 时删除",
      },
    ]);

    expect(output).toContain("session-1");
    expect(output).toContain("turn-1");
    expect(output).toContain("time=2026-07-09T01:02:03.000Z");
    expect(output).toContain("files=2");
    expect(output).toContain("summary=1 个文件有备份, 1 个文件将在 rewind 时删除");
    expect(output).toContain("/rewind turn-1 both");
  });

  it("空快照时给出可行动提示", () => {
    expect(formatRewindSelector("empty-session", [])).toBe(
      "session empty-session 暂无可回滚快照。完成一次文件修改后再运行 /snapshots。",
    );
  });

  it("长 messageId 在展示位截断但保留可执行命令", () => {
    const messageId = `turn-${"a".repeat(60)}-${"z".repeat(20)}`;
    const output = formatRewindSelector("session-1", [
      {
        messageId,
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 1,
        backedUpFileCount: 1,
        deletedFileCount: 0,
      },
    ]);

    expect(output).toContain("id=turn-aaaaaaaaaaaaaaaa...");
    expect(output).toContain(`/rewind ${messageId} both`);
  });

  it("过长摘要会截断，避免撑开 TUI 文本路径", () => {
    const output = formatRewindSelector(
      "session-1",
      [
        {
          messageId: "turn-1",
          timestamp: "2026-07-09T01:02:03.000Z",
          trackedFileCount: 1,
          backedUpFileCount: 1,
          deletedFileCount: 0,
          changeSummary: "这是一个非常长的变更摘要，用来模拟真实模型生成的多文件说明",
        },
      ],
      { maxSummaryLength: 18 },
    );

    expect(output).toContain("summary=这是一个非常长的变更摘要...");
    expect(output).not.toContain("多文件说明");
  });

  it("/rewind 无参数时展示最近快照和 mode 使用说明", () => {
    const output = formatRewindUsage("session-1", [
      {
        messageId: "turn-1",
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 1,
        backedUpFileCount: 1,
        deletedFileCount: 0,
      },
      {
        messageId: "turn-2",
        timestamp: "2026-07-09T01:03:03.000Z",
        trackedFileCount: 2,
        backedUpFileCount: 2,
        deletedFileCount: 0,
      },
    ]);

    expect(output).toContain("最近快照: turn-2");
    expect(output).toContain("用法: /rewind <messageId> code|conversation|both");
    expect(output).toContain("code: 只回滚文件");
    expect(output).toContain("conversation: 只回滚对话");
    expect(output).toContain("both: 同时回滚文件和对话");
  });

  it("取最后一个快照作为 /undo 默认目标", () => {
    expect(
      latestSnapshotMessageId([
        {
          messageId: "turn-1",
          timestamp: "2026-07-09T01:00:00.000Z",
          trackedFileCount: 1,
          backedUpFileCount: 1,
          deletedFileCount: 0,
        },
        {
          messageId: "turn-2",
          timestamp: "2026-07-09T01:01:00.000Z",
          trackedFileCount: 3,
          backedUpFileCount: 3,
          deletedFileCount: 0,
        },
      ]),
    ).toBe("turn-2");
  });
});
