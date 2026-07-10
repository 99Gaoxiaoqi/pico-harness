import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import type { LocalCommandResult } from "../../src/input/types.js";
import { handleTuiInputSubmission, type TuiInputProcessResult } from "../../src/tui/repl.js";
import {
  createRewindCommandDialogState,
  RewindCommandDialogView,
  resolveRewindCommandDialogKey,
} from "../../src/tui/rewind-command-dialog.js";
import { createRewindSelectorState } from "../../src/tui/rewind-selector.js";
import type { FileHistoryDiffStat } from "../../src/safety/file-history.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

describe("RewindCommandDialog", () => {
  it("初始选择态展示快照列表且不派发 rewind", () => {
    const state = createRewindCommandDialogState();

    const output = renderToString(
      <RewindCommandDialogView
        sessionId="session-1"
        snapshots={[snapshotSummary("turn-1")]}
        state={state}
      />,
    );

    expect(output).toContain("Choose a message to preview");
    expect(output).toContain("turn-1");
    expect(output).not.toContain("Preview changes before confirming rewind");
  });

  it("Enter 只进入 preview 态，不执行 rewind 命令", async () => {
    const onRewind = vi.fn(async () => undefined);
    const getDiffStat = vi.fn(async () => diffStat("turn-1"));

    const next = await resolveRewindCommandDialogKey(
      createRewindCommandDialogState(),
      [snapshotSummary("turn-1")],
      { input: "", key: { return: true } },
      { getDiffStat, onRewind },
    );

    expect(next.selector).toMatchObject({
      phase: "confirm",
      messageId: "turn-1",
      selectedAction: "both",
    });
    expect(getDiffStat).toHaveBeenCalledWith("turn-1");
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("快照超过可见上限时 Enter 预览屏幕高亮的最新项", async () => {
    const snapshots = Array.from({ length: 9 }, (_, index) => snapshotSummary(`turn-${index + 1}`));
    const onRewind = vi.fn(async () => undefined);
    const getDiffStat = vi.fn(async (messageId: string) => diffStat(messageId));

    const next = await resolveRewindCommandDialogKey(
      createRewindCommandDialogState(createRewindSelectorState(snapshots)),
      snapshots,
      { input: "", key: { return: true } },
      { getDiffStat, onRewind },
    );

    expect(next.selector).toMatchObject({
      phase: "confirm",
      messageId: "turn-9",
      selectedAction: "both",
    });
    expect(getDiffStat).toHaveBeenCalledWith("turn-9");
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("Esc cancel 关闭 dialog 且不派发命令", async () => {
    const onClose = vi.fn();
    const onRewind = vi.fn(async () => undefined);
    const preview = await resolveRewindCommandDialogKey(
      createRewindCommandDialogState(),
      [snapshotSummary("turn-1")],
      { input: "", key: { return: true } },
      { getDiffStat: async () => diffStat("turn-1"), onRewind },
    );

    const next = await resolveRewindCommandDialogKey(
      preview,
      [snapshotSummary("turn-1")],
      { input: "\u001b", key: { escape: true } },
      { getDiffStat: async () => diffStat("turn-1"), onClose, onRewind },
    );

    expect(next.status).toBe("closed");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRewind).not.toHaveBeenCalled();
  });

  it("confirm 后直接执行统一的 TUI rewind runtime", async () => {
    const onClose = vi.fn();
    const onRewind = vi.fn(async () => undefined);
    const preview = await resolveRewindCommandDialogKey(
      createRewindCommandDialogState(),
      [snapshotSummary("turn-1")],
      { input: "", key: { return: true } },
      { getDiffStat: async () => diffStat("turn-1"), onRewind },
    );
    const codeOnly = await resolveRewindCommandDialogKey(
      await resolveRewindCommandDialogKey(
        preview,
        [snapshotSummary("turn-1")],
        { input: "", key: { downArrow: true } },
        { getDiffStat: async () => diffStat("turn-1"), onRewind },
      ),
      [snapshotSummary("turn-1")],
      { input: "", key: { downArrow: true } },
      { getDiffStat: async () => diffStat("turn-1"), onRewind },
    );

    const next = await resolveRewindCommandDialogKey(
      codeOnly,
      [snapshotSummary("turn-1")],
      { input: "", key: { return: true } },
      { getDiffStat: async () => diffStat("turn-1"), onClose, onRewind },
    );

    expect(next.status).toBe("closed");
    expect(onRewind).toHaveBeenCalledWith(expect.objectContaining({ messageId: "turn-1" }), "code");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("/rewind 无参数返回 UI action 时通知 TUI 打开 dialog", async () => {
    const result: LocalCommandResult = {
      type: "local",
      action: "message",
      message: "Rewind\nChoose a message to preview",
      ui: { kind: "open-selector", selector: "rewind" },
    };
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/rewind",
        command: "rewind",
        args: "",
        argv: [],
        result,
      }),
    );
    const openLocalUiDialog = vi.fn();

    await handleTuiInputSubmission("/rewind", {
      reporter: new TuiReporter(() => undefined),
      registry: createBuiltinCommandRegistry(),
      workDir: process.cwd(),
      runAgent: async () => undefined,
      exit: vi.fn(),
      processInput,
      openLocalUiDialog,
    });

    expect(openLocalUiDialog).toHaveBeenCalledWith(result);
  });
});

function snapshotSummary(messageId: string) {
  return {
    messageId,
    timestamp: "2026-07-09T01:02:03.000Z",
    trackedFileCount: 1,
    backedUpFileCount: 1,
    deletedFileCount: 0,
    messageIndex: 2,
  };
}

function diffStat(messageId: string): FileHistoryDiffStat {
  return {
    messageId,
    changedFileCount: 1,
    addedLines: 2,
    removedLines: 1,
    files: [
      {
        filePath: "/tmp/project/src/a.ts",
        status: "modified",
        addedLines: 2,
        removedLines: 1,
      },
    ],
  };
}
