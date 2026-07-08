// ToolCard 轻量测试:验证 agent/subagent 工具走 Claude Code 风格进度行分支。

import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { formatErrorSummary, isAgentToolName, ToolCard } from "../../src/tui/tool-card.js";

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
        status: "success",
        summary: "120 字节 · export const answer = 42;",
        isLast: true,
      }),
    );

    expect(output).toContain("⎿ read_file");
    expect(output).toContain("Success");
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
        status: "failed",
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

  it("显示 running / success / failed / denied 四种状态文案", () => {
    expect(renderToolStatus("running")).toContain("Running");
    expect(renderToolStatus("done")).toContain("Success");
    expect(renderToolStatus("error")).toContain("Failed");
    expect(renderToolStatus("denied")).toContain("Denied");
  });

  it("edit/write/bash 工具在折叠态展示路径或命令摘要", () => {
    const editOutput = renderToString(
      React.createElement(ToolCard, {
        name: "edit_file",
        args: JSON.stringify({ path: "src/a.ts", oldText: "old", newText: "new" }),
        status: "success",
        summary: "✅ 成功修改文件: src/a.ts\n\n@@\n-old\n+new",
      }),
    );
    const bashOutput = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: "npm test -- --run" }),
        status: "success",
        summary: "100 字节 · pass",
      }),
    );

    expect(editOutput).toContain("src/a.ts");
    expect(editOutput).toContain("@@");
    expect(bashOutput).toContain("npm test -- --run");
  });

  it("长输出默认折叠,展开后保留截断提示", () => {
    const summary = Array.from({ length: 6 }, (_, i) => `+ line ${i}`).join("\n");
    const folded = renderToString(
      React.createElement(ToolCard, {
        name: "edit_file",
        args: JSON.stringify({ path: "src/a.ts" }),
        status: "success",
        summary,
      }),
    );
    const expanded = renderToString(
      React.createElement(ToolCard, {
        name: "edit_file",
        args: JSON.stringify({ path: "src/a.ts" }),
        status: "success",
        summary,
        initialExpanded: true,
      }),
    );

    expect(folded).not.toContain("+ line 4");
    expect(folded).toContain("已截断");
    expect(expanded).toContain("+ line 4");
    expect(expanded).toContain("已截断");
  });

  it("失败状态提供可复制的错误摘要", () => {
    const summary = formatErrorSummary("Error: command failed\n    at stack line\n详情".repeat(30));

    expect(summary).toContain("可复制错误:");
    expect(summary).toContain("Error: command failed");
    expect(summary.length).toBeLessThanOrEqual(180);
  });

  it("delegate_task 运行态显示 agent name 和任务摘要", () => {
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "delegate_task",
        args: JSON.stringify({
          agent_name: "reviewer",
          goal: "检查子代理状态展示是否接近 Claude Code",
        }),
        status: "running",
      }),
    );

    expect(output).toContain("reviewer");
    expect(output).toContain("Running");
    expect(output).toContain("检查子代理状态展示");
  });

  it("delegate_task 批量运行态显示 total 和折叠后的首个任务摘要", () => {
    const longGoal = "分析很长很长的任务描述".repeat(12);
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "delegate_task",
        args: JSON.stringify({
          tasks: [{ goal: longGoal }, { goal: "运行测试" }, { goal: "整理报告" }],
        }),
        status: "running",
      }),
    );

    expect(output).toContain("3 agents");
    expect(output).toContain("1/3 queued");
    expect(output).toContain("分析很长很长");
    expect(output).not.toContain(longGoal);
    expect(output.split("\n")).toHaveLength(1);
  });
});

function renderToolStatus(status: React.ComponentProps<typeof ToolCard>["status"]): string {
  return renderToString(
    React.createElement(ToolCard, {
      name: "read_file",
      args: "{}",
      status,
      summary: "ok",
    }),
  );
}
