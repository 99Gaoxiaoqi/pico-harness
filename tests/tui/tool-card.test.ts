// ToolCard 轻量测试:验证 agent/subagent 工具走 Claude Code 风格进度行分支。

import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { isAgentToolName, ToolCard } from "../../src/tui/tool-card.js";

describe("ToolCard agent tool detection", () => {
  it("识别 Pico 的子代理/委派工具", () => {
    expect(isAgentToolName("spawn_subagent")).toBe(true);
    expect(isAgentToolName("delegate_task")).toBe(true);
    expect(isAgentToolName("delegate_status")).toBe(true);
    expect(isAgentToolName("[Subagent] read_file")).toBe(true);
  });

  it("普通工具仍走标准工具卡片", () => {
    expect(isAgentToolName("read_file")).toBe(false);
    expect(isAgentToolName("bash")).toBe(false);
  });

  it("默认只渲染一行工具摘要,不展开参数和结果详情", () => {
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "read_file",
        args: JSON.stringify({ path: "src/index.ts", limit: 20 }),
        status: "done",
        summary: "120 字节 · export const answer = 42;",
        isLast: true,
      }),
    );

    expect(output).toContain("⎿ read_file");
    expect(output).toContain("Done");
    expect(output).toContain("120 字节");
    expect(output).toContain("[e 展开]");
    expect(output).not.toContain("参数");
    expect(output).not.toContain("结果");
    expect(output.split("\n")).toHaveLength(1);
  });

  it("最后一条展开时显示参数和结果摘要,错误结果保留原始摘要", () => {
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: "npm test" }),
        status: "error",
        summary: "执行失败: missing script test",
        isLast: true,
        initialExpanded: true,
      }),
    );

    expect(output).toContain("Failed");
    expect(output).toContain("参数");
    expect(output).toContain("command:npm test");
    expect(output).toContain("结果");
    expect(output).toContain("执行失败: missing script test");
  });
});
