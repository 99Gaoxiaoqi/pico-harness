import React from "react";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import type { CliSessionBrowserSummary } from "../../src/tui/session-browser-adapter.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import {
  dispatchModelSelectorSelection,
  handleTuiInputSubmission,
  resolveLocalTuiCommandUiEffect,
  type TuiInputProcessResult,
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

  it("/model local UI action opens the model selector dialog", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const openDialog = vi.fn();
    const processInput = vi.fn(async (): Promise<TuiInputProcessResult> => ({
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
    }));

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
        kind: "assistant",
        content: expect.stringContaining("/clear"),
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
    const processInput = vi.fn(async (): Promise<TuiInputProcessResult> => ({
      type: "prompt-command",
      raw: "/review",
      command: "review",
      args: "",
      argv: [],
      result: {
        type: "prompt",
        prompt: "Review the current changes.",
      },
    }));

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

  it("mention-expanded prompt 继续走 runAgentFromCli", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(async (): Promise<TuiInputProcessResult> => ({
      type: "prompt",
      raw: "review this",
      prompt: "review this",
    }));

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

  it("/sessions 打开 session selector dialog", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const openDialog = vi.fn();
    const processInput = vi.fn(async (): Promise<TuiInputProcessResult> => ({
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
    }));

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
    const processInput = vi.fn(async (): Promise<TuiInputProcessResult> => ({
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
    }));

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
