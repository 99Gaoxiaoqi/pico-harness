import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../../src/tui/message-list.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";
import { ToolCardFocusProvider } from "../../src/tui/tool-card.js";

describe("MessageList virtual transcript", () => {
  it("keeps the existing full render behavior unless virtualization is configured", () => {
    const entries = makeUserEntries(220);

    const output = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries, { wrapWidth: 80 }),
      }),
    );

    expect(output).toContain("message-0");
    expect(output).toContain("message-219");
  });

  it("renders only the computed window when virtualization is configured", () => {
    const entries = makeUserEntries(300);

    const output = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries, { wrapWidth: 80 }),
        viewportRows: 4,
        scrollOffsetRows: 100,
        estimatedRowHeight: 1,
        overscanRows: 1,
      }),
    );

    expect(output).not.toContain("message-32");
    expect(output).toContain("message-33");
    expect(output).toContain("message-35");
    expect(output).not.toContain("message-36");
  });

  it("keeps the tail of a tall streaming assistant visible at the bottom", () => {
    const entries: TuiEntry[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        kind: "assistant" as const,
        content: `old-${i}`,
      })),
      {
        kind: "assistant",
        content: Array.from({ length: 20 }, (_, i) => `stream-line-${i}`).join("\n"),
      },
    ];

    const output = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries, { wrapWidth: 80 }),
        isStreaming: true,
        viewportRows: 10,
        scrollOffsetRows: 0,
        estimatedRowHeight: 2,
        overscanRows: 0,
        virtualizeThreshold: 0,
        scrollToBottom: true,
        preserveVirtualSpacers: false,
      }),
    );

    expect(output).toContain("stream-line-19");
    expect(output).not.toContain("stream-line-0");
    expect(output).not.toContain("old-49");
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

    const output = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries, { wrapWidth: 80 }),
      }),
    );

    expect(output).toContain("bash · 2 calls");
    expect(output).toContain("2 success");
    expect(output).not.toContain("/api/daily");
  });

  it("consumes the pre-grouped row layout instead of rebuilding display entries", () => {
    const entries: TuiEntry[] = [
      {
        kind: "tool",
        name: "read_file",
        args: '{"path":"a.ts"}',
        status: "success",
        summary: "a",
      },
      {
        kind: "tool",
        name: "read_file",
        args: '{"path":"b.ts"}',
        status: "success",
        summary: "b",
      },
    ];
    const layout = buildTranscriptLayout(entries, { wrapWidth: 40 });

    const output = renderToString(React.createElement(MessageList, { layout }));

    expect(layout.entries).toHaveLength(1);
    expect(output).toContain("read · 2 calls");
  });

  it("clips an expanded tool from its internal start offset", () => {
    const entry: TuiEntry = {
      kind: "tool",
      name: "read_file",
      args: "{}",
      status: "success",
      summary: Array.from({ length: 8 }, (_, index) => `result-${index}`).join("\n"),
    };
    const collapsed = buildTranscriptLayout([entry], { wrapWidth: 40 });
    const layout = buildTranscriptLayout([entry], {
      wrapWidth: 40,
      expandedToolKey: collapsed.items[0]?.key,
    });

    const output = renderToString(
      React.createElement(
        ToolCardFocusProvider,
        { expanded: true },
        React.createElement(MessageList, {
          layout,
          viewportRows: 2,
          scrollOffsetRows: 4,
          overscanRows: 0,
          virtualizeThreshold: 0,
          preserveVirtualSpacers: false,
        }),
      ),
    );

    expect(output).not.toContain("⎿ read");
    expect(output).not.toContain("参数");
    expect(output).toContain("result-1");
    expect(output).toContain("result-2");
    expect(output).not.toContain("result-0");
  });

  it("clips logo and error entries from internal row offsets", () => {
    const entries: TuiEntry[] = [
      {
        kind: "logo",
        model: "glm-5.2",
        cwd: "/工作区/从0开始构建AgentHarness/pico-harness",
        sessionMode: "plan",
        permissionMode: "auto",
        mcpSummary: "MCP 1/2",
        taskSummary: "任务 🚀",
      },
      {
        kind: "error",
        message: "first-line\nsecond-line\nthird-line",
        retryable: false,
        action: "check logs",
      },
    ];

    const logoOutput = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries, { wrapWidth: 12 }),
        viewportRows: 3,
        scrollOffsetRows: 2,
        overscanRows: 0,
        virtualizeThreshold: 0,
        preserveVirtualSpacers: false,
      }),
      { columns: 18 },
    );
    const errorOutput = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries.slice(1), { wrapWidth: 12 }),
        viewportRows: 2,
        scrollOffsetRows: 2,
        overscanRows: 0,
        virtualizeThreshold: 0,
        preserveVirtualSpacers: false,
      }),
      { columns: 18 },
    );

    expect(logoOutput).not.toContain("pico ·");
    expect(logoOutput).toContain("工作区");
    expect(errorOutput).not.toContain("first-line");
    expect(errorOutput).toContain("second-line");
  });

  it("counts the error top margin inside the clipped viewport", () => {
    const entries: TuiEntry[] = [
      {
        kind: "error",
        message: "失败一行 失败二行 失败三行 失败四行",
        retryable: false,
      },
    ];

    const output = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(entries, { wrapWidth: 10 }),
        viewportRows: 2,
        scrollOffsetRows: 0,
        overscanRows: 0,
        virtualizeThreshold: 0,
        preserveVirtualSpacers: false,
      }),
      { columns: 16 },
    );

    expect(output.split("\n")).toHaveLength(2);
    expect(output).toContain("!");
  });
});

function makeUserEntries(count: number): TuiEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "user",
    content: `message-${i}`,
  }));
}
