import { describe, expect, it } from "vitest";
import {
  formatRewindSelector,
  latestSnapshotMessageId,
} from "../../src/tui/rewind-selector.js";

describe("RewindSelector", () => {
  it("展示当前 session 的可回滚点", () => {
    const output = formatRewindSelector("session-1", [
      {
        messageId: "turn-1",
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 2,
        backedUpFileCount: 1,
        deletedFileCount: 1,
        messageIndex: 4,
      },
    ]);

    expect(output).toContain("session-1");
    expect(output).toContain("turn-1");
    expect(output).toContain("tracked=2");
    expect(output).toContain("backups=1");
    expect(output).toContain("deleted=1");
    expect(output).toContain("/rewind turn-1");
  });

  it("空快照时给出轻量提示", () => {
    expect(formatRewindSelector("empty-session", [])).toBe(
      "session empty-session 暂无可回滚快照。",
    );
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
