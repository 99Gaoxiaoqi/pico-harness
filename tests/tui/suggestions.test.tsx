import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  MAX_SUGGESTIONS,
  SUGGESTION_DESCRIPTION_WIDTH,
  SUGGESTION_LABEL_WIDTH,
  SuggestionList,
  formatSuggestionRows,
  type ActiveSuggestionSession,
} from "../../src/tui/suggestions.js";

describe("SuggestionList row model", () => {
  it("renders at most five slash command rows with descriptions", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "",
      replaceStart: 0,
      replaceEnd: 1,
      selectedIndex: 1,
      items: [
        { value: "help", description: "显示帮助" },
        { value: "skills", description: "列出 skills" },
        { value: "status", description: "显示状态" },
        { value: "model", description: "显示模型" },
        { value: "tools", description: "列出工具" },
        { value: "exit", description: "退出" },
      ],
    };

    const rows = formatSuggestionRows(session);

    expect(rows).toHaveLength(MAX_SUGGESTIONS);
    expect(rows.map((row) => row.left)).toEqual([
      "/help",
      "/skills",
      "/status",
      "/model",
      "/tools",
    ]);
    expect(rows[1]).toMatchObject({
      selected: true,
      description: "列出 skills",
    });
  });

  it("renders mention rows with @path labels", () => {
    const session: ActiveSuggestionSession = {
      kind: "mention",
      query: "src/t",
      replaceStart: 0,
      replaceEnd: 6,
      selectedIndex: 0,
      items: [{ value: "src/tui/input-box.tsx", description: "file" }],
    };

    expect(formatSuggestionRows(session)).toEqual([
      {
        key: "mention:src/tui/input-box.tsx:0",
        left: "@src/tui/input-box.tsx",
        description: "file",
        selected: true,
      },
    ]);
  });

  it("clips selected Chinese, multiline, and long command candidates for panel rendering", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "",
      replaceStart: 0,
      replaceEnd: 1,
      selectedIndex: 2,
      items: [
        {
          value: "doctor",
          description: "检查项目配置\n并给出修复建议",
        },
        {
          value: "很长的中文命令名称用于测试候选面板截断",
          description: "输出当前会话的中文摘要，包含后续行动和风险提示",
        },
        {
          value: "very-long-command-name-that-should-not-stretch-the-terminal",
          description: "print a concise report for this repository without wrapping the panel",
        },
      ],
    };

    const rows = formatSuggestionRows(session);

    expect(rows).toHaveLength(3);
    expect(rows[0]?.description).toBe("检查项目配置 并给出修复建议");
    expect(rows[1]?.left.length).toBeLessThanOrEqual(SUGGESTION_LABEL_WIDTH);
    expect(rows[1]?.description.length).toBeLessThanOrEqual(SUGGESTION_DESCRIPTION_WIDTH);
    expect(rows[2]).toMatchObject({ selected: true });
    expect(rows[2]?.left).toBe("/very-long-command-name-that-sh…");
    expect(rows[2]?.description).toBe("print a concise report for this repos…");
  });

  it("renders clipped Chinese, multiline, and selected long command candidates", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "",
      replaceStart: 0,
      replaceEnd: 1,
      selectedIndex: 2,
      items: [
        {
          value: "doctor",
          description: "检查项目配置\n并给出修复建议",
        },
        {
          value: "很长的中文命令名称用于测试候选面板截断",
          description: "输出当前会话的中文摘要，包含后续行动和风险提示",
        },
        {
          value: "very-long-command-name-that-should-not-stretch-the-terminal",
          description: "print a concise report for this repository without wrapping the panel",
        },
      ],
    };

    const output = renderToString(<SuggestionList session={session} />);

    expect(output).toContain("检查项目配置 并给出修复建议");
    expect(output).not.toContain("检查项目配置\n并给出修复建议");
    expect(output).toContain("/很长的中文命令名称用于测试候选…");
    expect(output).toContain("输出当前会话的中文摘要，包含后续行动…");
    expect(output).toContain("› /very-long-command-name-that-sh…");
    expect(output).toContain("print a concise report for this repos…");
    expect(output).not.toContain("wrapping the panel");
    expect(output.split("\n")).toHaveLength(3);
  });
});
