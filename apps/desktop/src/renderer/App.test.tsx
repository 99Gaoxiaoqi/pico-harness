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
    await user.click(screen.getByRole("button", { name: "处理审批" }));
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

  it("让普通文件夹完成选择、信任和首次会话发送的主路径", async () => {
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
                return {
                  version: "test",
                  capabilities: ["session-conversation-v1", "runtime-events-v1"],
                };
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
                return {
                  sessions: started
                    ? [
                        {
                          sessionId: "session-folder",
                          title: "整理会议记录",
                          status: "active",
                          updatedAt: Date.now(),
                        },
                      ]
                    : [],
                };
              case "runs.list":
                return {
                  runs: started
                    ? [
                        {
                          runId: "run-folder",
                          sessionId: "session-folder",
                          description: "整理会议记录",
                          status: "running",
                          startedAt: Date.now(),
                          updatedAt: Date.now(),
                        },
                      ]
                    : [],
                };
              case "session.send":
                started = true;
                return {
                  session: {
                    sessionId: "session-folder",
                    title: "整理会议记录",
                    status: "active",
                    updatedAt: Date.now(),
                  },
                  run: {
                    runId: "run-folder",
                    sessionId: "session-folder",
                    description: "整理会议记录",
                    status: "running",
                    startedAt: Date.now(),
                    updatedAt: Date.now(),
                  },
                  disposition: "started",
                };
              case "session.transcript":
                return {
                  session: {
                    sessionId: "session-folder",
                    title: "整理会议记录",
                    status: "active",
                    updatedAt: Date.now(),
                  },
                  items: [
                    {
                      id: "message-folder",
                      kind: "userMessage",
                      content: "整理会议记录",
                    },
                  ],
                  queuedInputs: [],
                  revision: "revision-folder",
                };
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
    expect(screen.getByText(/共享文件夹支持对话、工具和并行子代理/)).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "消息" }), "整理会议记录");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect((await screen.findAllByText("整理会议记录")).length).toBeGreaterThan(0);
    expect(window.location.hash).toBe("#/session/session-folder");
    expect(calls.some((call) => call.method === "workspace.register")).toBe(true);
    expect(calls.some((call) => call.method === "session.send")).toBe(true);
    expect(calls.some((call) => call.method === "session.transcript")).toBe(true);
    expect(calls.some((call) => call.method === "session.create")).toBe(false);
  });

  it("按 Session 隔离 Changes，并使用所属 Run 的指纹审批", async () => {
    const user = userEvent.setup();
    const reviewCalls: Readonly<Record<string, unknown>>[] = [];
    let eventListener: ((event: unknown) => void) | undefined;
    const success = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
    const workspacePath = "/Users/chen/Documents/project";
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async (params: Readonly<Record<string, unknown>>) => {
          const method = String(property);
          const value = (() => {
            if (method === "runtime.ping")
              return { capabilities: ["session-conversation-v1", "runtime-events-v1"] };
            if (method === "workspace.list") return { workspaces: [{ workspacePath }] };
            if (method === "workspace.status") return { workspacePath, mode: "folder" };
            if (method === "workspace.trustStatus") return { trusted: true };
            if (method === "session.list")
              return {
                sessions: [
                  { sessionId: "session-a", title: "会话 A", updatedAt: 1 },
                  { sessionId: "session-b", title: "会话 B", updatedAt: 2 },
                ],
              };
            if (method === "runs.list")
              return {
                runs: [
                  {
                    runId: "run-a",
                    sessionId: "session-a",
                    description: "A",
                    status: "succeeded",
                  },
                  {
                    runId: "run-b",
                    sessionId: "session-b",
                    description: "B",
                    status: "running",
                  },
                ],
              };
            if (method === "session.transcript")
              return {
                session: { sessionId: "session-b", title: "会话 B", updatedAt: 2 },
                items: [{ id: "b-message", kind: "userMessage", content: "只改 B" }],
                activeRun: {
                  runId: "run-b",
                  sessionId: "session-b",
                  description: "B",
                  status: "running",
                },
                queuedInputs: [],
                revision: "revision-b",
              };
            if (method === "changes.list") {
              const runId = String(params.runId);
              return {
                changes: [
                  {
                    path: runId === "run-b" ? "src/b.ts" : "src/a.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 0,
                  },
                ],
                fingerprint: runId === "run-b" ? "fingerprint-b" : "fingerprint-a",
              };
            }
            if (method === "changes.diff")
              return { path: params.path, patch: `+${String(params.path)}` };
            if (method === "changes.review") {
              reviewCalls.push(params);
              return { accepted: true, fingerprint: params.expectedFingerprint };
            }
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return success(value);
        },
      },
    ) as RendererBridge["runtime"];
    (window as unknown as { pico?: RendererBridge }).pico = {
      runtime,
      events: {
        subscribe: (_params, listener) => {
          eventListener = listener;
          return {
            ready: success({ subscribed: true, events: [] }),
            dispose: vi.fn(),
          };
        },
      },
      platform: {
        chooseWorkspace: () => success(undefined),
        openDirectory: () => success(undefined),
        getLaunchAtLogin: () => success(false),
        setLaunchAtLogin: () => success(undefined),
      },
      lifecycle: {
        setBackgroundMode: () => success(undefined),
        quit: () => success(undefined),
      },
    };
    window.history.replaceState({}, "", "/#/session/session-b");

    render(<DesktopApp />);
    await screen.findByText("只改 B");
    eventListener?.({
      eventId: "approval-requested-b",
      topic: "approval.requested",
      scope: { workspacePath, sessionId: "session-b", runId: "run-b" },
      payload: {
        approvalId: "approval-b",
        runId: "run-b",
        request: { title: "批准 B", detail: "只属于 B" },
      },
    });
    expect(await screen.findByRole("button", { name: "处理审批" })).toBeTruthy();
    eventListener?.({
      eventId: "approval-resolved-b",
      topic: "approval.resolved",
      scope: { workspacePath, sessionId: "session-b", runId: "run-b" },
      payload: { approvalId: "approval-b", decision: "allow_once" },
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "处理审批" })).toBeNull());
    await user.click(await screen.findByRole("button", { name: "审阅更改" }));
    expect(await screen.findByText("b.ts")).toBeTruthy();
    expect(screen.queryByText("a.ts")).toBeNull();
    await user.click(screen.getByRole("button", { name: "批准更改" }));

    expect(reviewCalls).toEqual([
      expect.objectContaining({ runId: "run-b", expectedFingerprint: "fingerprint-b" }),
    ]);
  });

  it("会话不存在时显示可重试的恢复错误，不回到首页冒充成功", async () => {
    const workspacePath = "/Users/chen/Documents/project";
    const success = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async () => {
          const method = String(property);
          if (method === "session.transcript") {
            return {
              ok: false as const,
              error: { code: "NOT_FOUND", message: "Session missing 不存在", retryable: false },
            };
          }
          const value =
            method === "runtime.ping"
              ? { capabilities: ["session-conversation-v1", "runtime-events-v1"] }
              : method === "workspace.list"
                ? { workspaces: [{ workspacePath }] }
                : method === "workspace.status"
                  ? { workspacePath, mode: "folder" }
                  : method === "workspace.trustStatus"
                    ? { trusted: true }
                    : method === "session.list"
                      ? { sessions: [] }
                      : method === "runs.list"
                        ? { runs: [] }
                        : method === "config.skills"
                          ? { skills: [] }
                          : method === "config.mcpServers"
                            ? { servers: [] }
                            : method === "config.providers"
                              ? { providers: [] }
                              : method === "jobs.list"
                                ? { jobs: [] }
                                : method === "config.get"
                                  ? { version: 0 }
                                  : method === "usage.get"
                                    ? { usage: {} }
                                    : {};
          return { ok: true as const, value };
        },
      },
    ) as RendererBridge["runtime"];
    (window as unknown as { pico?: RendererBridge }).pico = {
      runtime,
      events: {
        subscribe: () => ({ ready: success({ subscribed: true }), dispose: vi.fn() }),
      },
      platform: {
        chooseWorkspace: () => success(undefined),
        openDirectory: () => success(undefined),
        getLaunchAtLogin: () => success(false),
        setLaunchAtLogin: () => success(undefined),
      },
      lifecycle: {
        setBackgroundMode: () => success(undefined),
        quit: () => success(undefined),
      },
    };
    window.history.replaceState({}, "", "/#/session/missing");

    render(<DesktopApp />);

    expect(await screen.findByRole("heading", { name: "无法恢复这个会话" })).toBeTruthy();
    expect(screen.getAllByText(/Session missing 不存在/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "重新载入" })).toBeTruthy();
    expect(window.location.hash).toBe("#/session/missing");
  });

  it.each([
    ["/", "今天想推进什么？"],
    ["/task/new", "今天想一起做什么？"],
    ["/task/run-atlas", "修复同步冲突并补充回归测试"],
    ["/session/session-atlas", "修复同步冲突并补充回归测试"],
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
