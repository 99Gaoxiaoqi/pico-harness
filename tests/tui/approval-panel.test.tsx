import React from "react";
import { Box, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { createPermissionState } from "../../src/approval/permission-state.js";
import {
  ApprovalPanel,
  approvalDialogId,
  approvalPanelContentWidth,
  formatApprovalPanel,
  formatPermissionPanel,
  isApprovalDialogId,
  measureApprovalPanelRows,
  nextApprovalPanelState,
  resolveApprovalPanelKey,
} from "../../src/tui/approval-panel.js";
import type { ApprovalNotice } from "../../src/approval/manager.js";

describe("ApprovalPanel", () => {
  it("为每个待审批任务生成独立 dialog id", () => {
    expect(approvalDialogId("task-1")).toBe("approval:pending:task-1");
    expect(approvalDialogId("task-2")).not.toBe(approvalDialogId("task-1"));
    expect(isApprovalDialogId(approvalDialogId("task-1"))).toBe(true);
    expect(isApprovalDialogId("local-ui:model-selector")).toBe(false);
  });

  it("展示 Claude 风格问题、命令和选择入口，不暴露内部任务 ID", () => {
    const output = formatApprovalPanel({
      taskId: "task-1",
      toolName: "bash",
      args: JSON.stringify({ command: "rm -rf dist" }),
      message: "需要审批",
    });

    expect(output).toContain("Do you want to execute this command?");
    expect(output).toContain("rm -rf dist");
    expect(output).toContain("1. Yes");
    expect(output).toContain("2. No");
    expect(output).toContain("↑/↓ or J/K");
    expect(output).not.toContain("task-1");
  });

  it("审批面板按键映射到审批动作", () => {
    expect(resolveApprovalPanelKey("", { return: true })).toBe("approve");
    expect(resolveApprovalPanelKey("y", {})).toBe("approve");
    expect(resolveApprovalPanelKey("a", {})).toBe("approve-session");
    expect(resolveApprovalPanelKey("n", {})).toBe("reject");
    expect(resolveApprovalPanelKey("", { escape: true })).toBe("reject");
    expect(resolveApprovalPanelKey("e", {})).toBe("toggle-diff");
    expect(resolveApprovalPanelKey("j", {})).toBe("move-down");
    expect(resolveApprovalPanelKey("k", {})).toBe("move-up");
    expect(resolveApprovalPanelKey("", { return: true }, undefined, 2)).toBe("reject");
    expect(resolveApprovalPanelKey("y", { ctrl: true })).toBeNull();
    expect(resolveApprovalPanelKey("", { return: true, ctrl: true })).toBeNull();
    expect(resolveApprovalPanelKey("x", {})).toBeNull();
  });

  it("审批面板使用用户自定义 Confirmation 快捷键", () => {
    const keybindings = {
      Confirmation: {
        y: null,
        p: "confirmation:accept" as const,
        r: "confirmation:cancel" as const,
      },
    };

    expect(resolveApprovalPanelKey("y", {}, keybindings)).toBe("approve");
    expect(resolveApprovalPanelKey("p", {}, keybindings)).toBe("approve");
    expect(resolveApprovalPanelKey("r", {}, keybindings)).toBe("reject");
  });

  it("diff 在审批面板里默认展示截断后的内容", () => {
    const longDiff = [
      "--- old",
      "+++ new",
      ...Array.from({ length: 40 }, (_, index) => `+line ${index + 1}`),
    ].join("\n");
    const output = formatApprovalPanel({
      taskId: "task-3",
      toolName: "write_file",
      args: JSON.stringify({ path: "AIHOT.md" }),
      message: "将写入日报文件",
      diff: longDiff,
    });

    expect(output).toContain("Do you want to write to AIHOT.md?");
    expect(output).toContain("Diff preview:");
    expect(output).toContain("+line 1");
    expect(output).not.toContain("+line 40");
  });

  it("通过纯函数切换长 diff 展开状态,展开后仍截断预览", () => {
    const longDiff = [
      "--- old",
      "+++ new",
      ...Array.from({ length: 40 }, (_, index) => `+line ${index + 1}`),
    ].join("\n");

    const expanded = nextApprovalPanelState(
      { diffExpanded: false, selectedIndex: 0 },
      "toggle-diff",
    );
    const collapsed = nextApprovalPanelState(expanded, "toggle-diff");

    expect(expanded.diffExpanded).toBe(true);
    expect(collapsed.diffExpanded).toBe(false);

    const output = formatApprovalPanel(
      {
        taskId: "task-3",
        toolName: "write_file",
        args: JSON.stringify({ path: "AIHOT.md" }),
        message: "将写入日报文件",
        diff: longDiff,
      },
      { diffExpanded: expanded.diffExpanded },
    );

    expect(output).toContain("+line 1");
    expect(output).toContain("+line 20");
    expect(output).not.toContain("+line 40");
    expect(output).toContain("已隐藏");
  });

  it("展示文件路径作为审批目标", () => {
    const output = formatApprovalPanel({
      taskId: "task-2",
      toolName: "write_file",
      args: JSON.stringify({ path: "src/index.ts", content: "hello" }),
      message: "需要审批",
    });

    expect(output).toContain("Do you want to write to index.ts?");
    expect(output).toContain("src/index.ts");
  });

  it("renders permission mode, grouped rules, and recent denials", () => {
    const output = formatPermissionPanel(
      createPermissionState({
        mode: "ask",
        rules: {
          allow: [{ tool: "read_file", pattern: "*" }],
          ask: [{ tool: "write_file", pattern: ".env", reason: "sensitive file" }],
          deny: [{ tool: "bash", pattern: "rm -rf /", reason: "hardline" }],
        },
        recentDenials: [
          {
            tool: "bash",
            target: "rm -rf /",
            reason: "hardline",
            deniedAt: "2026-07-09T01:00:00.000Z",
          },
        ],
      }),
    );

    expect(output).toContain("[Permissions]");
    expect(output).toContain("Mode: ask");
    expect(output).toContain("Allow");
    expect(output).toContain("read_file *");
    expect(output).toContain("Ask");
    expect(output).toContain("write_file .env - sensitive file");
    expect(output).toContain("Deny");
    expect(output).toContain("bash rm -rf / - hardline");
    expect(output).toContain("Recent denials");
    expect(output).toContain("2026-07-09T01:00:00.000Z bash rm -rf / - hardline");
  });

  it("renders concise empty permission state", () => {
    const output = formatPermissionPanel(createPermissionState({ mode: "default" }));

    expect(output).toContain("Mode: default");
    expect(output).toContain("No permission rules configured.");
    expect(output).toContain("No recent denials.");
  });

  it.each([
    [20, false],
    [20, true],
    [27, false],
    [27, true],
  ])("matches rendered approval rows at %i columns when expanded=%s", (columns, diffExpanded) => {
    const notice: ApprovalNotice = {
      taskId: "approval-narrow",
      toolName: "write_file",
      args: JSON.stringify({ path: "docs/deeply/nested/PLAN.md" }),
      message: "Review this narrow terminal write before continuing",
      diff: Array.from({ length: 6 }, (_, index) => `+line-${index}`).join("\n"),
    };
    const contentWidth = approvalPanelContentWidth(columns);
    const measured = measureApprovalPanelRows(notice, { diffExpanded, wrapWidth: contentWidth });
    const rendered = renderToString(
      <Box paddingX={1}>
        <ApprovalPanel {...notice} diffExpanded={diffExpanded} />
      </Box>,
      { columns },
    );

    expect(contentWidth).toBe(columns - 4);
    expect(measured).toBe(rendered.split("\n").length);
  });
});
