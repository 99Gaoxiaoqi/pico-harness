import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { AgentDetailView } from "../../src/tui/agent-detail-view.js";
import type { AgentNavigationItem } from "../../src/tui/agent-navigation.js";
import { terminalWidth } from "../../src/tui/terminal-width.js";

describe("subagent detail layout integration", () => {
  it("在受限视口中保留信息层级，并只展示完整的最近事件摘要", () => {
    const agent: AgentNavigationItem = {
      id: "tests-agent",
      kind: "subagent",
      status: "running",
      agentName: "tests/ 目录与测试架构",
      task: "[Subagent] 探索 tests/ 目录结构、测试类型分布与关键文件",
      mode: "explore",
      completionPolicy: "required",
      currentAction: "读取 tests/e2e/real-llm.test.ts 并检查真实模型门禁",
      timeline: [
        {
          id: "read-old",
          kind: "tool",
          name: "read_file",
          status: "completed",
          summary:
            '[Subagent] 1 import { defineConfig } from "vitest/config"; 2 export default defineConfig({ 3 test: { 4 include: ["tests/**/*.test.ts"]',
        },
        {
          id: "message",
          kind: "message",
          content: "[Subagent] 已找到真实模型测试的 fail-closed 入口，下一步检查报告器。",
        },
        { id: "grep", kind: "tool", name: "grep", status: "running", summary: "raw output" },
      ],
    };

    const output = renderToString(
      <AgentDetailView agent={agent} renderWidth={32} visibleRows={11} />,
      { columns: 32 },
    );

    expect(output).toContain("← Main / tests/ 目录与测试架构");
    expect(output).toContain("✽ running · explore · required");
    expect(output).toContain("Task");
    expect(output).toContain("Current");
    expect(output).toMatch(/Current .*\n {9}\S/u);
    expect(output).toContain("Timeline");
    expect(output).toContain("› Grep");
    expect(output).not.toContain("import { defineConfig }");
    expect(output).not.toContain("[Subagent]");
    expect(output.split("\n").every((line) => terminalWidth(line) <= 32)).toBe(true);

    const scrolled = renderToString(
      <AgentDetailView agent={agent} renderWidth={18} startOffsetRows={11} visibleRows={3} />,
      { columns: 18 },
    );
    expect(scrolled.split("\n").every((line) => terminalWidth(line) <= 18)).toBe(true);
    expect(scrolled).toMatch(/^✦ /u);
    expect(scrolled).toContain("› Grep");
  });
});
