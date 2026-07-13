import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  buildTranscriptLayout,
  terminalWidth,
  visualRows,
} from "../../src/tui/transcript-layout.js";
import { buildLogoPanelRows } from "../../src/tui/logo-panel.js";
import { buildErrorEntryRows } from "../../src/tui/message-row.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";
import { ToolCard, ToolCardFocusProvider } from "../../src/tui/tool-card.js";

describe("transcript layout", () => {
  it("measures CJK and emoji grapheme clusters by terminal display width", () => {
    expect(terminalWidth("你好")).toBe(4);
    expect(terminalWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(terminalWidth("e\u0301")).toBe(1);

    expect(visualRows("你a好", 3)).toEqual(["你a", "好"]);
    expect(visualRows("👨‍👩‍👧‍👦a", 2)).toEqual(["👨‍👩‍👧‍👦", "a"]);
  });

  it("groups completed tools before calculating entries and total rows", () => {
    const entries: TuiEntry[] = Array.from({ length: 3 }, (_, index) => ({
      kind: "tool" as const,
      name: "read_file",
      args: JSON.stringify({ path: `file-${index}.ts` }),
      status: "success" as const,
      summary: `read file-${index}.ts`,
    }));

    const layout = buildTranscriptLayout(entries, { wrapWidth: 40 });

    expect(layout.entries).toHaveLength(1);
    expect(layout.items).toHaveLength(1);
    expect(layout.totalRows).toBe(layout.items[0]?.rows);
    expect(layout.entries[0]).toMatchObject({ kind: "tool", name: "read_file" });
  });

  it("includes expanded tool details in the same row model", () => {
    const entries: TuiEntry[] = [
      {
        kind: "tool",
        name: "read_file",
        args: JSON.stringify({ path: "文档/非常长的文件名.md" }),
        status: "success",
        summary: "第一行\n第二行",
      },
    ];
    const collapsed = buildTranscriptLayout(entries, { wrapWidth: 12 });
    const toolKey = collapsed.items[0]?.key;
    const expanded = buildTranscriptLayout(entries, {
      wrapWidth: 12,
      expandedToolKey: toolKey,
    });

    expect(toolKey).toBeTruthy();
    expect(collapsed.items[0]?.rows).toBe(1);
    expect(expanded.items[0]?.rows).toBeGreaterThan(collapsed.items[0]!.rows);
    expect(expanded.totalRows).toBe(expanded.items[0]?.rows);
  });

  it("includes approval panel rows in the unified total height", () => {
    const layout = buildTranscriptLayout([{ kind: "user", content: "run it" }], {
      wrapWidth: 40,
      approvalRows: 7,
    });

    expect(layout.contentRows).toBe(layout.items[0]?.rows);
    expect(layout.approvalRows).toBe(7);
    expect(layout.totalRows).toBe(layout.contentRows + 7);
  });

  it("uses the same truncated args and complete summary rows as the real ToolCard", () => {
    const entry: Extract<TuiEntry, { kind: "tool" }> = {
      kind: "tool",
      name: "read_file",
      args: JSON.stringify({ path: `docs/${"very-long-name-".repeat(12)}.md` }),
      status: "success",
      summary: Array.from({ length: 8 }, (_, index) => `result-${index}`).join("\n"),
    };
    const collapsed = buildTranscriptLayout([entry], { wrapWidth: 18 });
    const expanded = buildTranscriptLayout([entry], {
      wrapWidth: 18,
      expandedToolKey: collapsed.items[0]?.key,
    });
    const output = renderToString(
      React.createElement(ToolCard, {
        ...entry,
        isLast: true,
        initialExpanded: true,
        wrapWidth: 18,
      } as React.ComponentProps<typeof ToolCard> & { wrapWidth: number }),
      { columns: 18 },
    );

    expect(output).toContain("result-7");
    expect(output).not.toContain("已截断");
    expect(expanded.items[0]?.rows).toBe(output.split("\n").length);
  });

  it("assigns zero layout rows to non-rendering thinking entries", () => {
    const layout = buildTranscriptLayout([{ kind: "thinking" }], { wrapWidth: 40 });

    expect(layout.items[0]?.rows).toBe(0);
    expect(layout.contentRows).toBe(0);
  });

  it("measures logo and error entries from the same rows used by rendering", () => {
    const logo: TuiEntry = {
      kind: "logo",
      model: "glm-5.2",
      cwd: "/工作区/从0开始构建AgentHarness/pico-harness",
      sessionMode: "plan",
      permissionMode: "auto",
      mcpSummary: "MCP 1/2",
      taskSummary: "任务 🚀",
    };
    const error: TuiEntry = {
      kind: "error",
      message: "失败 你好 🚀".repeat(2),
      retryable: false,
      action: "check logs",
    };
    const layout = buildTranscriptLayout([logo, error], { wrapWidth: 12 });

    expect(layout.items[0]?.rows).toBe(buildLogoPanelRows({ ...logo, renderWidth: 12 }).length + 1);
    expect(layout.items[1]?.rows).toBe(buildErrorEntryRows(error, 12).length + 1);
  });

  it.each([
    [
      "resolved tool followed by assistant",
      "success" as const,
      { kind: "assistant", content: "done" } as const,
    ],
    ["running tool followed by thinking", "running" as const, { kind: "thinking" } as const],
    [
      "resolved tool followed by system feedback",
      "success" as const,
      { kind: "system", content: "local feedback" } as const,
    ],
  ])("keeps the latest %s focused and expandable", (_label, status, trailingEntry) => {
    const tool: Extract<TuiEntry, { kind: "tool" }> = {
      kind: "tool",
      name: "read_file",
      args: JSON.stringify({ path: "src/large.ts" }),
      status,
      summary: "line-0\nline-1\nline-2",
    };
    const initial = buildTranscriptLayout([tool], { wrapWidth: 40 });
    const layout = buildTranscriptLayout([tool, trailingEntry], {
      wrapWidth: 40,
      expandedToolKey: initial.items[0]?.key,
    });
    const renderedTool = renderToString(
      React.createElement(
        ToolCardFocusProvider,
        { expanded: true },
        React.createElement(ToolCard, {
          ...tool,
          isLast: false,
          focused: true,
          wrapWidth: 40,
        }),
      ),
      { columns: 40 },
    );

    expect(layout.items[0]?.rows).toBe(renderedTool.split("\n").length);
    expect(layout.items[0]?.focusedTool).toBe(true);
    expect(layout.items[0]?.rows).toBeGreaterThan(1);
    expect(layout.items.at(-1)?.focusedTool).toBe(false);
  });
});
