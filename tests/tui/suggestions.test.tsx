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
        { value: "agents", description: "列出代理" },
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
      "/agents",
    ]);
    expect(rows[1]).toMatchObject({
      selected: true,
      description: "列出 skills",
    });
  });

  it("renders a fixed window around the selected candidate", () => {
    const session: ActiveSuggestionSession = {
      kind: "mention",
      query: "src",
      replaceStart: 0,
      replaceEnd: 4,
      selectedIndex: 6,
      items: Array.from({ length: 8 }, (_, index) => ({
        value: `src/file-${index}.ts`,
        description: "file",
      })),
    };

    const rows = formatSuggestionRows(session);

    expect(rows).toHaveLength(MAX_SUGGESTIONS);
    expect(rows.map((row) => row.left)).toEqual([
      "@src/file-2.ts",
      "@src/file-3.ts",
      "@src/file-4.ts",
      "@src/file-5.ts",
      "@src/file-6.ts",
    ]);
    expect(rows[4]).toMatchObject({ selected: true });
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
        metadata: "",
        description: "file",
        selected: true,
      },
    ]);
  });

  it("renders a human-facing argument label while keeping its completion value separate", () => {
    const rows = formatSuggestionRows({
      kind: "slash-argument",
      query: "",
      replaceStart: 6,
      replaceEnd: 6,
      selectedIndex: 0,
      items: [
        {
          value: "cli-mrgt170i-275d600c",
          insertText: "cli-mrgt170i-275d600c",
          label: "优化 fork 会话选择体验",
          description: "19 messages · 5m ago · id=cli-mrgt170i-275d600c",
        },
      ],
    });

    expect(rows[0]?.left).toBe("优化 fork 会话选择体验");
    expect(rows[0]?.description).toContain("19 messages");
  });

  it("renders alias match source in slash command rows", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "h",
      replaceStart: 0,
      replaceEnd: 2,
      selectedIndex: 0,
      items: [{ value: "help", matchedAlias: "h", description: "Show help" }],
    };

    const rows = formatSuggestionRows(session);
    const output = renderToString(<SuggestionList session={session} />);

    expect(rows[0]).toMatchObject({
      left: "/help",
      metadata: "alias /h",
      description: "Show help",
    });
    expect(output).toContain("alias /h");
    expect(output).toContain("Show help");
  });

  it("renders slash command descriptions with argument hints", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "res",
      replaceStart: 0,
      replaceEnd: 4,
      selectedIndex: 0,
      items: [
        {
          value: "resume",
          description: "Resume a saved session",
          argumentHint: "<session-id>",
        },
      ],
    };

    const rows = formatSuggestionRows(session);
    const output = renderToString(<SuggestionList session={session} />);

    expect(rows[0]).toMatchObject({
      left: "/resume <session-id>",
      metadata: "",
      description: "Resume a saved session",
    });
    expect(output).toContain("/resume <session-id>");
    expect(output).toContain("Resume a saved session");
  });

  it("renders slash command metadata as restrained tags", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "st",
      replaceStart: 0,
      replaceEnd: 3,
      selectedIndex: 0,
      items: [
        {
          value: "status",
          description: "Show current TUI/session status",
          usage: "/status",
          alias: "st",
          source: "builtin",
          kind: "local",
        },
      ],
    };

    const rows = formatSuggestionRows(session);
    const output = renderToString(<SuggestionList session={session} />);

    expect(rows[0]).toMatchObject({
      left: "/status",
      metadata: "alias /st · builtin · local",
      description: "Show current TUI/session status",
    });
    expect(output).toContain("/status");
    expect(output).toContain("alias /st · builtin · local");
    expect(output).toContain("Show current TUI/session status");
  });

  it("keeps slash command rows without metadata visually plain", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "",
      replaceStart: 0,
      replaceEnd: 1,
      selectedIndex: 0,
      items: [{ value: "help", description: "显示帮助" }],
    };

    const rows = formatSuggestionRows(session);
    const output = renderToString(<SuggestionList session={session} />);

    expect(rows[0]).toMatchObject({
      left: "/help",
      metadata: "",
      description: "显示帮助",
    });
    expect(output).toContain("› /help");
    expect(output).toContain("显示帮助");
    expect(output).not.toContain("builtin");
    expect(output).not.toContain("alias");
  });

  it("renders disabled slash command rows with the disabled reason", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "",
      replaceStart: 0,
      replaceEnd: 1,
      selectedIndex: 0,
      items: [
        {
          value: "compact",
          description: "Compact current session context",
          disabled: true,
          disabledReason: "Command is only available while idle.",
        },
        { value: "help", description: "显示帮助" },
      ],
    };

    const rows = formatSuggestionRows(session);
    const output = renderToString(<SuggestionList session={session} />);

    expect(rows[0]).toMatchObject({
      left: "/compact",
      description: "Compact current session context",
      disabled: true,
      disabledReason: "Command is only available while idle.",
    });
    expect(rows[1]).toMatchObject({
      left: "/help",
      description: "显示帮助",
    });
    expect(rows[1]).not.toHaveProperty("disabled");
    expect(output).toContain("Command is only available while");
    expect(output).toContain("idle.");
    expect(output).toContain("显示帮助");
  });

  it("renders descriptor source, category, kind, and disabled reason in slash rows", () => {
    const session: ActiveSuggestionSession = {
      kind: "slash",
      query: "perm",
      replaceStart: 0,
      replaceEnd: 5,
      selectedIndex: 0,
      items: [
        {
          value: "permissions",
          description: "Show or change the current permission mode",
          source: "builtin",
          category: "permissions",
          kind: "local",
          disabled: true,
          disabledReason: "Command unavailable while a modal is active.",
        },
      ],
    };

    const rows = formatSuggestionRows(session);
    const output = renderToString(<SuggestionList session={session} />);

    expect(rows[0]).toMatchObject({
      left: "/permissions",
      metadata: "builtin · permissions · local",
      disabled: true,
      disabledReason: "Command unavailable while a modal is active.",
    });
    expect(output).toContain("builtin · permissions · local");
    expect(output).toContain("Command unavailable while a modal");
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
