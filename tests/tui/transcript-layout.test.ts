import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  buildTranscriptLayout,
  terminalWidth,
  visualRows,
} from "../../src/tui/transcript-layout.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";
import { ToolCard } from "../../src/tui/tool-card.js";

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

  it("uses the same truncated args and five-line result rows as the real ToolCard", () => {
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

    expect(output.replace(/\s+/gu, " ")).toContain("已截断 3 行");
    expect(output).not.toContain("result-5");
    expect(expanded.items[0]?.rows).toBe(output.split("\n").length);
  });

  it("assigns zero layout rows to non-rendering thinking entries", () => {
    const layout = buildTranscriptLayout([{ kind: "thinking" }], { wrapWidth: 40 });

    expect(layout.items[0]?.rows).toBe(0);
    expect(layout.contentRows).toBe(0);
  });
});
