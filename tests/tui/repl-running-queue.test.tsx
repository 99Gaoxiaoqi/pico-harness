import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import type { LocalCommandResult } from "../../src/input/types.js";
import { QueryGuard } from "../../src/tui/query-guard.js";
import { handleTuiRunningInputSubmission } from "../../src/tui/repl.js";
import { RunningInputQueue } from "../../src/tui/running-input-queue.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

describe("TUI running input queue", () => {
  function harness() {
    const snapshots: unknown[][] = [];
    const reporter = new TuiReporter((entries) => snapshots.push(entries));
    const guard = new QueryGuard();
    const queue = new RunningInputQueue();
    const registry = createBuiltinCommandRegistry();
    const workDir = process.cwd();
    const exit = vi.fn();
    const runAgent = vi.fn<(prompt: string) => Promise<void>>(async () => undefined);

    return { reporter, snapshots, guard, queue, registry, workDir, exit, runAgent };
  }

  it("running 中两个普通输入排队,当前任务完成后按顺序调用 runAgent", async () => {
    const { reporter, guard, queue, registry, workDir, exit, runAgent } = harness();
    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    runAgent.mockImplementationOnce(async () => firstDone);

    const first = handleTuiRunningInputSubmission("first", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });
    await Promise.resolve();

    await handleTuiRunningInputSubmission("second", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });
    await handleTuiRunningInputSubmission("third", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenNthCalledWith(1, "first");
    expect(queue.size).toBe(2);

    finishFirst();
    await first;

    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(runAgent).toHaveBeenNthCalledWith(2, "second");
    expect(runAgent).toHaveBeenNthCalledWith(3, "third");
    expect(queue.size).toBe(0);
  });

  it("running 中 clear/exit 等本地命令不入队", async () => {
    const { reporter, snapshots, guard, queue, registry, workDir, exit, runAgent } = harness();
    reporter.pushUserMessage("old");
    guard.tryStart();

    await handleTuiRunningInputSubmission("/clear", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });
    await handleTuiRunningInputSubmission("/exit", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });

    expect(queue.size).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("running 中本地 UI 命令不入队且保留弹层回调", async () => {
    const { reporter, guard, queue, registry, workDir, exit, runAgent } = harness();
    const result: LocalCommandResult = {
      type: "local",
      action: "message",
      message: "Rewind",
      ui: { kind: "open-selector", selector: "rewind" },
    };
    const openLocalUiDialog = vi.fn();
    guard.tryStart();

    await handleTuiRunningInputSubmission("/rewind", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
      processInput: async () => ({
        type: "local-command",
        raw: "/rewind",
        command: "rewind",
        args: "",
        argv: [],
        result,
      }),
      openLocalUiDialog,
    });

    expect(queue.size).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(openLocalUiDialog).toHaveBeenCalledWith(result);
  });
});
