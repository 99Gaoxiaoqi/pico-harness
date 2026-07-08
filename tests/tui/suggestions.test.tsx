import { describe, expect, it } from "vitest";
import {
  MAX_SUGGESTIONS,
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
});
