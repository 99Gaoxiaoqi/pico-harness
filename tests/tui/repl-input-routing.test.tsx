import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import {
  handleTuiInputSubmission,
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
});
