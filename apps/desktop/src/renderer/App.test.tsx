// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopApp } from "./App.js";
import type { RendererBridge } from "./runtime.js";

const successful = <T,>(value: T) => Promise.resolve({ ok: true as const, value });

function installBridge(runtime: RendererBridge["runtime"]): void {
  (window as unknown as { pico?: RendererBridge }).pico = {
    runtime,
    events: {
      subscribe: () => ({ ready: successful({ subscribed: true }), dispose: vi.fn() }),
    },
    platform: {
      chooseWorkspace: () => successful(undefined),
      openDirectory: () => successful(undefined),
      getLaunchAtLogin: () => successful(false),
      setLaunchAtLogin: () => successful(undefined),
    },
    lifecycle: {
      setBackgroundMode: () => successful(undefined),
      quit: () => successful(undefined),
    },
  };
}

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
                          status: "succeeded",
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
                    status: "succeeded",
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
              case "catalog.skills":
                return {
                  skills: [
                    {
                      name: "review",
                      description: "审查指定文件",
                      allowedTools: ["read_file"],
                    },
                  ],
                };
              case "catalog.agents":
                return { agents: [] };
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
    expect(screen.getByText(/共享文件夹支持对话、工具和并行分析/)).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "消息" }), "整理会议记录");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect((await screen.findAllByText("整理会议记录")).length).toBeGreaterThan(0);
    expect(window.location.hash).toBe("#/session/session-folder");
    expect(calls.some((call) => call.method === "workspace.register")).toBe(true);
    expect(calls.some((call) => call.method === "session.send")).toBe(true);
    expect(calls.some((call) => call.method === "session.transcript")).toBe(true);
    expect(calls.some((call) => call.method === "session.create")).toBe(false);

    await user.click(screen.getByRole("button", { name: "添加 Skill 或子代理" }));
    await user.click(screen.getByRole("button", { name: /review/ }));
    await user.type(screen.getByRole("textbox", { name: "消息" }), "src/runtime.ts");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(calls.filter((call) => call.method === "session.send").at(-1)?.params.input).toEqual({
      kind: "skill",
      name: "review",
      args: "src/runtime.ts",
    });
  });

  it("使用同一 Transcript revision 分页加载更早记录", async () => {
    const user = userEvent.setup();
    const workspacePath = "/Users/chen/Documents/long-session";
    const transcriptCalls: Readonly<Record<string, unknown>>[] = [];
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
                sessions: [{ sessionId: "session-long", title: "长会话", updatedAt: 2 }],
              };
            if (method === "runs.list") return { runs: [] };
            if (method === "session.transcript") {
              transcriptCalls.push(params);
              return params.before
                ? {
                    session: { sessionId: "session-long" },
                    items: [{ id: "message-old", kind: "userMessage", content: "最早的记录" }],
                    queuedInputs: [],
                    revision: "revision-stable",
                  }
                : {
                    session: { sessionId: "session-long" },
                    items: [{ id: "message-new", kind: "assistantMessage", content: "最新的记录" }],
                    queuedInputs: [],
                    nextBefore: "cursor-older",
                    revision: "revision-stable",
                  };
            }
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return successful(value);
        },
      },
    ) as RendererBridge["runtime"];
    installBridge(runtime);
    window.history.replaceState({}, "", "/#/session/session-long");

    render(<DesktopApp />);
    expect(await screen.findByText("最新的记录")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更早记录" }));

    expect(await screen.findByText("最早的记录")).toBeTruthy();
    expect(screen.getByText("最新的记录")).toBeTruthy();
    expect(transcriptCalls.at(-1)).toEqual(
      expect.objectContaining({
        before: "cursor-older",
        expectedRevision: "revision-stable",
        limit: 200,
      }),
    );
    expect(screen.queryByRole("button", { name: "加载更早记录" })).toBeNull();
  });

  it("Transcript 分页发生 revision 冲突时从首页重载", async () => {
    const user = userEvent.setup();
    const workspacePath = "/Users/chen/Documents/changing-session";
    let firstPageLoads = 0;
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async (params: Readonly<Record<string, unknown>>) => {
          const method = String(property);
          if (method === "session.transcript" && params.before) {
            return {
              ok: false as const,
              error: {
                code: "CONFLICT",
                message: "会话历史已变化",
                retryable: true,
              },
            };
          }
          const value = (() => {
            if (method === "runtime.ping")
              return { capabilities: ["session-conversation-v1", "runtime-events-v1"] };
            if (method === "workspace.list") return { workspaces: [{ workspacePath }] };
            if (method === "workspace.status") return { workspacePath, mode: "folder" };
            if (method === "workspace.trustStatus") return { trusted: true };
            if (method === "session.list")
              return {
                sessions: [{ sessionId: "session-changing", title: "变化会话", updatedAt: 2 }],
              };
            if (method === "runs.list") return { runs: [] };
            if (method === "session.transcript") {
              firstPageLoads += 1;
              return firstPageLoads === 1
                ? {
                    session: { sessionId: "session-changing" },
                    items: [{ id: "message-a", kind: "userMessage", content: "旧版首页" }],
                    queuedInputs: [],
                    nextBefore: "cursor-stale",
                    revision: "revision-a",
                  }
                : {
                    session: { sessionId: "session-changing" },
                    items: [{ id: "message-b", kind: "userMessage", content: "新版首页" }],
                    queuedInputs: [],
                    revision: "revision-b",
                  };
            }
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return successful(value);
        },
      },
    ) as RendererBridge["runtime"];
    installBridge(runtime);
    window.history.replaceState({}, "", "/#/session/session-changing");

    render(<DesktopApp />);
    expect(await screen.findByText("旧版首页")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更早记录" }));

    expect(await screen.findByText("新版首页")).toBeTruthy();
    expect(screen.queryByText("旧版首页")).toBeNull();
    expect(screen.getByText(/已从最新版本重新加载/)).toBeTruthy();
  });

  it("发送失败时保留草稿，重试复用幂等键且成功后才清空", async () => {
    const user = userEvent.setup();
    const workspacePath = "/Users/chen/Documents/retry-send";
    const sendCalls: Readonly<Record<string, unknown>>[] = [];
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async (params: Readonly<Record<string, unknown>>) => {
          const method = String(property);
          if (method === "session.send") {
            sendCalls.push(params);
            if (sendCalls.length === 1) {
              return {
                ok: false as const,
                error: { code: "NETWORK", message: "连接暂时中断", retryable: true },
              };
            }
            return successful({
              session: { sessionId: "session-retry", title: "重试发送", updatedAt: 2 },
              disposition: "started",
            });
          }
          const value = (() => {
            if (method === "runtime.ping")
              return { capabilities: ["session-conversation-v1", "runtime-events-v1"] };
            if (method === "workspace.list") return { workspaces: [{ workspacePath }] };
            if (method === "workspace.status") return { workspacePath, mode: "folder" };
            if (method === "workspace.trustStatus") return { trusted: true };
            if (method === "session.list")
              return {
                sessions:
                  sendCalls.length > 1
                    ? [{ sessionId: "session-retry", title: "重试发送", updatedAt: 2 }]
                    : [],
              };
            if (method === "runs.list") return { runs: [] };
            if (method === "session.transcript")
              return {
                session: { sessionId: "session-retry" },
                items: [{ id: "retry-message", kind: "userMessage", content: "请继续处理" }],
                queuedInputs: [],
                revision: "revision-retry",
              };
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return successful(value);
        },
      },
    ) as RendererBridge["runtime"];
    installBridge(runtime);
    window.history.replaceState({}, "", "/#/task/new");

    render(<DesktopApp />);
    const textbox = await screen.findByRole("textbox", { name: "消息" });
    await user.type(textbox, "请继续处理");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByText(/NETWORK: 连接暂时中断/)).toBeTruthy();
    expect((textbox as HTMLTextAreaElement).value).toBe("请继续处理");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect((textbox as HTMLTextAreaElement).value).toBe(""));
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.idempotencyKey).toBe(sendCalls[1]?.idempotencyKey);
    expect(window.location.hash).toBe("#/session/session-retry");
  });

  it("映射持久化审批与提问的完成状态，并保留会话作为唯一标题栏", async () => {
    const workspacePath = "/Users/chen/Documents/interaction-state";
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async () => {
          const method = String(property);
          const value = (() => {
            if (method === "runtime.ping")
              return { capabilities: ["session-conversation-v1", "runtime-events-v1"] };
            if (method === "workspace.list") return { workspaces: [{ workspacePath }] };
            if (method === "workspace.status") return { workspacePath, mode: "folder" };
            if (method === "workspace.trustStatus") return { trusted: true };
            if (method === "session.list")
              return {
                sessions: [{ sessionId: "session-interactions", title: "交互状态", updatedAt: 2 }],
              };
            if (method === "runs.list") return { runs: [] };
            if (method === "session.transcript")
              return {
                session: { sessionId: "session-interactions" },
                items: [
                  {
                    id: "approval-once-entry",
                    kind: "approval",
                    title: "单次允许",
                    state: "allow_once",
                    data: { approvalId: "approval-once", decision: "allow_once" },
                  },
                  {
                    id: "approval-session-entry",
                    kind: "approval",
                    title: "会话允许",
                    state: "allow_session",
                    data: { approvalId: "approval-session", decision: "allow_session" },
                  },
                  {
                    id: "approval-denied-entry",
                    kind: "approval",
                    title: "拒绝执行",
                    state: "deny",
                    data: { approvalId: "approval-denied", decision: "deny" },
                  },
                  {
                    id: "prompt-answered-entry",
                    kind: "prompt",
                    title: "选择实现方式",
                    state: "resolved",
                    data: { promptId: "prompt-answered" },
                  },
                ],
                queuedInputs: [],
                revision: "revision-interactions",
              };
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return successful(value);
        },
      },
    ) as RendererBridge["runtime"];
    installBridge(runtime);
    window.history.replaceState({}, "", "/#/session/session-interactions");

    render(<DesktopApp />);

    expect(await screen.findByRole("heading", { level: 1, name: "交互状态" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "会话" })).toBeNull();
    expect(await screen.findAllByText("已允许")).toHaveLength(2);
    expect(screen.getByText("已拒绝")).toBeTruthy();
    expect(screen.getByText("已回答")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "处理审批" })).toBeNull();
    expect(screen.queryByRole("button", { name: "回答问题" })).toBeNull();
  });

  it("忽略过期会话响应，并在权威 Transcript 无 activeRun 时清除旧运行态", async () => {
    const workspacePath = "/Users/chen/Documents/conversation-race";
    let eventListener: ((event: unknown) => void) | undefined;
    let transcriptLoads = 0;
    let resolveFirstTranscript:
      | ((result: { readonly ok: true; readonly value: unknown }) => void)
      | undefined;
    const firstTranscript = new Promise<{ readonly ok: true; readonly value: unknown }>(
      (resolve) => {
        resolveFirstTranscript = resolve;
      },
    );
    const runtime = new Proxy(
      {},
      {
        get: (_target, property) => async () => {
          const method = String(property);
          if (method === "session.transcript") {
            transcriptLoads += 1;
            if (transcriptLoads === 1) return firstTranscript;
            return successful({
              session: { sessionId: "session-race" },
              items: [{ id: "latest-message", kind: "assistantMessage", content: "最新会话响应" }],
              queuedInputs: [],
              revision: "revision-latest",
            });
          }
          const value = (() => {
            if (method === "runtime.ping")
              return { capabilities: ["session-conversation-v1", "runtime-events-v1"] };
            if (method === "workspace.list") return { workspaces: [{ workspacePath }] };
            if (method === "workspace.status") return { workspacePath, mode: "folder" };
            if (method === "workspace.trustStatus") return { trusted: true };
            if (method === "session.list")
              return {
                sessions: [{ sessionId: "session-race", title: "竞态会话", updatedAt: 2 }],
              };
            if (method === "runs.list")
              return {
                runs: [
                  {
                    runId: "run-stale",
                    sessionId: "session-race",
                    description: "过期运行",
                    status: "running",
                  },
                ],
              };
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return successful(value);
        },
      },
    ) as RendererBridge["runtime"];
    (window as unknown as { pico?: RendererBridge }).pico = {
      runtime,
      events: {
        subscribe: (_params, listener) => {
          eventListener = listener;
          return { ready: successful({ subscribed: true }), dispose: vi.fn() };
        },
      },
      platform: {
        chooseWorkspace: () => successful(undefined),
        openDirectory: () => successful(undefined),
        getLaunchAtLogin: () => successful(false),
        setLaunchAtLogin: () => successful(undefined),
      },
      lifecycle: {
        setBackgroundMode: () => successful(undefined),
        quit: () => successful(undefined),
      },
    };
    window.history.replaceState({}, "", "/#/session/session-race");

    render(<DesktopApp />);
    await waitFor(() => expect(transcriptLoads).toBe(1));
    eventListener?.({
      eventId: "run-finished-race",
      topic: "run.finished",
      scope: { workspacePath, sessionId: "session-race", runId: "run-stale" },
      payload: { runId: "run-stale" },
    });

    expect(await screen.findByText("最新会话响应")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "停止运行" })).toBeNull();
    expect(screen.queryByText("Pico 正在工作")).toBeNull();

    await act(async () => {
      resolveFirstTranscript?.(
        await successful({
          session: { sessionId: "session-race" },
          items: [{ id: "stale-message", kind: "assistantMessage", content: "过期会话响应" }],
          activeRun: {
            runId: "run-stale",
            sessionId: "session-race",
            description: "过期运行",
            status: "running",
          },
          queuedInputs: [],
          revision: "revision-stale",
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("最新会话响应")).toBeTruthy();
    expect(screen.queryByText("过期会话响应")).toBeNull();
    expect(screen.queryByRole("button", { name: "停止运行" })).toBeNull();
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
      eventId: "approval-requested-shared-id",
      topic: "approval.requested",
      scope: { workspacePath: "/Users/other/project", sessionId: "session-b", runId: "run-b" },
      payload: {
        approvalId: "approval-foreign",
        runId: "run-b",
        request: { title: "不应显示的审批", detail: "来自另一个工作区" },
      },
    });
    expect(screen.queryByText("不应显示的审批")).toBeNull();
    eventListener?.({
      eventId: "approval-requested-shared-id",
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
    expect(await screen.findByText("已允许")).toBeTruthy();
    eventListener?.({
      eventId: "prompt-requested-b",
      topic: "prompt.requested",
      scope: { workspacePath, sessionId: "session-b", runId: "run-b" },
      payload: {
        promptId: "prompt-b",
        runId: "run-b",
        prompt: { question: "继续审阅 B？", options: ["继续", "停止"] },
      },
    });
    expect(await screen.findByRole("button", { name: "回答问题" })).toBeTruthy();
    eventListener?.({
      eventId: "prompt-resolved-b",
      topic: "prompt.resolved",
      scope: { workspacePath, sessionId: "session-b", runId: "run-b" },
      payload: { promptId: "prompt-b" },
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "回答问题" })).toBeNull());
    expect(await screen.findByText("已回答")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "审阅更改" }));
    expect(await screen.findByText("b.ts")).toBeTruthy();
    expect(screen.queryByText("a.ts")).toBeNull();
    await user.click(screen.getByRole("button", { name: "批准更改" }));

    expect(reviewCalls).toEqual([
      expect.objectContaining({ runId: "run-b", expectedFingerprint: "fingerprint-b" }),
    ]);
  });

  it("Rewind 成功后立即重新加载当前 Session Transcript", async () => {
    const user = userEvent.setup();
    const workspacePath = "/Users/chen/Documents/rewind-project";
    let transcriptLoads = 0;
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
                sessions: [{ sessionId: "session-rewind", title: "回滚会话", updatedAt: 2 }],
              };
            if (method === "runs.list")
              return {
                runs: [
                  {
                    runId: "run-rewind",
                    sessionId: "session-rewind",
                    description: "回滚会话",
                    status: "succeeded",
                  },
                ],
              };
            if (method === "session.transcript") {
              transcriptLoads += 1;
              return {
                session: { sessionId: "session-rewind", title: "回滚会话", updatedAt: 2 },
                items: [
                  {
                    id: `message-${transcriptLoads}`,
                    kind: "assistantMessage",
                    content: transcriptLoads > 1 ? "回滚后的对话" : "即将回滚的对话",
                  },
                ],
                activeRun: {
                  runId: "run-rewind",
                  sessionId: "session-rewind",
                  description: "回滚会话",
                  status: "succeeded",
                },
                queuedInputs: [],
                revision: `revision-${transcriptLoads}`,
              };
            }
            if (method === "changes.list")
              return {
                changes: [
                  {
                    path: "src/rewind.ts",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                  },
                ],
                fingerprint: "changes-fingerprint",
              };
            if (method === "changes.diff")
              return { path: params.path, patch: "+replacement\n-obsolete" };
            if (method === "rewind.list")
              return { checkpoints: [{ checkpointId: "checkpoint-1", createdAt: 2 }] };
            if (method === "rewind.preview")
              return { fingerprint: "rewind-fingerprint", changes: [{ path: "src/rewind.ts" }] };
            if (method === "rewind.apply") return { applied: true };
            if (method === "jobs.list") return { jobs: [] };
            if (method === "config.skills") return { skills: [] };
            if (method === "config.mcpServers") return { servers: [] };
            if (method === "config.providers") return { providers: [] };
            if (method === "config.get") return { version: 0 };
            if (method === "usage.get") return { usage: {} };
            return {};
          })();
          return successful(value);
        },
      },
    ) as RendererBridge["runtime"];
    installBridge(runtime);
    window.history.replaceState({}, "", "/#/session/session-rewind");

    render(<DesktopApp />);
    await screen.findByText("即将回滚的对话");
    await user.click(screen.getByRole("button", { name: "审阅更改" }));
    await user.click(await screen.findByRole("button", { name: "Rewind" }));
    await user.click(screen.getByRole("button", { name: "预览 Rewind" }));
    await user.click(await screen.findByRole("button", { name: "确认 Rewind" }));

    await waitFor(() => expect(transcriptLoads).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/已回到检查点/)).toBeTruthy();
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
