// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopApp } from "./App.js";
import type { RendererBridge } from "./runtime.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { pico?: unknown }).pico;
  window.history.replaceState({}, "", "/");
});

describe("DesktopApp renderer", () => {
  it("shows an honest unavailable state when the desktop bridge is missing", async () => {
    window.history.replaceState({}, "", "/#/sessions");
    render(<DesktopApp />);

    expect(
      await screen.findByRole("heading", { name: "界面已就绪，但没有可用的数据连接" }),
    ).toBeTruthy();
    expect(screen.getByText(/不会使用演示数据代替真实任务/)).toBeTruthy();
    expect(screen.queryByText("修复同步冲突并补充回归测试")).toBeNull();
  });

  it("resolves approval and Ask User interactions only inside explicit preview mode", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?demo=1#/task/run-atlas");
    render(<DesktopApp />);

    expect(await screen.findByText("Preview")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "查看审批" }));
    expect(screen.getByRole("dialog", { name: "允许执行测试命令？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "仅允许这次" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "允许执行测试命令？" })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "回答问题" }));
    expect(screen.getByRole("dialog", { name: "冲突时优先保留哪一侧的标题？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保留本地最近编辑" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "冲突时优先保留哪一侧的标题？" })).toBeNull(),
    );
  });

  it("moves focus through sidebar navigation with arrow keys", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?demo=1#/");
    render(<DesktopApp />);

    const home = await screen.findByRole("link", { name: "开始" });
    const sessions = screen.getByRole("link", { name: "会话" });
    home.focus();
    expect(document.activeElement).toBe(home);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(sessions);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "设置" }));
  });

  it("让普通文件夹完成选择、信任和开始任务的主路径", async () => {
    const user = userEvent.setup();
    const calls: Array<{
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }> = [];
    let trusted = false;
    let started = false;
    const workspacePath = "/Users/chen/Documents/meeting-notes";
    const success = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async (params: Readonly<Record<string, unknown>>) => {
          const method = String(property);
          calls.push({ method, params });
          const value = (() => {
            switch (method) {
              case "runtime.ping":
                return { version: "test" };
              case "workspace.list":
                return { workspaces: [] };
              case "workspace.register":
                return { workspacePath };
              case "workspace.status":
                return {
                  workspacePath,
                  mode: "folder",
                  capabilities: {
                    foregroundRuns: true,
                    fileHistory: true,
                    isolatedWorktrees: false,
                    branchMerge: false,
                  },
                };
              case "workspace.trustStatus":
                return { trusted };
              case "workspace.trust":
                trusted = Boolean(params.trusted);
                return { trusted };
              case "session.list":
                return { sessions: [] };
              case "runs.list":
                return {
                  runs: started
                    ? [
                        {
                          runId: "run-folder",
                          description: "整理会议记录",
                          status: "running",
                          startedAt: Date.now(),
                          updatedAt: Date.now(),
                        },
                      ]
                    : [],
                };
              case "run.start":
                started = true;
                return { runId: "run-folder" };
              case "jobs.list":
                return { jobs: [] };
              case "config.skills":
                return { skills: [] };
              case "config.mcpServers":
                return { servers: [] };
              case "config.providers":
                return { providers: [] };
              case "config.get":
                return { version: 0 };
              case "usage.get":
                return { usage: {} };
              case "changes.list":
                return { changes: [] };
              default:
                return {};
            }
          })();
          return success(value);
        },
      },
    ) as RendererBridge["runtime"];
    const bridge: RendererBridge = {
      runtime,
      events: {
        subscribe: () => ({
          ready: success({ subscribed: true, events: [] }),
          dispose: vi.fn(),
        }),
      },
      platform: {
        chooseWorkspace: () => success(workspacePath),
        openDirectory: () => success(undefined),
        getLaunchAtLogin: () => success(false),
        setLaunchAtLogin: () => success(undefined),
      },
      lifecycle: {
        setBackgroundMode: () => success(undefined),
        quit: () => success(undefined),
      },
    };
    (window as unknown as { pico?: RendererBridge }).pico = bridge;

    render(<DesktopApp />);
    await user.click(await screen.findByRole("button", { name: "选择文件夹" }));

    expect(await screen.findByRole("heading", { name: "你信任这个项目的内容吗？" })).toBeTruthy();
    expect(screen.getByText("这个文件夹可以直接使用")).toBeTruthy();
    expect(screen.getByText(/不了解它也不影响现在开始/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "信任并继续" }));
    expect(await screen.findByRole("heading", { name: "今天想推进什么？" })).toBeTruthy();
    expect(screen.getByText(/文件处理与安全回退正常可用/)).toBeTruthy();

    await user.type(screen.getByLabelText("任务描述"), "整理会议记录");
    await user.click(screen.getByRole("button", { name: "开始任务" }));
    expect(await screen.findByRole("heading", { name: "整理会议记录" })).toBeTruthy();
    expect(screen.getByText("当前任务会正常执行")).toBeTruthy();
    expect(calls.some((call) => call.method === "workspace.register")).toBe(true);
    expect(calls.some((call) => call.method === "run.start")).toBe(true);
    expect(calls.some((call) => call.method === "session.create")).toBe(false);
  });

  it.each([
    ["/", "今天想推进什么？"],
    ["/task/new", "新任务"],
    ["/task/run-atlas", "修复同步冲突，并为关键失败路径补一条集成测试"],
    ["/review", "更改审阅"],
    ["/sessions", "会话工作库"],
    ["/automations", "Automations"],
    ["/skills", "Skills"],
    ["/mcp", "MCP 服务"],
    ["/providers", "模型 Providers"],
    ["/usage", "用量"],
    ["/settings", "设置"],
  ])("renders the full preview route %s", async (route, expectedText) => {
    window.history.replaceState({}, "", `/?demo=1#${route}`);
    render(<DesktopApp />);

    expect((await screen.findAllByText(expectedText)).length).toBeGreaterThan(0);
    expect(screen.getByText("Preview")).toBeTruthy();
  });
});
