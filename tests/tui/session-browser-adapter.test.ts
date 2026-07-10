import { describe, expect, it } from "vitest";
import {
  mapCliSessionsToBrowserSessions,
  sessionSelectionToCommand,
  type CliSessionBrowserSummary,
} from "../../src/tui/session-browser-adapter.js";

describe("session-browser-adapter", () => {
  it("maps cli session summaries to browser sessions with cwd title and time", () => {
    const updatedAt = new Date("2026-07-09T03:04:05.000Z");
    const [session] = mapCliSessionsToBrowserSessions([
      cliSessionSummary({
        id: "cli-current",
        cwd: "/tmp/project",
        updatedAt,
        title: "修复输入框焦点",
        lastMessage: "模型最后一条摘要",
      }),
    ]);

    expect(session).toMatchObject({
      id: "cli-current",
      cwd: "/tmp/project",
      updatedAt,
      title: "修复输入框焦点",
      firstMessage: "模型最后一条摘要",
    });
  });

  it("falls back to a lightweight message when title is missing", () => {
    const [session] = mapCliSessionsToBrowserSessions([
      cliSessionSummary({
        firstMessage: "请继续完善 slash command",
        lastMessage: "最近一条消息",
      }),
    ]);

    expect(session?.title).toBe("请继续完善 slash command");
    expect(session?.firstMessage).toBe("请继续完善 slash command");
  });

  it("builds the resume slash command for a selected session", () => {
    expect(sessionSelectionToCommand("cli-current")).toBe("/resume cli-current");
  });
});

type SessionSummaryOverrides = Omit<
  Partial<CliSessionBrowserSummary>,
  "createdAt" | "updatedAt"
> & {
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

function cliSessionSummary(overrides: SessionSummaryOverrides = {}): CliSessionBrowserSummary {
  return {
    id: overrides.id ?? "cli-one",
    cwd: overrides.cwd ?? "/tmp/project",
    createdAt:
      overrides.createdAt === undefined
        ? new Date("2026-07-09T01:00:00.000Z")
        : toDate(overrides.createdAt),
    updatedAt:
      overrides.updatedAt === undefined
        ? new Date("2026-07-09T02:00:00.000Z")
        : toDate(overrides.updatedAt),
    messageCount: overrides.messageCount ?? 1,
    ...optional("title", overrides.title),
    ...optional("firstMessage", overrides.firstMessage),
    ...optional("lastMessage", overrides.lastMessage),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function optional<T extends keyof CliSessionBrowserSummary>(
  key: T,
  value: CliSessionBrowserSummary[T] | undefined,
): Partial<CliSessionBrowserSummary> {
  return value === undefined ? {} : { [key]: value };
}
