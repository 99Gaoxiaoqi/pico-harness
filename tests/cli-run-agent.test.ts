import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalManager,
  globalApprovalManager,
  type ApprovalNotice,
} from "../src/approval/manager.js";
import { buildApprovalMiddleware, runAgentFromCli } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import type { Reporter } from "../src/engine/reporter.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import type { LLMProvider } from "../src/provider/interface.js";
import {
  getOrCreateSessionSettings,
  getStoredSessionSettings,
  resetSessionSettingsForTests,
} from "../src/input/session-settings.js";
import { createTuiRuntimeState } from "../src/tui/runtime-state.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: Message[]; toolNames: string[] }> = [];

  constructor(private readonly responses: Message[]) {}

  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push({
      messages: [...messages],
      toolNames: availableTools.map((tool) => tool.name),
    });
    const next = this.responses.shift();

    if (!next) {
      throw new Error("No scripted provider response left.");
    }

    return Promise.resolve(next);
  }
}

class BlockingProvider implements LLMProvider {
  readonly calls: Array<{ messages: Message[]; toolNames: string[] }> = [];
  private readonly firstStarted: () => void;
  private releaseFirst!: () => void;
  readonly firstCallStarted: Promise<void>;
  readonly firstCallRelease: Promise<void>;

  constructor() {
    this.firstCallStarted = new Promise((resolve) => {
      this.firstStarted = resolve;
    });
    this.firstCallRelease = new Promise((resolve) => {
      this.releaseFirst = resolve;
    });
  }

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push({
      messages: [...messages],
      toolNames: availableTools.map((tool) => tool.name),
    });
    if (this.calls.length === 1) {
      this.firstStarted();
      await this.firstCallRelease;
      return {
        role: "assistant",
        content: "first done",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    }

    return {
      role: "assistant",
      content: "second done",
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }

  release(): void {
    this.releaseFirst();
  }
}

function reporter(onTextDelta?: (delta: string) => void): Reporter {
  return {
    onThinking() {},
    onToolCall() {},
    onToolResult() {},
    onMessage() {},
    onStart() {},
    onTurnStart() {},
    onFinish() {},
    ...(onTextDelta ? { onTextDelta } : {}),
  };
}

function makeApprovalCapture(): {
  notices: ApprovalNotice[];
  notifier: (notice: ApprovalNotice) => void;
  nextNotice: Promise<ApprovalNotice>;
} {
  const notices: ApprovalNotice[] = [];
  let resolveNotice!: (notice: ApprovalNotice) => void;
  const nextNotice = new Promise<ApprovalNotice>((resolve) => {
    resolveNotice = resolve;
  });
  return {
    notices,
    nextNotice,
    notifier: (notice) => {
      notices.push(notice);
      resolveNotice(notice);
    },
  };
}

async function waitForApprovalBeforeCompletion<T>(
  nextNotice: Promise<ApprovalNotice>,
  runPromise: Promise<T>,
): Promise<ApprovalNotice> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      nextNotice,
      runPromise.then(
        () => {
          throw new Error("agent run completed before requesting approval");
        },
        (err) => {
          throw err;
        },
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for approval")), 3000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function useDefaultInteractionMode(sessionId: string, workDir: string): Promise<void> {
  getOrCreateSessionSettings({
    sessionId,
    cwd: await realpath(workDir),
    provider: "openai",
    model: "glm-5.2",
    mode: "default",
  });
}

describe("runAgentFromCli", () => {
  afterEach(() => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
  });

  it("allowedTools 只暴露本轮允许的工具，空列表允许纯文本运行", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-command-tools-"));
    const provider = new ScriptedProvider([
      { role: "assistant", content: "read only" },
      { role: "assistant", content: "text only" },
    ]);

    await runAgentFromCli(
      {
        prompt: "review",
        dir: workDir,
        session: "command-tools-read",
        provider: "openai",
        allowedTools: ["read_file"],
      },
      { provider },
    );
    await runAgentFromCli(
      {
        prompt: "summarize",
        dir: workDir,
        session: "command-tools-none",
        provider: "openai",
        allowedTools: [],
      },
      { provider },
    );

    expect(provider.calls[0]?.toolNames).toEqual(["read_file"]);
    expect(provider.calls[1]?.toolNames).toEqual([]);
  });

