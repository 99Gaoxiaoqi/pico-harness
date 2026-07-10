import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import {
  cancelRewindSelection,
  confirmRewindSelection,
  createRewindSelectorState,
  escapeRewindSelector,
  formatRewindConfirm,
  formatRewindSelector,
  formatRewindSelectorState,
  formatRewindUsage,
  latestSnapshotMessageId,
  moveRewindSelection,
  selectRewindConfirmAction,
  selectRewindPreview,
  selectRewindSnapshot,
} from "../../src/tui/rewind-selector.js";

describe("RewindSelector", () => {
  it("展示当前 session 的可回滚点和变更摘要", () => {
    const output = formatRewindSelector("session-1", [
      {
        messageId: "turn-1",
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 2,
        backedUpFileCount: 1,
        deletedFileCount: 1,
        messageIndex: 4,
        changeSummary: "1 个文件有备份, 1 个文件将在 rewind 时删除",
      },
    ]);

    expect(output).toContain("Rewind");
    expect(output).toContain("turn-1");
    expect(output).toContain("Choose a message to preview");
    expect(output).toContain("2 files changed");
  });

  it("空快照时给出可行动提示", () => {
    expect(formatRewindSelector("empty-session", [])).toBe("Rewind\nNothing to rewind to yet.");
  });

  it("长 messageId 在展示位截断且不展示可执行命令", () => {
    const messageId = `turn-${"a".repeat(60)}-${"z".repeat(20)}`;
    const output = formatRewindSelector("session-1", [
      {
        messageId,
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 1,
        backedUpFileCount: 1,
        deletedFileCount: 0,
      },
    ]);

    expect(output).toContain("turn-aaaaaaaaaaaaaaaa...");
    expect(output).not.toContain(`/rewind ${messageId} both`);
  });

  it("过长文件摘要会截断，避免撑开 TUI 文本路径", () => {
    const output = formatRewindSelector(
      "session-1",
      [
        {
          messageId: "turn-1",
          timestamp: "2026-07-09T01:02:03.000Z",
          trackedFileCount: 1,
          backedUpFileCount: 1,
          deletedFileCount: 0,
          changeSummary: "这是一个非常长的变更摘要，用来模拟真实模型生成的多文件说明",
        },
      ],
      { maxSummaryLength: 18 },
    );

    expect(output).toContain("1 file changed ...");
    expect(output).not.toContain("多文件说明");
  });

  it("/rewind 无参数时展示最近快照和 mode 使用说明", () => {
    const output = formatRewindUsage("session-1", [
      {
        messageId: "turn-1",
        timestamp: "2026-07-09T01:02:03.000Z",
        trackedFileCount: 1,
        backedUpFileCount: 1,
        deletedFileCount: 0,
      },
      {
        messageId: "turn-2",
        timestamp: "2026-07-09T01:03:03.000Z",
        trackedFileCount: 2,
        backedUpFileCount: 2,
        deletedFileCount: 0,
      },
    ]);

    expect(output).toContain("Enter to preview");
    expect(output).toContain("turn-2");
    expect(output).not.toContain("Enter to continue");
  });

  it("取最后一个快照作为 /undo 默认目标", () => {
    expect(
      latestSnapshotMessageId([
        {
          messageId: "turn-1",
          timestamp: "2026-07-09T01:00:00.000Z",
          trackedFileCount: 1,
          backedUpFileCount: 1,
          deletedFileCount: 0,
        },
        {
          messageId: "turn-2",
          timestamp: "2026-07-09T01:01:00.000Z",
          trackedFileCount: 3,
          backedUpFileCount: 3,
          deletedFileCount: 0,
        },
      ]),
    ).toBe("turn-2");
  });

  it("初始状态只列消息，不立即执行回滚", () => {
    const onConfirm = vi.fn();
    const state = createRewindSelectorState();
    const output = formatRewindSelectorState("session-1", [snapshotSummary("turn-1")], state);

    expect(state).toMatchObject({ phase: "select", selectedIndex: 0 });
    expect(output).toContain("Preview first; confirm happens on the next screen.");
    expect(output).toContain("turn-1");
    expect(output).not.toContain("Restore code and conversation");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("快照超过可见上限时默认高亮最新可见项，Enter 预览同一项", () => {
    const snapshots = Array.from({ length: 9 }, (_, index) => snapshotSummary(`turn-${index + 1}`));
    const state = createRewindSelectorState(snapshots);

    const output = formatRewindSelectorState("session-1", snapshots, state, { maxItems: 7 });
    const preview = selectRewindPreview(state, snapshots, emptyDiffStat("unused"));

    expect(output).not.toContain("turn-1");
    expect(output).toContain("> turn-9");
    expect(preview).toMatchObject({ phase: "confirm", messageId: "turn-9" });
  });

  it("旧初始索引落在隐藏区时，屏幕高亮项和 Enter 预览项保持一致", () => {
    const snapshots = Array.from({ length: 9 }, (_, index) => snapshotSummary(`turn-${index + 1}`));
    const legacyState = { phase: "select" as const, selectedIndex: 0 };

    const output = formatRewindSelectorState("session-1", snapshots, legacyState, {
      maxItems: 7,
    });
    const preview = selectRewindPreview(legacyState, snapshots, emptyDiffStat("unused"));

    expect(output).toContain("> turn-1");
    expect(output).not.toContain("turn-9");
    expect(preview).toMatchObject({ phase: "confirm", messageId: "turn-1" });
  });

  it("上下移动会在可见快照间循环选择，Enter 只进入 preview", () => {
    const snapshots = [
      snapshotSummary("turn-1"),
      snapshotSummary("turn-2"),
      snapshotSummary("turn-3"),
    ];

    const movedDown = moveRewindSelection(createRewindSelectorState(), snapshots, "down");
    expect(movedDown).toMatchObject({ phase: "select", selectedIndex: 1 });

    const movedUp = moveRewindSelection(movedDown, snapshots, "up");
    expect(movedUp).toMatchObject({ phase: "select", selectedIndex: 0 });

    const wrapped = moveRewindSelection(movedUp, snapshots, "up");
    expect(wrapped).toMatchObject({ phase: "select", selectedIndex: 2 });

    const preview = selectRewindPreview(wrapped, snapshots, emptyDiffStat("turn-3"));
    expect(preview).toMatchObject({
      phase: "confirm",
      messageId: "turn-3",
      selectedAction: "both",
    });
  });

  it("选择消息后进入确认态并展示 changed files 和 +/- 统计", () => {
    const selected = selectRewindSnapshot(createRewindSelectorState(), "turn-1", {
      messageId: "turn-1",
      changedFileCount: 2,
      addedLines: 3,
      removedLines: 1,
      files: [
        {
          filePath: "/tmp/project/src/a.ts",
          status: "modified",
          addedLines: 2,
          removedLines: 1,
        },
        {
          filePath: "/tmp/project/src/b.ts",
          status: "created",
          addedLines: 1,
          removedLines: 0,
        },
      ],
    });

    expect(selected.phase).toBe("confirm");
    const output = formatRewindSelectorState("session-1", [snapshotSummary("turn-1")], selected);
    expect(output).toContain("Preview changes before confirming rewind");
    expect(output).toContain("turn-1");
    expect(output).toContain("+3 -1");
    expect(output).toContain("src/a.ts");
    expect(output).toContain("Confirm: restore code and conversation");
    expect(output).toContain("Confirm: restore conversation only");
    expect(output).toContain("Confirm: restore code only");
  });

  it("cancel 不调用 rewind，confirm 才调用对应 callback", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const selected = selectRewindSnapshot(
      createRewindSelectorState(),
      "turn-1",
      emptyDiffStat("turn-1"),
    );

    const canceled = cancelRewindSelection(selected, { onCancel, onConfirm });
    expect(canceled.phase).toBe("select");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    const confirmed = confirmRewindSelection(selected, "conversation", { onCancel, onConfirm });
    expect(confirmed.phase).toBe("select");
    expect(onConfirm).toHaveBeenCalledWith("turn-1", "conversation");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("确认态上下移动选择 confirm/cancel，选择 cancel 不执行回滚", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const selected = selectRewindSnapshot(
      createRewindSelectorState(),
      "turn-1",
      emptyDiffStat("turn-1"),
    );

    const conversation = moveRewindSelection(selected, [snapshotSummary("turn-1")], "down");
    expect(conversation).toMatchObject({ phase: "confirm", selectedAction: "conversation" });

    const cancel = moveRewindSelection(conversation, [snapshotSummary("turn-1")], "up");
    expect(cancel).toMatchObject({ phase: "confirm", selectedAction: "both" });

    const wrappedCancel = moveRewindSelection(cancel, [snapshotSummary("turn-1")], "up");
    expect(wrappedCancel).toMatchObject({ phase: "confirm", selectedAction: "cancel" });

    const next = selectRewindConfirmAction(wrappedCancel, { onConfirm, onCancel });
    expect(next).toMatchObject({ phase: "select", selectedIndex: 0 });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("确认态选择 confirm 才执行对应 rewind mode", () => {
    const onConfirm = vi.fn();
    const selected = selectRewindSnapshot(
      createRewindSelectorState(),
      "turn-1",
      emptyDiffStat("turn-1"),
    );
    const codeOnly = moveRewindSelection(
      moveRewindSelection(selected, [snapshotSummary("turn-1")], "down"),
      [snapshotSummary("turn-1")],
      "down",
    );

    const next = selectRewindConfirmAction(codeOnly, { onConfirm });

    expect(next).toMatchObject({ phase: "select", selectedIndex: 0 });
    expect(onConfirm).toHaveBeenCalledWith("turn-1", "code");
  });

  it("Esc 在任意阶段取消并回到初始选择态", () => {
    const onCancel = vi.fn();

    expect(escapeRewindSelector(createRewindSelectorState(), { onCancel })).toMatchObject({
      phase: "select",
      selectedIndex: 0,
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const selected = selectRewindSnapshot(
      createRewindSelectorState(),
      "turn-1",
      emptyDiffStat("turn-1"),
    );
    expect(escapeRewindSelector(selected, { onCancel })).toMatchObject({
      phase: "select",
      selectedIndex: 0,
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("确认态可作为 Ink 组件渲染", () => {
    const output = renderToString(
      formatRewindConfirm("session-1", snapshotSummary("turn-1"), emptyDiffStat("turn-1")),
    );

    expect(output).toContain("Preview changes before confirming rewind");
    expect(output).toContain("turn-1");
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

function emptyDiffStat(messageId: string) {
  return {
    messageId,
    changedFileCount: 0,
    addedLines: 0,
    removedLines: 0,
    files: [],
  };
}
