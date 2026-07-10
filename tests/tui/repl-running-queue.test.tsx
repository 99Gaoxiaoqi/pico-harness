import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { CommandRegistry } from "../../src/input/command-registry.js";
import type { LocalCommandResult } from "../../src/input/types.js";
import type { SlashCommand } from "../../src/input/types.js";
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
    const onQueueSizeChange = vi.fn();
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
      onQueueSizeChange,
    });
    await waitForGuardStatus(guard, "running");

    await handleTuiRunningInputSubmission("second", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
      onQueueSizeChange,
    });
    await handleTuiRunningInputSubmission("third", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
      onQueueSizeChange,
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
    expect(onQueueSizeChange).toHaveBeenCalledWith(1);
    expect(onQueueSizeChange).toHaveBeenCalledWith(2);
    expect(onQueueSizeChange).toHaveBeenLastCalledWith(0);
  });

  it("running 中会改状态的本地命令被拦截", async () => {
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

    expect(queue.size).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([
      { kind: "user", content: "old" },
      {
        kind: "system",
        content: "Cannot run /clear: Command is only available while idle.",
      },
    ]);
  });

  it("running 中本地 UI 命令不入队且不会打开弹层", async () => {
    const { reporter, guard, queue, registry: baseRegistry, workDir, exit, runAgent } = harness();
    const result: LocalCommandResult = {
      type: "local",
      action: "message",
      message: "Rewind",
      ui: { kind: "open-selector", selector: "rewind" },
    };
    const registry = new CommandRegistry([
      ...baseRegistry.list(),
      {
        name: "rewind",
        description: "Rewind",
        kind: "local",
        availability: "idle",
        execute: () => result,
      },
    ]);
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
      openLocalUiDialog,
    });

    expect(queue.size).toBe(0);
    expect(runAgent).not.toHaveBeenCalled();
    expect(openLocalUiDialog).not.toHaveBeenCalled();
  });

  it("running 中 help/status 这类只读命令仍可立即执行", async () => {
    const { reporter, guard, queue, registry, workDir, exit, runAgent } = harness();
    guard.tryStart();

    await handleTuiRunningInputSubmission("/help", {
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
    expect(exit).not.toHaveBeenCalled();
  });

  it("running 中 prompt command 入队后不会二次执行命令展开", async () => {
    const { reporter, guard, queue, workDir, exit, runAgent } = harness();
    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    runAgent.mockImplementationOnce(async () => firstDone);
    const execute = vi.fn<SlashCommand["execute"]>(() => ({
      type: "prompt",
      prompt: "expanded prompt",
    }));
    const registry = new CommandRegistry([
      ...createBuiltinCommandRegistry().list(),
      {
        name: "expand",
        description: "Expand once",
        usage: "/expand",
        kind: "prompt",
        availability: "running",
        execute,
      },
    ]);

    const first = handleTuiRunningInputSubmission("first", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });
    await waitForGuardStatus(guard, "running");

    await handleTuiRunningInputSubmission("/expand", {
      reporter,
      guard,
      queue,
      registry,
      workDir,
      exit,
      runAgent,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    finishFirst();
    await first;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(runAgent).toHaveBeenNthCalledWith(2, "expanded prompt");
  });
});

async function waitForGuardStatus(guard: QueryGuard, status: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (guard.getSnapshot() === status) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(guard.getSnapshot()).toBe(status);
}
