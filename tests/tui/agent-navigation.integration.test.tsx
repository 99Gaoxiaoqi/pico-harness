import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  createAgentNavigationState,
  createMainAgentItem,
  reduceAgentNavigation,
  type AgentNavigationItem,
} from "../../src/tui/agent-navigation.js";
import { AgentDetailView } from "../../src/tui/agent-detail-view.js";
import {
  AgentSwitcher,
  buildAgentSwitcherLayout,
  hitTestAgentSwitcherRow,
  measureAgentSwitcherRows,
} from "../../src/tui/agent-switcher.js";
import { terminalWidth } from "../../src/tui/terminal-width.js";

describe("agent navigation integration", () => {
  it("在紧凑代理列表中循环选择、打开详情、返回并命中鼠标行", () => {
    const items: AgentNavigationItem[] = [
      createMainAgentItem({ status: "running" }),
      {
        id: "agent-auth",
        kind: "subagent",
        status: "running",
        agentName: "auth-agent",
        task: "检查认证模块的错误处理与超长路径",
        mode: "explore",
        currentAction: "read_file: src/auth/session.ts",
        unreadCount: 2,
        timeline: [
          { id: "thinking-1", kind: "thinking", content: "检查调用链" },
          {
            id: "tool-1",
            kind: "tool",
            name: "read_file",
            status: "completed",
            summary: "src/auth/session.ts",
          },
          { id: "message-1", kind: "message", content: "发现 session 恢复分支" },
        ],
      },
      {
        id: "agent-cache",
        kind: "subagent",
        status: "completed",
        task: "分析缓存失效",
        summary: "已定位过期键",
      },
    ];

    let state = createAgentNavigationState();
    state = reduceAgentNavigation(state, { type: "focus-picker" }, items);
    state = reduceAgentNavigation(state, { type: "move-up" }, items);
    expect(state.selectedId).toBe("agent-cache");
    state = reduceAgentNavigation(state, { type: "move-down" }, items);
    state = reduceAgentNavigation(state, { type: "move-down" }, items);
    expect(state.selectedId).toBe("agent-auth");
    state = reduceAgentNavigation(state, { type: "open" }, items);
    expect(state.activeId).toBe("agent-auth");

    const switcher = renderToString(
      <AgentSwitcher
        items={items}
        selectedId={state.selectedId}
        activeId={state.activeId}
        focused
        renderWidth={32}
      />,
      { columns: 32 },
    );
    expect(switcher).toContain("Agents · 3");
    expect(switcher).toContain("›● ✽ auth-agent");
    expect(switcher).toContain("+2");

    const detail = renderToString(<AgentDetailView agent={items[1]!} renderWidth={22} />, {
      columns: 22,
    });
    expect(detail).toContain("← Main / auth-agent");
    expect(detail).toContain("read_file: src/auth/");
    expect(detail).toContain("Timeline");
    expect(detail).toContain("发现 session");
    expect(detail.split("\n").every((line) => terminalWidth(line) <= 22)).toBe(true);

    const layout = buildAgentSwitcherLayout({
      items,
      selectedId: "agent-auth",
      activeId: "agent-auth",
      focused: true,
      renderWidth: 22,
      maxVisibleItems: 2,
    });
    expect(layout.totalRows).toBe(measureAgentSwitcherRows(items, 2));
    expect(hitTestAgentSwitcherRow(layout, 0)).toBeNull();
    expect(hitTestAgentSwitcherRow(layout, 1)).toBe(layout.rows[0]?.itemId);
    expect(layout.rows.every((row) => terminalWidth(row.text) <= 22)).toBe(true);

    state = reduceAgentNavigation(state, { type: "escape" }, items);
    expect(state).toMatchObject({ activeId: "main", selectedId: "main", focus: "picker" });
    state = reduceAgentNavigation(state, { type: "escape" }, items);
    expect(state.focus).toBe("input");

    const withoutAuth = items.filter((item) => item.id !== "agent-auth");
    const invalid = reduceAgentNavigation(
      { ...state, selectedId: "agent-auth", activeId: "agent-auth" },
      { type: "items-changed" },
      withoutAuth,
    );
    expect(invalid).toMatchObject({ selectedId: "main", activeId: "main" });
  });
});
