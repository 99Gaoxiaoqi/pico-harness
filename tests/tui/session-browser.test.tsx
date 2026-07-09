import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import {
  SessionBrowser,
  cancelSessionBrowserSelection,
  confirmSessionBrowserSelection,
  createSessionBrowserState,
  formatSessionBrowser,
  moveSessionBrowserSelection,
  toggleSessionBrowserScope,
  type SessionBrowserSession,
} from "../../src/tui/session-browser.js";

type SessionOverrides = Omit<Partial<SessionBrowserSession>, "createdAt" | "updatedAt"> & {
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

describe("SessionBrowser", () => {
  it("展示 cwd 过滤状态、选中项和会话摘要", () => {
    const output = formatSessionBrowser(
      [
        sessionSummary({
          id: "cli-current",
          cwd: "/tmp/project",
          title: "修复输入框焦点",
          firstMessage: "请帮我修复 TUI 输入焦点丢失的问题",
          updatedAt: "2026-07-09T03:04:05.000Z",
          messageCount: 4,
        }),
        sessionSummary({
          id: "cli-other",
          cwd: "/tmp/other",
          title: "其他项目",
        }),
      ],
      {
        currentProjectCwd: "/tmp/project",
        state: createSessionBrowserState(),
      },
    );

    expect(output).toContain("Sessions [cwd]");
    expect(output).toContain("1/2");
    expect(output).toContain("> 2026-07-09 03:04");
    expect(output).toContain("修复输入框焦点");
    expect(output).toContain("请帮我修复 TUI 输入焦点丢失的问题");
    expect(output).toContain("/tmp/project");
    expect(output).not.toContain("cli-other");
  });

  it("切换到 all 后展示跨 cwd 会话并保持选中索引有效", () => {
    const sessions = [
      sessionSummary({ id: "cli-a", cwd: "/tmp/project" }),
      sessionSummary({ id: "cli-b", cwd: "/tmp/other" }),
    ];
    const state = toggleSessionBrowserScope(
      createSessionBrowserState({ selectedIndex: 1 }),
      sessions,
      "/tmp/project",
    );

    expect(state).toEqual({ scope: "all", selectedIndex: 1 });
    const output = formatSessionBrowser(sessions, {
      currentProjectCwd: "/tmp/project",
      state,
    });
    expect(output).toContain("Sessions [all]");
    expect(output).toContain("2/2");
    expect(output).toContain("cli-b");
  });

  it("上下移动会在可见会话内循环", () => {
    const sessions = [
      sessionSummary({ id: "cli-a" }),
      sessionSummary({ id: "cli-b" }),
      sessionSummary({ id: "cli-c" }),
    ];
    const initial = createSessionBrowserState({ scope: "all" });

    expect(moveSessionBrowserSelection(initial, sessions, 1).selectedIndex).toBe(1);
    expect(moveSessionBrowserSelection(initial, sessions, -1).selectedIndex).toBe(2);
  });

  it("超过 maxItems 后仍展示选中项，确认项与高亮项一致", () => {
    const sessions = Array.from({ length: 12 }, (_, index) =>
      sessionSummary({ id: `cli-${index + 1}`, cwd: "/tmp/project" }),
    );
    const state = createSessionBrowserState({ scope: "all", selectedIndex: 10 });
    const onConfirm = vi.fn();

    const output = formatSessionBrowser(sessions, { state, maxItems: 5 });
    confirmSessionBrowserSelection(state, sessions, undefined, { onConfirm });

    expect(output).toContain("> 2026-07-09 02:00 cli-11");
    expect(output).not.toContain("cli-1 msgs=");
    expect(onConfirm).toHaveBeenCalledWith(sessions[10]);
  });

  it("确认只返回当前过滤视图内的选中 session，取消只触发取消回调", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const sessions = [
      sessionSummary({ id: "cli-a", cwd: "/tmp/project" }),
      sessionSummary({ id: "cli-b", cwd: "/tmp/other" }),
    ];

    confirmSessionBrowserSelection(
      createSessionBrowserState({ scope: "all", selectedIndex: 1 }),
      sessions,
      "/tmp/project",
      { onConfirm, onCancel },
    );
    cancelSessionBrowserSelection({ onConfirm, onCancel });

    expect(onConfirm).toHaveBeenCalledWith(sessions[1]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("过长文本会截断，避免撑开 TUI 行宽", () => {
    const longTitle = "这是一个非常长的会话标题，用来模拟用户第一句话或模型生成标题超出可视宽度";
    const longCwd = `/tmp/${"nested/".repeat(12)}project`;

    const output = formatSessionBrowser(
      [
        sessionSummary({
          id: "cli-long",
          cwd: longCwd,
          title: longTitle,
          firstMessage: "第一条消息也很长，但标题存在时应优先展示标题",
        }),
      ],
      {
        currentProjectCwd: longCwd,
        state: createSessionBrowserState(),
        maxTitleLength: 24,
        maxCwdLength: 30,
      },
    );

    expect(output).toContain("这是一个非常长的会话标题，用来模拟用户第一...");
    expect(output).toContain("/tmp/nested/nested/nested/n...");
    expect(output).not.toContain("可视宽度");
  });

  it("可作为 Ink 纯组件渲染", () => {
    const output = renderToString(
      <SessionBrowser
        currentProjectCwd="/tmp/project"
        sessions={[sessionSummary({ id: "cli-one", cwd: "/tmp/project" })]}
        state={createSessionBrowserState()}
      />,
    );

    expect(output).toContain("Sessions [cwd]");
    expect(output).toContain("cli-one");
  });
});

function sessionSummary(overrides: SessionOverrides = {}): SessionBrowserSession {
  return {
    id: overrides.id ?? "cli-one",
    cwd: overrides.cwd ?? "/tmp/project",
    createdAt:
      overrides.createdAt === undefined
        ? new Date("2026-07-09T01:00:00.000Z")
        : toDate(overrides.createdAt),
    updatedAt:
      overrides.updatedAt === undefined
        ? new Date("2026-07-09T02:00:00.000Z")
        : toDate(overrides.updatedAt),
    messageCount: overrides.messageCount ?? 1,
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.firstMessage !== undefined ? { firstMessage: overrides.firstMessage } : {}),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
