import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { createMainAgentItem, type AgentNavigationItem } from "../../src/tui/agent-navigation.js";
import { AgentSwitcher, buildAgentSwitcherLayout } from "../../src/tui/agent-switcher.js";
import { terminalWidth } from "../../src/tui/terminal-width.js";

describe("agent switcher layout integration", () => {
  it("将 Main 固定在首行，并用单行分列布局展示代理任务与未读", () => {
    const items: AgentNavigationItem[] = [
      createMainAgentItem({ status: "running" }),
      createAgent("agent-1", "探索", "项目根目录与配置文件", 2),
      createAgent("agent-2", "阅读", "src/ 核心源代码模块划分", 0),
      createAgent("agent-3", "探索", "tests/ 目录结构与测试架构", 5),
      createAgent("agent-4", "审查", "关键测试文件", 0),
      createAgent("agent-5", "验证", "构建与安全检查", 0),
    ];

    const layout = buildAgentSwitcherLayout({
      items,
      selectedId: "agent-5",
      activeId: "agent-5",
      focused: true,
      renderWidth: 52,
      maxVisibleItems: 4,
    });

    expect(layout.totalItems).toBe(5);
    expect(layout.rows.map((row) => row.itemId)).toEqual(["main", "agent-3", "agent-4", "agent-5"]);
    expect(layout.title).toContain("Agents · 5 · ↑2 hidden · 7 new");
    expect(layout.hiddenAbove).toBe(2);
    expect(layout.hiddenBelow).toBe(0);

    const output = renderToString(
      <AgentSwitcher
        items={items}
        selectedId="agent-5"
        activeId="agent-5"
        focused
        renderWidth={52}
        maxVisibleItems={4}
      />,
      { columns: 52 },
    );
    const lines = output.split("\n");

    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("✽ Main");
    expect(lines[4]).toContain("› ✽ 验证");
    expect(output).not.toMatch(/›●|› ●/u);
    expect(output).not.toMatch(/required|background|running/u);
    expect(lines.every((line) => terminalWidth(line) <= 52)).toBe(true);
  });

  it("在窄屏上收缩未读 badge，且不让中英文任务折行", () => {
    const items: AgentNavigationItem[] = [
      createMainAgentItem(),
      createAgent("agent-wide", "long-agent-name", "检查 emoji 🚀 和中文宽字符对齐", 12),
    ];
    const output = renderToString(
      <AgentSwitcher
        items={items}
        selectedId="agent-wide"
        activeId="main"
        focused
        renderWidth={20}
      />,
      { columns: 20 },
    );

    expect(output).toContain("+12");
    expect(output).not.toContain("12 new");
    expect(output.split("\n")).toHaveLength(3);
    expect(output.split("\n").every((line) => terminalWidth(line) <= 20)).toBe(true);
  });
});

function createAgent(
  id: string,
  agentName: string,
  task: string,
  unreadCount: number,
): AgentNavigationItem {
  return {
    id,
    kind: "subagent",
    status: "running",
    agentName,
    task,
    unreadCount,
    completionPolicy: "required",
  };
}
