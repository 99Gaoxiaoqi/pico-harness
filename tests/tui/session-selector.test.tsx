import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { SessionSelector, formatSessionSelector } from "../../src/tui/session-selector.js";
import type { CliSessionSummary } from "../../src/cli/session-resolver.js";

type SessionSummaryOverrides = Omit<Partial<CliSessionSummary>, "createdAt" | "updatedAt"> & {
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

describe("SessionSelector", () => {
  it("renders an empty-state hint", () => {
    expect(formatSessionSelector([])).toBe(
      "当前项目暂无可恢复 session。启动一次对话后会自动出现在这里。",
    );
  });

  it("marks the current session and shows resume hints", () => {
    const output = formatSessionSelector(
      [
        sessionSummary({
          id: "cli-current",
          cwd: "/tmp/current-project",
          messageCount: 2,
          updatedAt: "2026-07-09T03:00:00.000Z",
        }),
      ],
      {
        currentProjectCwd: "/tmp/current-project",
        currentSessionId: "cli-current",
      },
    );

    expect(output).toContain("cli-current");
    expect(output).toContain("[current]");
    expect(output).toContain("messages=2");
    expect(output).toContain("use: /resume cli-current");
  });

  it("truncates long session ids without losing the resume target", () => {
    const longId = "cli-abcdefghijklmnopqrstuvwxyz-0123456789-long-tail";

    const output = formatSessionSelector(
      [sessionSummary({ id: longId, cwd: "/tmp/current-project" })],
      { currentProjectCwd: "/tmp/current-project" },
    );

    expect(output).toContain("cli-abcdefghijklmnopqrstuvwxyz-012…");
    expect(output).toContain(`use: /resume ${longId}`);

    const summaryLine = output.split("\n").find((line) => line.startsWith("- "))!;
    expect(summaryLine).not.toContain(longId);
    expect(summaryLine.length).toBeLessThanOrEqual(120);
  });

  it("orders current project sessions before cross-project sessions", () => {
    const output = formatSessionSelector(
      [
        sessionSummary({
          id: "cli-other-newer",
          cwd: "/tmp/other-project",
          updatedAt: "2026-07-09T05:00:00.000Z",
        }),
        sessionSummary({
          id: "cli-current-older",
          cwd: "/tmp/current-project",
          updatedAt: "2026-07-09T04:00:00.000Z",
        }),
      ],
      { currentProjectCwd: "/tmp/current-project" },
    );

    expect(output.indexOf("cli-current-older")).toBeLessThan(output.indexOf("cli-other-newer"));
  });

  it("shows a shell launch hint for cross-project sessions", () => {
    const output = formatSessionSelector(
      [
        sessionSummary({
          id: "cli-other",
          cwd: "/tmp/other-project",
        }),
      ],
      { currentProjectCwd: "/tmp/current-project" },
    );

    expect(output).toContain("launch: cd /tmp/other-project && pico --resume cli-other");
  });

  it("renders formatted rows as an Ink component", () => {
    const output = renderToString(
      <SessionSelector
        currentSessionId="cli-one"
        sessions={[
          sessionSummary({
            id: "cli-one",
            messageCount: 1,
            updatedAt: "2026-07-09T03:00:00.000Z",
          }),
        ]}
      />,
    );

    expect(output).toContain("cli-one");
    expect(output).toContain("current");
  });
});

function sessionSummary(overrides: SessionSummaryOverrides = {}): CliSessionSummary {
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
    messageCount: overrides.messageCount ?? 0,
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
