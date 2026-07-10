import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globalApprovalManager, type ApprovalNotice } from "../src/approval/manager.js";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import type { Reporter } from "../src/engine/reporter.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import type { LLMProvider } from "../src/provider/interface.js";
import { resetSessionSettingsForTests } from "../src/input/session-settings.js";

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
  return Promise.race([
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
      setTimeout(() => reject(new Error("timed out waiting for approval")), 1000);
    }),
  ]);
}

describe("runAgentFromCli", () => {
  afterEach(() => {
    globalApprovalManager.clear();
    resetSessionSettingsForTests();
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
    expect(result.tracePath).toContain(join(".claw", "traces"));
    expect(await readdir(join(workDir, ".claw", "traces"))).toHaveLength(1);
    expect(provider.calls[0]?.toolNames).toEqual(
      expect.arrayContaining(["bash", "read_file", "write_file", "edit_file", "search_tools"]),
    );
    expect(provider.calls[0]?.toolNames).not.toContain("delegate_task");
    expect(provider.calls[0]?.toolNames).not.toContain("task_list");
    expect(provider.calls[0]?.messages[0]?.content).toContain("PLAN.md");
    expect(write).toHaveBeenCalledTimes(1);
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
      taskId: "call_write_approval",
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
    const lateApproval = globalApprovalManager.resolveApproval(
      notice.taskId,
      true,
      "late approve",
    );
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
    const pendingAfterAbort = globalApprovalManager.pendingCount;
    const lateModify = globalApprovalManager.resolveApprovalWithModify(
      notice.taskId,
      "late modify",
      "# 不应写入",
    );
    const lateApprove = globalApprovalManager.resolveApproval(notice.taskId, true, "late approve");
    const outcome = await outcomePromise;

    expect(outcome).toMatchObject({ name: "AbortError" });
    expect(pendingAfterAbort).toBe(0);
    expect(lateModify).toBe(false);
    expect(lateApprove).toBe(false);
    expect(provider.calls).toHaveLength(1);
    await expect(readFile(join(workDir, "PLAN.md"), "utf8")).resolves.toBe(originalPlan);
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
      taskId: "call_edit_approval",
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
      taskId: "call_bash_redirect_approval",
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
    expect(result.tracePath).toContain(join(".claw", "traces"));
    expect(await readdir(join(workDir, ".claw", "traces"))).toHaveLength(1);
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
