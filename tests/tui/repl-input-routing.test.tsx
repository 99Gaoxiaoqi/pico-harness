import React from "react";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { ApprovalManager, globalApprovalManager } from "../../src/approval/manager.js";
import { buildApprovalMiddleware } from "../../src/cli/run-agent.js";
import { RunningInputQueue } from "../../src/tui/running-input-queue.js";
import type { CliSessionBrowserSummary } from "../../src/tui/session-browser-adapter.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import {
  dispatchModelSelectorSelection,
  formatTuiRunError,
  handleTuiInterrupt,
  handleTuiInputSubmission,
  resolveLocalTuiCommandUiEffect,
  runTuiAgentPrompt,
  type TuiInputProcessResult,
  handleTuiRunningInputSubmission,
} from "../../src/tui/repl.js";

describe("TUI input routing", () => {
  function harness() {
    const snapshots: unknown[][] = [];
    const reporter = new TuiReporter((entries) => snapshots.push(entries));
    const runAgent = vi.fn(async () => undefined);
    const exit = vi.fn();
    const registry = createBuiltinCommandRegistry();
    const workDir = process.cwd();
    return { reporter, snapshots, runAgent, exit, registry, workDir };
  }

  it("AbortError 不生成普通执行失败内容", () => {
    expect(formatTuiRunError(new DOMException("interrupted", "AbortError"))).toBeUndefined();
    expect(formatTuiRunError(new Error("boom"))).toBe("⚠️ 执行出错: boom");
  });

  it("/model local UI action opens the model selector dialog", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const openDialog = vi.fn();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/model",
        command: "model",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "model",
          ui: { kind: "open-selector", selector: "model" },
          message: "Select a model.",
        },
      }),
    );

    await handleTuiInputSubmission("/model", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      openDialog,
      currentModelId: "glm-5.2",
    });

    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "local-ui:model-selector",
        layer: "modal",
        priority: 40,
      }),
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("model selector selection dispatches the existing /model command path", () => {
    const onSubmit = vi.fn();

    dispatchModelSelectorSelection("kimi-k2.5", onSubmit);

    expect(onSubmit).toHaveBeenCalledWith("/model kimi-k2.5");
  });

  it("/model with an explicit argument does not open the selector", () => {
    expect(
      resolveLocalTuiCommandUiEffect(
        {
          type: "local",
          action: "model",
          message: "Model change requested: kimi-k2.5",
          data: { model: "kimi-k2.5" },
        },
        { currentModelId: "glm-5.2" },
      ),
    ).toEqual({ kind: "none" });
  });

  it("本地 display 命令只追加系统消息,不调用模型", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();

    await handleTuiInputSubmission("/help", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: expect.stringContaining("/clear"),
      },
    ]);
  });

  it("/help lists /image when using the full Pico command registry", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-help-image",
    });
    const { reporter, snapshots, runAgent, exit, workDir } = harness();

    await handleTuiInputSubmission("/help", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: expect.stringContaining("/image - Attach a local image to this prompt"),
      },
    ]);
  });

  it("/help opens the real HelpPanel dialog with command descriptor metadata", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-help-panel",
    });
    const { reporter, runAgent, exit, workDir } = harness();
    const openDialog = vi.fn();

    await handleTuiInputSubmission("/help", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      openDialog,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledOnce();
    const request = openDialog.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      id: "local-ui:help",
      layer: "overlay",
    });
    const output = renderToString(request.content);
    expect(output).toContain("Slash commands");
    expect(output).toContain("builtin / help");
    expect(output).toContain("/help [command]");
    expect(output).toContain("builtin / permissions");
    expect(output).toContain("/permissions [ask|default|auto|");
  });

  it("/mcp can run locally while an agent response is running", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-running-mcp",
    });
    const { reporter, snapshots, runAgent, exit, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/mcp",
        command: "mcp",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "mcp",
          message: "MCP status\nNo MCP config loaded.",
        },
      }),
    );

    await handleTuiRunningInputSubmission("/mcp", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      guard: {
        getSnapshot: () => "running",
        tryStart: () => null,
        end: () => true,
      },
      queue: new RunningInputQueue(),
    });

    expect(processInput).toHaveBeenCalledWith("/mcp");
    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: "MCP status\nNo MCP config loaded.",
      },
    ]);
  });

  it("/clear 清空当前 TUI entries", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    reporter.pushUserMessage("old");

    await handleTuiInputSubmission("/clear", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("/exit 退出 TUI 且不调用模型", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();

    await handleTuiInputSubmission("/exit", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("prompt command 发送展开后的 prompt 给 runAgentFromCli", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "prompt-command",
        raw: "/review",
        command: "review",
        args: "",
        argv: [],
        result: {
          type: "prompt",
          prompt: "Review the current changes.",
        },
      }),
    );

    await handleTuiInputSubmission("/review", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
    });

    expect(runAgent).toHaveBeenCalledWith("Review the current changes.");
    expect(snapshots.at(0)).toEqual([{ kind: "user", content: "/review" }]);
  });

  it("runTuiAgentPrompt routes approval notices into TUI dialog and approval tool status", async () => {
    const { reporter, snapshots } = harness();
    const openDialog = vi.fn();
    const runAgent = vi.fn(async (_options, deps) => {
      reporter.onToolCall("write_file", JSON.stringify({ path: "AIHOT.md", content: "# daily" }));
      deps.approvalNotifier?.({
        taskId: "call_1",
        toolName: "write_file",
        args: JSON.stringify({ path: "AIHOT.md", content: "# daily" }),
        message: "approval",
      });
      return {
        sessionId: "tui-session",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
        workDir: process.cwd(),
        finalMessage: "",
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        messages: [],
      };
    });

    await runTuiAgentPrompt(
      {
        prompt: "write",
        dir: process.cwd(),
        session: "tui-session",
      },
      {
        reporter,
        runAgent,
        openDialog,
      },
    );

    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval:pending", layer: "modal" }),
    );
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({ kind: "tool", name: "write_file", status: "approval" }),
    ]);
  });

  it("approve-session records approval under the current TUI session id", async () => {
    const { reporter } = harness();
    const openDialog = vi.fn();
    const args = JSON.stringify({ path: "session-key.txt", content: "remember me" });
    const runAgent = vi.fn(async (_options, deps) => {
      const approval = globalApprovalManager.waitForApproval(
        "approval_session_key",
        "write_file",
        args,
        deps.approvalNotifier!,
      );
      await approval;
      return {
        sessionId: "tui-session-key",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session-key" },
        workDir: process.cwd(),
        finalMessage: "approved",
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        messages: [],
      };
    });

    const promptPromise = runTuiAgentPrompt(
      {
        prompt: "write",
        dir: process.cwd(),
        session: "tui-session-key",
        sessionSelection: { mode: "new", sessionId: "tui-session-key" },
      },
      {
        reporter,
        runAgent,
        openDialog,
      },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalled());
    const request = openDialog.mock.calls[0]?.[0];
    const props = request.content.props as { onAction: (action: "approve-session") => boolean };

    props.onAction("approve-session");
    await promptPromise;

    const notifier = vi.fn();
    const middleware = buildApprovalMiddleware(
      notifier,
      process.cwd(),
      undefined,
      new ApprovalManager(1),
      {
        sessionId: "tui-session-key",
        mode: "default",
        permissionMode: "default",
      },
    );
    const result = await middleware({
      id: "call_remembered",
      name: "write_file",
      arguments: args,
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("allowlist");
    expect(notifier).not.toHaveBeenCalled();
  });

  it("runTuiAgentPrompt 为每轮创建 controller、传递 signal 并在结束后清理", async () => {
    const { reporter } = harness();
    const abortControllerRef: { current: AbortController | null } = { current: null };
    let signalDuringRun: AbortSignal | undefined;
    let controllerDuringRun: AbortController | null = null;
    const runAgent = vi.fn(async (_options, deps) => {
      signalDuringRun = deps.signal;
      controllerDuringRun = abortControllerRef.current;
      return {
        sessionId: "tui-session",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
        workDir: process.cwd(),
        finalMessage: "done",
        usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
        messages: [],
      };
    });

    await runTuiAgentPrompt(
      { prompt: "run", dir: process.cwd(), session: "tui-session" },
      { reporter, runAgent, abortControllerRef },
    );

    expect(controllerDuringRun).toBeInstanceOf(AbortController);
    expect(signalDuringRun).toBe(controllerDuringRun?.signal);
    expect(abortControllerRef.current).toBeNull();
  });

  it("TUI interrupt 调用当前 controller.abort 并清理排队输入", async () => {
    const { reporter, snapshots } = harness();
    const replModule =
      (await import("../../src/tui/repl.js")) as typeof import("../../src/tui/repl.js") & {
        handleTuiInterrupt?: (
          controller: AbortController | null,
          queue: RunningInputQueue,
          reporter: TuiReporter,
        ) => void;
      };
    expect(replModule.handleTuiInterrupt).toBeTypeOf("function");
    if (!replModule.handleTuiInterrupt) return;

    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    const queue = new RunningInputQueue();
    queue.enqueue("queued prompt");

    replModule.handleTuiInterrupt(controller, queue, reporter);

    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(queue.size).toBe(0);
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: "Interrupted current run and dropped 1 queued input(s).",
      },
    ]);
  });

  it("TUI interrupt 会关闭当前审批 dialog", async () => {
    const { reporter } = harness();
    const abortControllerRef: { current: AbortController | null } = { current: null };
    const openDialog = vi.fn();
    const closeDialog = vi.fn();
    const queue = new RunningInputQueue();
    const runAgent = vi.fn(async (_options, deps) => {
      deps.approvalNotifier?.({
        taskId: "abort-dialog",
        toolName: "write_file",
        args: '{"path":"danger.txt","content":"x"}',
        message: "approval",
      });
      const signal = deps.signal;
      if (!signal) throw new Error("missing signal");
      await new Promise<never>((_resolve, reject) => {
        const rejectWithAbort = () => reject(signal.reason);
        if (signal.aborted) {
          rejectWithAbort();
          return;
        }
        signal.addEventListener("abort", rejectWithAbort, { once: true });
      });
      throw new Error("unreachable");
    });
    const run = runTuiAgentPrompt(
      { prompt: "write", dir: process.cwd(), session: "tui-session" },
      { reporter, runAgent, openDialog, closeDialog, abortControllerRef },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledOnce());

    handleTuiInterrupt(abortControllerRef.current, queue, reporter);

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(closeDialog).toHaveBeenCalledWith("approval:pending");
    expect(abortControllerRef.current).toBeNull();
  });

  it("approval command is handled locally and resolves a pending approval", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    globalApprovalManager.clear();
    const approval = globalApprovalManager.waitForApproval(
      "call_local",
      "write_file",
      JSON.stringify({ path: "AIHOT.md", content: "# daily" }),
      () => undefined,
    );

    await handleTuiInputSubmission("approve call_local", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    await expect(approval).resolves.toMatchObject({ allowed: true });
    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([{ kind: "system", content: "Approval approve: call_local" }]);
  });

  it("mention-expanded prompt 继续走 runAgentFromCli", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "prompt",
        raw: "review this",
        prompt: "review this",
      }),
    );

    await handleTuiInputSubmission("review this", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
    });

    expect(processInput).toHaveBeenCalledWith("review this");
    expect(runAgent).toHaveBeenCalledWith("review this");
  });

  it("shows the trace path after a TUI request when tracing is enabled", async () => {
    const { reporter, snapshots } = harness();
    const runAgent = vi.fn(async () => ({
      sessionId: "tui-session",
      sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
      workDir: process.cwd(),
      finalMessage: "done",
      usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
      messages: [],
      tracePath: "/tmp/project/.claw/traces/trace_tui-session_1.json",
    }));

    await runTuiAgentPrompt(
      {
        prompt: "trace this",
        dir: process.cwd(),
        session: "tui-session",
      },
      {
        reporter,
        runAgent,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "trace this" }),
      expect.objectContaining({ reporter }),
    );
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: "Trace saved: /tmp/project/.claw/traces/trace_tui-session_1.json",
      },
    ]);
  });

  it("@image:path 随本条 prompt 发送 ImagePart", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-tui-img-"));
    try {
      await writeFile(join(workDir, "pic.jpg"), "JPG");
      const { reporter, snapshots, runAgent, exit, registry } = harness();

      await handleTuiInputSubmission("看一下 @image:pic.jpg", {
        reporter,
        registry,
        workDir,
        runAgent,
        exit,
      });

      expect(runAgent).toHaveBeenCalledWith("看一下", {
        images: [
          expect.objectContaining({
            type: "image_base64",
            mimeType: "image/jpeg",
          }),
        ],
      });
      expect(snapshots.at(-1)).toEqual([
        { kind: "user", content: "看一下 @image:pic.jpg" },
        { kind: "system", content: "已附加图片: pic.jpg" },
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("@image:path 路径错误时显示本地提示且不调用模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-tui-img-missing-"));
    try {
      const { reporter, snapshots, runAgent, exit, registry } = harness();

      await handleTuiInputSubmission("看一下 @image:missing.png", {
        reporter,
        registry,
        workDir,
        runAgent,
        exit,
      });

      expect(runAgent).not.toHaveBeenCalled();
      expect(snapshots.at(-1)).toEqual([
        { kind: "user", content: "看一下 @image:missing.png" },
        { kind: "system", content: expect.stringContaining("missing.png") },
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("/sessions 打开 session selector dialog", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const openDialog = vi.fn();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/sessions",
        command: "sessions",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "message",
          message: "legacy session list",
          data: [
            sessionSummary({
              id: "cli-current",
              title: "继续调试 TUI",
              firstMessage: "继续调试 TUI",
            }),
          ],
          ui: { kind: "open-selector", selector: "session" },
        },
      }),
    );

    await handleTuiInputSubmission("/sessions", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      openDialog,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "local-ui:session-selector",
        layer: "modal",
        priority: 40,
      }),
    );
    const request = openDialog.mock.calls[0]?.[0];
    expect(renderToString(request.content)).toContain("Sessions [cwd]");
    expect(renderToString(request.content)).toContain("继续调试 TUI");
  });

  it("选择 session 后派发 /resume <session-id>", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const selected = sessionSummary({ id: "cli-current" });
    const dispatchInput = vi.fn(async () => undefined);
    const openDialog = vi.fn();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/sessions",
        command: "sessions",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "message",
          data: [selected],
          ui: { kind: "open-selector", selector: "session" },
        },
      }),
    );

    await handleTuiInputSubmission("/sessions", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      openDialog,
      dispatchInput,
    });

    const request = openDialog.mock.calls[0]?.[0];
    expect(React.isValidElement(request.content)).toBe(true);
    const props = request.content.props as {
      onSelect: (session: CliSessionBrowserSummary) => Promise<void> | void;
    };
    await props.onSelect(selected);

    expect(dispatchInput).toHaveBeenCalledWith("/resume cli-current");
    expect(runAgent).not.toHaveBeenCalled();
  });
});

function sessionSummary(
  overrides: Partial<CliSessionBrowserSummary> = {},
): CliSessionBrowserSummary {
  return {
    id: overrides.id ?? "cli-current",
    cwd: overrides.cwd ?? process.cwd(),
    createdAt: overrides.createdAt ?? new Date("2026-07-09T01:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-07-09T02:00:00.000Z"),
    messageCount: overrides.messageCount ?? 3,
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.firstMessage !== undefined ? { firstMessage: overrides.firstMessage } : {}),
    ...(overrides.lastMessage !== undefined ? { lastMessage: overrides.lastMessage } : {}),
  };
}