  it("allowedTools 含未知或空工具名时在 Provider 调用前失败", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-command-tools-invalid-"));
    const provider = new ScriptedProvider([{ role: "assistant", content: "must not run" }]);

    await expect(
      runAgentFromCli(
        {
          prompt: "review",
          dir: workDir,
          session: "command-tools-unknown",
          provider: "openai",
          allowedTools: ["not_a_tool"],
        },
        { provider },
      ),
    ).rejects.toThrow("未知工具: not_a_tool");
    await expect(
      runAgentFromCli(
        {
          prompt: "review",
          dir: workDir,
          session: "command-tools-empty",
          provider: "openai",
          allowedTools: [""],
        },
        { provider },
      ),
    ).rejects.toThrow("allowed-tools 含空值");
    expect(provider.calls).toHaveLength(0);
  });

  it("reuses session-scoped goal state, prompt memory and late tool status", async () => {
    const workDir = await realpath(await mkdtemp(join(tmpdir(), "pico-cli-runtime-state-")));
    const sessionId = "runtime-state-session";
    const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    const runtimeState = await createTuiRuntimeState({ workDir, sessionId, session });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "create persistent goal",
        toolCalls: [
          {
            id: "create-runtime-goal",
            name: "create_goal",
            arguments: JSON.stringify({
              title: "Persistent TUI goal",
              description: "must survive the next prompt",
            }),
          },
        ],
      },
      { role: "assistant", content: "goal created" },
      { role: "assistant", content: "goal still visible" },
    ]);
    const toolSnapshots: string[][] = [];

    await runAgentFromCli(
      { prompt: "create it", dir: workDir, session: sessionId, provider: "openai" },
      {
        provider,
        runtimeState,
        toolStatusSink: (tools) => toolSnapshots.push(tools.map((tool) => tool.name)),
      },
    );
    await runAgentFromCli(
      { prompt: "continue it", dir: workDir, session: sessionId, provider: "openai" },
      { provider, runtimeState },
    );

    expect(runtimeState.goalManager.getActive()?.title).toBe("Persistent TUI goal");
    expect(provider.calls[2]?.messages[0]?.content).toContain("Persistent TUI goal");
    expect(toolSnapshots.at(-1)).toEqual(
      expect.arrayContaining(["delegate_task", "delegate_status", "spawn_subagent"]),
    );

    await runtimeState.dispose();
  });

  it("已中止 signal 会阻止新 run 调用 provider", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-aborted-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "should not run",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const controller = new AbortController();
    controller.abort(new DOMException("interrupted", "AbortError"));

    await expect(
      runAgentFromCli(
        {
          prompt: "do not start",
          dir: workDir,
          session: "aborted-session",
          provider: "openai",
        },
        {
          provider,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(provider.calls).toHaveLength(0);
  });

  it("同 provider call id 的并发普通审批可独立 approve/reject", async () => {
    const manager = new ApprovalManager(100);
    const notices: ApprovalNotice[] = [];
    let resolveNotices!: () => void;
    const noticesReady = new Promise<void>((resolve) => {
      resolveNotices = resolve;
    });
    const middleware = buildApprovalMiddleware(
      (notice) => {
        notices.push(notice);
        if (notices.length === 2) resolveNotices();
      },
      process.cwd(),
      undefined,
      manager,
    );
    const duplicateCall = {
      id: "gemini-call-0",
      name: "write_file",
      arguments: JSON.stringify({ path: "same-call-id.txt", content: "collision test" }),
    };

    try {
      const approvals = [middleware(duplicateCall), middleware({ ...duplicateCall })];
      await noticesReady;
      const decisions = [
        manager.resolveApproval(notices[0]!.taskId, true, "approve first"),
        manager.resolveApproval(notices[1]!.taskId, false, "reject second"),
      ];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        Promise.all(approvals).then((results) => ({ state: "settled" as const, results })),
        new Promise<{ state: "timed-out" }>((resolve) => {
          timeout = setTimeout(() => resolve({ state: "timed-out" }), 150);
        }),
      ]);
      if (timeout) clearTimeout(timeout);

      expect({
        uniqueIds: new Set(notices.map((notice) => notice.taskId)).size,
        decisions,
        state: outcome.state,
        allowed:
          outcome.state === "settled"
            ? outcome.results.map((result) => result.allowed).sort()
            : undefined,
      }).toEqual({
        uniqueIds: 2,
        decisions: [true, true],
        state: "settled",
        allowed: [false, true],
      });
    } finally {
      manager.clear();
    }
  });

  it("runs a request in the selected workdir and returns the trace path when trace is explicit", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will create the answer file.",
        toolCalls: [
          {
            id: "call_write",
            name: "write_file",
            arguments: JSON.stringify({
              path: "answer.txt",
              content: "hello from cli",
            }),
          },
        ],
        usage: { promptTokens: 10, completionTokens: 4 },
      },
      {
        role: "assistant",
        content: "Done.",
        usage: { promptTokens: 12, completionTokens: 3 },
      },
    ]);
    const write = vi.fn();
    const approvalNotifier = (notice: ApprovalNotice) => {
      write(notice.message);
      globalApprovalManager.resolveApproval(notice.taskId, true, "test approval");
    };

    const result = await runAgentFromCli(
      {
        prompt: "Create answer.txt",
        dir: workDir,
        session: "cli_session",
        model: "glm-5.2",
        planMode: true,
        trace: true,
      },
      {
        provider,
        approvalNotifier,
      },
    );

    expect(await readFile(join(workDir, "answer.txt"), "utf8")).toBe("hello from cli");
    expect(result).toMatchObject({
      sessionId: "cli_session",
      workDir: await realpath(workDir),
      finalMessage: "Done.",
      usage: {
        promptTokens: 22,
        completionTokens: 7,
      },
    });
    const tracesDirectory = resolvePicoPaths(workDir).workspace.traces;
    expect(result.tracePath).toContain(tracesDirectory);
    expect(await readdir(tracesDirectory)).toHaveLength(1);
    expect(provider.calls[0]?.toolNames).toEqual(
      expect.arrayContaining([
        "bash",
        "read_file",
        "write_file",
        "edit_file",
        "delegate_task",
        "search_tools",
      ]),
    );
    expect(provider.calls[0]?.toolNames).not.toContain("task_list");
    expect(provider.calls[0]?.messages[0]?.content).toContain("PLAN.md");
    expect(write).not.toHaveBeenCalled();
  });

  it("write_file requests approval before writing", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-approval-write-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write a file.",
        toolCalls: [
          {
            id: "call_write_approval",
            name: "write_file",
            arguments: JSON.stringify({ path: "approval.txt", content: "secret" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Saw rejection.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    await useDefaultInteractionMode("approval_write_session", workDir);

    const runPromise = runAgentFromCli(
      {
        prompt: "Write approval.txt",
        dir: workDir,
        session: "approval_write_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    expect(globalApprovalManager.pendingCount).toBe(1);
    expect(notice).toMatchObject({
      taskId: expect.stringMatching(/^approval_[0-9a-f-]+$/),
      toolName: "write_file",
    });
    expect(notice.preview?.target).toBe("approval.txt");
    expect(notice.preview?.summary).toContain("write_file");
    expect(notice.diff).toContain("+ secret");
    expect(notice.preview?.diff).toBe(notice.diff);
    await expect(readFile(join(workDir, "approval.txt"), "utf8")).rejects.toThrow();

    globalApprovalManager.resolveApproval(notice.taskId, false, "test rejection");
    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Saw rejection." });
    await expect(readFile(join(workDir, "approval.txt"), "utf8")).rejects.toThrow();
  });

  it("默认 yolo 不弹审批且允许普通外部写入", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-boundary-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pico-cli-boundary-outside-"));
    const outsideFile = join(outsideDir, "allowed.txt");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write outside.",
        toolCalls: [
          {
            id: "call_outside_yolo",
            name: "write_file",
            arguments: JSON.stringify({ path: outsideFile, content: "allowed" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Outside write done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn();

    const result = await runAgentFromCli(
      {
        prompt: "Write outside",
        dir: workDir,
        session: "outside_boundary_session",
        provider: "openai",
      },
      { provider, approvalNotifier },
    );

    expect(result.finalMessage).toBe("Outside write done.");
    expect(approvalNotifier).not.toHaveBeenCalled();
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("allowed");
  });

  it("附加目录中的写入进入正常审批并可执行", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-added-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pico-cli-added-outside-"));
    const outsideFile = join(outsideDir, "allowed.txt");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write the authorized file.",
        toolCalls: [
          {
            id: "call_outside_allowed",
            name: "write_file",
            arguments: JSON.stringify({ path: outsideFile, content: "allowed" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Authorized write done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn((notice: ApprovalNotice) => {
      globalApprovalManager.resolveApproval(notice.taskId, true, "authorized test directory");
    });
    await useDefaultInteractionMode("added_boundary_session", workDir);

    const result = await runAgentFromCli(
      {
        prompt: "Write authorized external file",
        dir: workDir,
        session: "added_boundary_session",
        provider: "openai",
        addDirs: [outsideDir],
      },
      { provider, approvalNotifier },
    );

    expect(result.finalMessage).toBe("Authorized write done.");
    expect(approvalNotifier).toHaveBeenCalledOnce();
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("allowed");
  });

  it("从 .pico/config.json 加载 additionalDirectories", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-config-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pico-cli-config-outside-"));
    const outsideFile = join(outsideDir, "configured.txt");
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({ permissions: { additionalDirectories: [outsideDir] } }),
    );
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will use the configured directory.",
        toolCalls: [
          {
            id: "call_configured_outside",
            name: "write_file",
            arguments: JSON.stringify({ path: outsideFile, content: "configured" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Configured write done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn((notice: ApprovalNotice) => {
      globalApprovalManager.resolveApproval(notice.taskId, true, "configured directory");
    });
    await useDefaultInteractionMode("configured_boundary_session", workDir);

    await runAgentFromCli(
      {
        prompt: "Write configured external file",
        dir: workDir,
        session: "configured_boundary_session",
        provider: "openai",
      },
      { provider, approvalNotifier },
    );

    expect(approvalNotifier).toHaveBeenCalledOnce();
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("configured");
  });

  it("按 config、CLI、session 顺序合并附加目录", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-root-order-"));
    const configDir = await mkdtemp(join(tmpdir(), "pico-cli-config-order-"));
    const cliDir = await mkdtemp(join(tmpdir(), "pico-cli-arg-order-"));
    const sessionDir = await mkdtemp(join(tmpdir(), "pico-cli-session-order-"));
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({ permissions: { additionalDirectories: [configDir] } }),
    );
    getOrCreateSessionSettings({
      sessionId: "additional_directory_order",
      cwd: await realpath(workDir),
      provider: "openai",
      model: "glm-5.2",
      additionalDirectories: [sessionDir],
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "No tools needed.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);

    await runAgentFromCli(
      {
        prompt: "Reply without tools",
        dir: workDir,
        session: "additional_directory_order",
        provider: "openai",
        addDirs: [cliDir],
      },
      { provider },
    );

    expect(getStoredSessionSettings("additional_directory_order")?.additionalDirectories).toEqual([
      await realpath(configDir),
      await realpath(cliDir),
      await realpath(sessionDir),
    ]);
  });

  it("审批等待期间 abort 会取消任务且晚批准不执行危险工具", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-approval-abort-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write a file.",
        toolCalls: [
          {
            id: "call_write_abort",
            name: "write_file",
            arguments: JSON.stringify({ path: "must-not-exist.txt", content: "danger" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    const controller = new AbortController();
    await useDefaultInteractionMode("approval_abort_session", workDir);
    const runPromise = runAgentFromCli(
      {
        prompt: "Write must-not-exist.txt",
        dir: workDir,
        session: "approval_abort_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
        signal: controller.signal,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    controller.abort(new DOMException("interrupted", "AbortError"));
    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });
    const pendingAfterAbort = globalApprovalManager.pendingCount;
    const lateApproval = globalApprovalManager.resolveApproval(notice.taskId, true, "late approve");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fileContent = await readFile(join(workDir, "must-not-exist.txt"), "utf8").catch(
      () => undefined,
    );

    expect(pendingAfterAbort).toBe(0);
    expect(lateApproval).toBe(false);
    expect(fileContent).toBeUndefined();
  });

  it("exit_plan_mode 内部审批使用本轮 signal", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-plan-exit-abort-"));
    const originalPlan = "# 原计划\n不应被晚到审批修改";
    await writeFile(join(workDir, "PLAN.md"), originalPlan, "utf8");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Submit the plan.",
        toolCalls: [{ id: "call_exit_plan_abort", name: "exit_plan_mode", arguments: "{}" }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "must not continue",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    const approvalManager = new ApprovalManager(60_000);
    const cancelApproval = vi.spyOn(approvalManager, "cancelApproval");
    const controller = new AbortController();
    const runPromise = runAgentFromCli(
      {
        prompt: "Submit PLAN.md",
        dir: workDir,
        session: "plan_exit_abort_session",
        provider: "openai",
        planMode: true,
      },
      {
        provider,
        approvalManager,
        approvalNotifier: approval.notifier,
        signal: controller.signal,
      },
    );
    const outcomePromise = runPromise.then(
      (result) => result,
      (error: unknown) => error,
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    controller.abort(new DOMException("interrupted", "AbortError"));
    await Promise.resolve();
    const pendingAfterAbort = approvalManager.pendingCount;
    const lateModify = approvalManager.resolveApprovalWithModify(
      notice.taskId,
      "late modify",
      "# 不应写入",
    );
    const lateApprove = approvalManager.resolveApproval(notice.taskId, true, "late approve");
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({ name: "AbortError" });
    expect(pendingAfterAbort).toBe(0);
    expect(cancelApproval).toHaveBeenCalledWith(
      notice.taskId,
      "审批请求已因本轮中止而取消。",
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(lateModify).toBe(false);
    expect(lateApprove).toBe(false);
    expect(globalApprovalManager.pendingCount).toBe(0);
    expect(provider.calls).toHaveLength(1);
    await expect(readFile(join(workDir, "PLAN.md"), "utf8")).resolves.toBe(originalPlan);
  });

  it("exit_plan_mode 无 UI 时用宿主 ApprovalManager fail-closed", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-plan-exit-headless-"));
    await writeFile(join(workDir, "PLAN.md"), "# 等待审批的计划", "utf8");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Submit the plan.",
        toolCalls: [{ id: "call_exit_plan_headless", name: "exit_plan_mode", arguments: "{}" }],
      },
      { role: "assistant", content: "Plan remains pending." },
    ]);
    const approvalManager = new ApprovalManager(60_000);
    const resolveApproval = vi.spyOn(approvalManager, "resolveApproval");

    const result = await runAgentFromCli(
      {
        prompt: "Submit PLAN.md",
        dir: workDir,
        session: "plan_exit_headless_session",
        provider: "openai",
        planMode: true,
      },
      { provider, approvalManager },
    );

    expect(result.finalMessage).toBe("Plan remains pending.");
    expect(resolveApproval).toHaveBeenCalledWith(
      expect.stringMatching(/^exit_plan_/u),
      false,
      "当前 Runtime Host 未提供审批交互，已安全拒绝。",
    );
    expect(approvalManager.pendingCount).toBe(0);
    expect(globalApprovalManager.pendingCount).toBe(0);
    expect(
      provider.calls[1]?.messages.some((message) =>
        message.content.includes("当前 Runtime Host 未提供审批交互"),
      ),
    ).toBe(true);
  });

  it("exit_plan_mode approval updates shared settings and allows same-turn writes", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-plan-exit-settings-"));
    await writeFile(join(workDir, "PLAN.md"), "# 计划\n批准后写文件", "utf8");
    getOrCreateSessionSettings({
      sessionId: "plan_exit_settings_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      mode: "plan",
      permissionMode: "yolo",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Submit the plan.",
        toolCalls: [{ id: "call_exit_plan", name: "exit_plan_mode", arguments: "{}" }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Now execute.",
        toolCalls: [
          {
            id: "call_write_after_exit",
            name: "write_file",
            arguments: JSON.stringify({ path: "after-plan.txt", content: "implemented" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Done after plan.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    const approvalManager = new ApprovalManager(60_000);

    const runPromise = runAgentFromCli(
      {
        prompt: "Submit plan then write after-plan.txt",
        dir: workDir,
        session: "plan_exit_settings_session",
        provider: "openai",
      },
      {
        provider,
        approvalManager,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    expect(notice.toolName).toBe("exit_plan_mode");
    expect(approvalManager.pendingCount).toBe(1);
    expect(globalApprovalManager.pendingCount).toBe(0);
    approvalManager.resolveApproval(notice.taskId, true, "approve plan");

    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Done after plan." });
    expect(await readFile(join(workDir, "after-plan.txt"), "utf8")).toBe("implemented");
    expect(getStoredSessionSettings("plan_exit_settings_session")).toMatchObject({
      mode: "yolo",
      permissionMode: "yolo",
    });

    const secondProvider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Second turn.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    await runAgentFromCli(
      {
        prompt: "Second turn",
        dir: workDir,
        session: "plan_exit_settings_session",
        provider: "openai",
      },
      {
        provider: secondProvider,
      },
    );

    expect(secondProvider.calls[0]?.messages[0]?.content).not.toContain("Plan Mode: ON");
  });

  it("exit_plan_mode approval clears plan permission mode in shared settings", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-plan-exit-permission-"));
    await writeFile(join(workDir, "PLAN.md"), "# 计划\n只退出权限模式", "utf8");
    getOrCreateSessionSettings({
      sessionId: "plan_exit_permission_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      mode: "default",
      permissionMode: "plan",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Submit the plan.",
        toolCalls: [{ id: "call_exit_plan_permission", name: "exit_plan_mode", arguments: "{}" }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Exited permission plan.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    const runPromise = runAgentFromCli(
      {
        prompt: "Submit PLAN.md",
        dir: workDir,
        session: "plan_exit_permission_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    globalApprovalManager.resolveApproval(notice.taskId, true, "approve plan");

    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Exited permission plan." });
    expect(getStoredSessionSettings("plan_exit_permission_session")).toMatchObject({
      mode: "default",
      permissionMode: "default",
    });
  });

  it("edit_file requests approval before editing", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-approval-edit-"));
    await writeFile(join(workDir, "approval-edit.txt"), "old value\n", "utf8");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will edit a file.",
        toolCalls: [
          {
            id: "call_edit_approval",
            name: "edit_file",
            arguments: JSON.stringify({
              path: "approval-edit.txt",
              old_text: "old value",
              new_text: "new value",
            }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Edit rejected.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    await useDefaultInteractionMode("approval_edit_session", workDir);

    const runPromise = runAgentFromCli(
      {
        prompt: "Edit approval-edit.txt",
        dir: workDir,
        session: "approval_edit_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    expect(notice).toMatchObject({
      taskId: expect.stringMatching(/^approval_[0-9a-f-]+$/),
      toolName: "edit_file",
    });
    expect(notice.preview?.target).toBe("approval-edit.txt");
    expect(notice.diff).toContain("- old value");
    expect(notice.diff).toContain("+ new value");
    expect(await readFile(join(workDir, "approval-edit.txt"), "utf8")).toBe("old value\n");

    globalApprovalManager.resolveApproval(notice.taskId, false, "test rejection");
    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Edit rejected." });
    expect(await readFile(join(workDir, "approval-edit.txt"), "utf8")).toBe("old value\n");
  });

  it("read_file does not request approval", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-approval-read-"));
    await writeFile(join(workDir, "notes.txt"), "hello\n", "utf8");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will read a file.",
        toolCalls: [
          {
            id: "call_read_no_approval",
            name: "read_file",
            arguments: JSON.stringify({ path: "notes.txt" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Read done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn();

    const result = await runAgentFromCli(
      {
        prompt: "Read notes.txt",
        dir: workDir,
        session: "approval_read_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier,
      },
    );

    expect(result.finalMessage).toBe("Read done.");
    expect(approvalNotifier).not.toHaveBeenCalled();
    expect(globalApprovalManager.pendingCount).toBe(0);
  });

  it("uses shared /mode plan settings as real planMode for the next run", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-settings-plan-"));
    getOrCreateSessionSettings({
      sessionId: "settings_plan_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      mode: "plan",
      permissionMode: "yolo",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will try a write.",
        toolCalls: [
          {
            id: "call_plan_write",
            name: "write_file",
            arguments: JSON.stringify({ path: "not-plan.txt", content: "blocked" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Plan mode blocked it.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn();

    const result = await runAgentFromCli(
      {
        prompt: "Write not-plan.txt",
        dir: workDir,
        session: "settings_plan_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier,
      },
    );

    expect(result.finalMessage).toBe("Plan mode blocked it.");
    expect(approvalNotifier).not.toHaveBeenCalled();
    await expect(readFile(join(workDir, "not-plan.txt"), "utf8")).rejects.toThrow();
  });

  it("uses shared /permissions yolo settings to bypass normal write approval", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-settings-yolo-"));
    getOrCreateSessionSettings({
      sessionId: "settings_yolo_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "yolo",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write.",
        toolCalls: [
          {
            id: "call_yolo_write",
            name: "write_file",
            arguments: JSON.stringify({ path: "yolo.txt", content: "allowed" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Yolo write done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn();

    const result = await runAgentFromCli(
      {
        prompt: "Write yolo.txt",
        dir: workDir,
        session: "settings_yolo_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier,
      },
    );

    expect(result.finalMessage).toBe("Yolo write done.");
    expect(approvalNotifier).not.toHaveBeenCalled();
    expect(await readFile(join(workDir, "yolo.txt"), "utf8")).toBe("allowed");
  });

  it("uses shared /permissions ask settings to request normal write approval", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-settings-ask-"));
    getOrCreateSessionSettings({
      sessionId: "settings_ask_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "ask",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write.",
        toolCalls: [
          {
            id: "call_ask_write",
            name: "write_file",
            arguments: JSON.stringify({ path: "ask.txt", content: "needs approval" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Ask write rejected.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();

    const runPromise = runAgentFromCli(
      {
        prompt: "Write ask.txt",
        dir: workDir,
        session: "settings_ask_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    expect(notice.toolName).toBe("write_file");
    globalApprovalManager.resolveApproval(notice.taskId, false, "test rejection");

    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Ask write rejected." });
    await expect(readFile(join(workDir, "ask.txt"), "utf8")).rejects.toThrow();
  });

  it("uses shared /permissions auto settings to allow ordinary safe writes", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-settings-auto-"));
    getOrCreateSessionSettings({
      sessionId: "settings_auto_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "auto",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write.",
        toolCalls: [
          {
            id: "call_auto_write",
            name: "write_file",
            arguments: JSON.stringify({ path: "auto.txt", content: "safe" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Auto write done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approvalNotifier = vi.fn();

    const result = await runAgentFromCli(
      {
        prompt: "Write auto.txt",
        dir: workDir,
        session: "settings_auto_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier,
      },
    );

    expect(result.finalMessage).toBe("Auto write done.");
    expect(approvalNotifier).not.toHaveBeenCalled();
    expect(await readFile(join(workDir, "auto.txt"), "utf8")).toBe("safe");
  });

  it("uses shared /permissions default settings to request normal write approval", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-settings-default-"));
    getOrCreateSessionSettings({
      sessionId: "settings_default_session",
      cwd: workDir,
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "default",
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write.",
        toolCalls: [
          {
            id: "call_default_write",
            name: "write_file",
            arguments: JSON.stringify({ path: "default.txt", content: "needs approval" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Default write rejected.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();

    const runPromise = runAgentFromCli(
      {
        prompt: "Write default.txt",
        dir: workDir,
        session: "settings_default_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    expect(notice.toolName).toBe("write_file");
    globalApprovalManager.resolveApproval(notice.taskId, false, "test rejection");

    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Default write rejected." });
    await expect(readFile(join(workDir, "default.txt"), "utf8")).rejects.toThrow();
  });

  it("approve for session makes two identical dangerous calls ask only once", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-approval-session-"));
    const args = JSON.stringify({ path: "remembered.txt", content: "remembered" });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "First write.",
        toolCalls: [{ id: "call_write_session_1", name: "write_file", arguments: args }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Second write.",
        toolCalls: [{ id: "call_write_session_2", name: "write_file", arguments: args }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Both writes done.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const notices: ApprovalNotice[] = [];
    await useDefaultInteractionMode("approval_session_once", workDir);

    const result = await runAgentFromCli(
      {
        prompt: "Write remembered.txt twice",
        dir: workDir,
        session: "approval_session_once",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: (notice) => {
          notices.push(notice);
          globalApprovalManager.resolveApprovalForSession(notice.taskId, "approve for session");
        },
      },
    );

    expect(result.finalMessage).toBe("Both writes done.");
    expect(notices).toHaveLength(1);
    expect(await readFile(join(workDir, "remembered.txt"), "utf8")).toBe("remembered");
  });

  it("bash redirect writes request approval before executing", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-approval-bash-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will write through bash.",
        toolCalls: [
          {
            id: "call_bash_redirect_approval",
            name: "bash",
            arguments: JSON.stringify({ command: "echo hi > a.txt" }),
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: "Bash rejected.",
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const approval = makeApprovalCapture();
    await useDefaultInteractionMode("approval_bash_session", workDir);

    const runPromise = runAgentFromCli(
      {
        prompt: "Use bash to write a.txt",
        dir: workDir,
        session: "approval_bash_session",
        provider: "openai",
      },
      {
        provider,
        approvalNotifier: approval.notifier,
      },
    );

    const notice = await waitForApprovalBeforeCompletion(approval.nextNotice, runPromise);
    expect(notice).toMatchObject({
      taskId: expect.stringMatching(/^approval_[0-9a-f-]+$/),
      toolName: "bash",
    });
    expect(notice.preview?.target).toBe("a.txt");
    expect(notice.preview?.summary).toContain("写入");
    expect(notice.diff).toContain("+ echo hi");
    await expect(readFile(join(workDir, "a.txt"), "utf8")).rejects.toThrow();

    globalApprovalManager.resolveApproval(notice.taskId, false, "test rejection");
    await expect(runPromise).resolves.toMatchObject({ finalMessage: "Bash rejected." });
    await expect(readFile(join(workDir, "a.txt"), "utf8")).rejects.toThrow();
  });

  it("enables per-request trace from PICO_TRACE", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-trace-env-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Trace env works.",
        usage: { promptTokens: 2, completionTokens: 1 },
      },
    ]);

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        session: "trace_env_session",
        provider: "openai",
      },
      {
        env: {
          PICO_TRACE: "1",
        },
        provider,
      },
    );

    expect(result.finalMessage).toBe("Trace env works.");
    const tracesDirectory = resolvePicoPaths(workDir).workspace.traces;
    expect(result.tracePath).toContain(tracesDirectory);
    expect(await readdir(tracesDirectory)).toHaveLength(1);
  });

  it("从环境与参数解析 Provider 配置并允许命令行覆盖模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const created: unknown[] = [];

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "claude",
        model: "claude-override",
      },
      {
        env: {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "claude-env",
        },
        providerFactory: (kind, config) => {
          created.push({ kind, config });
          return new ScriptedProvider([
            {
              role: "assistant",
              content: "Anthropic route works.",
              usage: { promptTokens: 7, completionTokens: 3 },
            },
          ]);
        },
      },
    );

    expect(created).toEqual([
      {
        kind: "claude",
        config: {
          baseURL: "https://llm.example/v1",
          apiKey: "test-key",
          model: "claude-override",
        },
      },
    ]);
    expect(result.finalMessage).toBe("Anthropic route works.");
  });

  it("glm-5.2 不可用时自动切到 kimi-k2.5", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const created: string[] = [];

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "openai",
        model: "glm-5.2",
      },
      {
        env: {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "glm-5.2",
        },
        providerFactory: (_kind, config) => {
          created.push(config.model);
          if (config.model === "glm-5.2") {
            return {
              generate: async () => {
                throw new Error("model glm-5.2 is unavailable");
              },
            };
          }
          return new ScriptedProvider([
            {
              role: "assistant",
              content: "Kimi fallback works.",
              usage: { promptTokens: 5, completionTokens: 2 },
            },
          ]);
        },
      },
    );

    expect(created).toEqual(["glm-5.2", "kimi-k2.5"]);
    expect(result.finalMessage).toBe("Kimi fallback works.");
    expect(result.usage).toMatchObject({
      promptTokens: 5,
      completionTokens: 2,
    });
    // fallback 成功后按 kimi-k2.5 费率计费:((5 * 0.6) + (2 * 2.5)) / 1M USD * 7.2
    expect(result.usage.costCNY).toBeCloseTo(0.0000576, 10);
  });

  it("glm-5.2 流式不可用时自动切到 kimi-k2.5 并继续转发 stream delta", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-stream-fallback-"));
    const deltas: string[] = [];
    const created: string[] = [];

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "openai",
        model: "glm-5.2",
      },
      {
        env: {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "glm-5.2",
        },
        reporter: reporter((delta) => deltas.push(delta)),
        providerFactory: (_kind, config) => {
          created.push(config.model);
          if (config.model === "glm-5.2") {
            return {
              generate: async () => {
                throw new Error("model glm-5.2 is unavailable");
              },
              generateStream: async () => {
                throw new Error("model glm-5.2 is unavailable");
              },
            };
          }
          return {
            generate: async () => ({
              role: "assistant",
              content: "fallback non-stream",
              usage: { promptTokens: 5, completionTokens: 2 },
            }),
            generateStream: async (_messages, _tools, onDelta) => {
              onDelta("stream ");
              onDelta("fallback");
              return {
                role: "assistant",
                content: "stream fallback",
                usage: { promptTokens: 5, completionTokens: 2 },
              };
            },
          };
        },
      },
    );

    expect(created).toEqual(["glm-5.2", "kimi-k2.5"]);
    expect(deltas).toEqual(["stream ", "fallback"]);
    expect(result.finalMessage).toBe("stream fallback");
  });

  it("注入 provider 时不要求网络配置", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-injected-provider-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Injected provider works.",
        usage: { promptTokens: 2, completionTokens: 1 },
      },
    ]);

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "openai",
      },
      {
        env: {},
        provider,
      },
    );

    expect(result.finalMessage).toBe("Injected provider works.");
    expect(provider.calls).toHaveLength(1);
  });

  it("未指定 session 时默认每次 CLI 启动使用新 session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const provider = () =>
      new ScriptedProvider([
        {
          role: "assistant",
          content: "Done.",
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ]);

    const first = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "openai",
      },
      {
        provider: provider(),
      },
    );
    const second = await runAgentFromCli(
      {
        prompt: "Say done again",
        dir: workDir,
        provider: "openai",
      },
      {
        provider: provider(),
      },
    );

    expect(first.sessionId).toMatch(/^cli-/);
    expect(second.sessionId).toMatch(/^cli-/);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("同一 session 并发 run 时 append 与 engine.run 保持串行", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-concurrent-"));
    const provider = new BlockingProvider();

    const first = runAgentFromCli(
      {
        prompt: "first prompt",
        dir: workDir,
        session: "same-session",
        provider: "openai",
      },
      {
        provider,
      },
    );
    await provider.firstCallStarted;

    const second = runAgentFromCli(
      {
        prompt: "second prompt",
        dir: workDir,
        session: "same-session",
        provider: "openai",
      },
      {
        provider,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.some((message) => message.content === "second prompt")).toBe(
      false,
    );

    provider.release();
    await Promise.all([first, second]);

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.messages.some((message) => message.content === "first prompt")).toBe(
      true,
    );
    expect(provider.calls[1]?.messages.some((message) => message.content === "second prompt")).toBe(
      true,
    );
  });
});
