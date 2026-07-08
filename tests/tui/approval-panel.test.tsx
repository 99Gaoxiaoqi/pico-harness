import { describe, expect, it } from "vitest";
import { formatApprovalPanel } from "../../src/tui/approval-panel.js";

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
    expect(output).toContain("允许一次");
    expect(output).toContain("本 session");
    expect(output).toContain("拒绝");
    expect(output).toContain("修改");
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
});
