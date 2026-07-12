import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  formatSessionCandidateDescription,
  presentSession,
} from "../../src/tui/session-presentation.js";

const now = new Date("2026-07-12T08:20:00.000Z");

describe("session-presentation", () => {
  it("让标题、相对时间和消息数成为候选项的主要信息", () => {
    const description = formatSessionCandidateDescription(
      {
        id: "cli-mrgt170i-275d600c",
        title: "优化 fork 会话选择体验",
        updatedAt: new Date("2026-07-12T08:15:00.000Z"),
        messageCount: 19,
      },
      { now },
    );

    expect(description).toBe(
      "优化 fork 会话选择体验 · 19 messages · 5m ago · cli-mrgt170i-275d600c",
    );
  });

  it("会标示 fork 的父会话和当前会话，同时保留 ID 作次要信息", () => {
    const presentation = presentSession(
      {
        id: "cli-fork",
        firstMessage: "继续验证替代方案",
        updatedAt: new Date("2026-07-12T08:19:30.000Z"),
        messageCount: 1,
        forkFrom: "cli-parent",
        forkParentTitle: "认证重构：Session 方案",
        isCurrent: true,
      },
      { now },
    );

    expect(presentation).toMatchObject({
      title: "继续验证替代方案",
      metadata: "1 message · just now",
      forkLabel: "Fork of “认证重构：Session 方案”",
      isCurrent: true,
      identifier: "cli-fork",
    });
  });

  it("相对时间在常见边界上稳定显示", () => {
    expect(formatRelativeTime(new Date("2026-07-12T08:19:16.000Z"), now)).toBe("just now");
    expect(formatRelativeTime(new Date("2026-07-12T07:20:00.000Z"), now)).toBe("1h ago");
    expect(formatRelativeTime(new Date("2026-07-09T08:20:00.000Z"), now)).toBe("3d ago");
  });
});
