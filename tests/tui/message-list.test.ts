import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../../src/tui/message-list.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

describe("MessageList virtual transcript", () => {
  it("keeps the existing full render behavior unless virtualization is configured", () => {
    const entries = makeUserEntries(220);

    const output = renderToString(React.createElement(MessageList, { entries }));

    expect(output).toContain("message-0");
    expect(output).toContain("message-219");
  });

  it("renders only the computed window when virtualization is configured", () => {
    const entries = makeUserEntries(300);

    const output = renderToString(
      React.createElement(MessageList, {
        entries,
        viewportRows: 4,
        scrollOffsetRows: 100,
        estimatedRowHeight: 1,
        overscanRows: 1,
      }),
    );

    expect(output).not.toContain("message-98");
    expect(output).toContain("message-99");
    expect(output).toContain("message-104");
    expect(output).not.toContain("message-105");
  });

  it("渲染层折叠连续同类工具调用", () => {
    const entries: TuiEntry[] = [
      { kind: "assistant", content: "开始检查" },
      {
        kind: "tool",
        name: "bash",
        args: JSON.stringify({ command: "curl -s https://aihot.virxact.com/api/news" }),
        status: "success",
        summary: "0 字节 · ",
      },
      {
        kind: "tool",
        name: "bash",
        args: JSON.stringify({ command: "curl -s https://aihot.virxact.com/api/daily" }),
        status: "success",
        summary: "0 字节 · ",
      },
    ];

    const output = renderToString(React.createElement(MessageList, { entries }));

    expect(output).toContain("bash · 2 calls");
    expect(output).toContain("2 success");
    expect(output).not.toContain("/api/daily");
  });
});

function makeUserEntries(count: number): TuiEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "user",
    content: `message-${i}`,
  }));
}
