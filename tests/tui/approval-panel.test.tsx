import { describe, expect, it } from "vitest";
import { createPermissionState } from "../../src/approval/permission-state.js";
import {
  formatApprovalPanel,
  formatPermissionPanel,
  resolveApprovalPanelKey,
} from "../../src/tui/approval-panel.js";

describe("ApprovalPanel", () => {
  it("展示工具名、命令和键盘审批入口", () => {
    const output = formatApprovalPanel({
      taskId: "task-1",
      toolName: "bash",
      args: JSON.stringify({ command: "rm -rf dist" }),
      message: "需要审批",
    });

    expect(output).toContain("bash");
    expect(output).toContain("rm -rf dist");
    expect(output).toContain("Enter/Y");
    expect(output).toContain("A 本会话允许");
    expect(output).toContain("N/Esc");
    expect(output).toContain("approve task-1");
    expect(output).toContain("reject task-1");
    expect(output).toContain("modify task-1");
  });

  it("审批面板按键映射到审批动作", () => {
    expect(resolveApprovalPanelKey("", { return: true })).toBe("approve");
    expect(resolveApprovalPanelKey("y", {})).toBe("approve");
    expect(resolveApprovalPanelKey("a", {})).toBe("approve-session");
    expect(resolveApprovalPanelKey("n", {})).toBe("reject");
    expect(resolveApprovalPanelKey("", { escape: true })).toBe("reject");
    expect(resolveApprovalPanelKey("x", {})).toBeNull();
  });

  it("diff 在审批面板里只展示统计摘要", () => {
    const output = formatApprovalPanel({
      taskId: "task-3",
      toolName: "write_file",
      args: JSON.stringify({ path: "AIHOT.md" }),
      message: "需要审批",
      diff: ["--- old", "+++ new", "+line 1", "+line 2", "-line 3"].join("\n"),
    });

    expect(output).toContain("Diff: +2 -1");
    expect(output).not.toContain("+line 1");
  });

  it("展示文件路径作为审批目标", () => {
    const output = formatApprovalPanel({
      taskId: "task-2",
      toolName: "write_file",
      args: JSON.stringify({ path: "src/index.ts", content: "hello" }),
      message: "需要审批",
    });

    expect(output).toContain("write_file");
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
});
