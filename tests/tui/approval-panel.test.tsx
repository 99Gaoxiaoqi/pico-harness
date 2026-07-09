import { describe, expect, it } from "vitest";
import { createPermissionState } from "../../src/approval/permission-state.js";
import { formatApprovalPanel, formatPermissionPanel } from "../../src/tui/approval-panel.js";

describe("ApprovalPanel", () => {
  it("展示工具名、命令和四个审批入口", () => {
    const output = formatApprovalPanel({
      taskId: "task-1",
      toolName: "bash",
      args: JSON.stringify({ command: "rm -rf dist" }),
      message: "需要审批",
    });

    expect(output).toContain("bash");
    expect(output).toContain("rm -rf dist");
    expect(output).toContain("allow once");
    expect(output).toContain("allow session");
    expect(output).toContain("deny");
    expect(output).toContain("edit");
    expect(output).toContain("approve task-1");
    expect(output).toContain("reject task-1");
    expect(output).toContain("modify task-1");
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
