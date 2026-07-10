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

    expect(output).toContain("⎿ read");
    expect(output).toContain("Success");
    expect(output).toContain("src/index.ts");
    expect(output).toContain("[⌃E]");
    expect(output).not.toContain("参数");
    expect(output).not.toContain("结果");
    expect(output.split("\n")).toHaveLength(1);
  });

  it("最后一条展开时显示参数和结果摘要,错误结果保留可读摘要", () => {
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

    expect(output).toContain("Error");
    expect(output).toContain("参数");
    expect(output).toContain("command:npm test");
    expect(output).toContain("结果");
    expect(output).toContain("可复制错误: 执行失败: missing script test");
  });

  it("显示 queued / running / success / error / denied 五种协议状态文案", () => {
    expect(renderToolStatus("queued")).toContain("Queued");
    expect(renderToolStatus("running")).toContain("Running");
    expect(renderToolStatus("success")).toContain("Success");
    expect(renderToolStatus("error")).toContain("Error");
    expect(renderToolStatus("denied")).toContain("Denied");
  });

  it("edit/write/bash 工具在折叠态展示路径或命令摘要", () => {
    const editOutput = renderToString(
      React.createElement(ToolCard, {
        name: "edit_file",
        args: JSON.stringify({ path: "src/a.ts", oldText: "old", newText: "new" }),
        status: "success",
        summary: "✅ 成功修改文件: src/a.ts\n\n@@\n-old\n+new",
        isLast: true,
      }),
    );
    const bashOutput = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: "npm test -- --run" }),
        status: "success",
        summary: "100 字节 · pass",
        isLast: true,
      }),
    );

    expect(editOutput).toContain("src/a.ts");
    expect(editOutput).not.toContain("@@");
    expect(editOutput.trimEnd().split("\n")).toHaveLength(1);
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
        isLast: true,
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
    expect(folded).not.toContain("已截断");
    expect(expanded).toContain("+ line 4");
    expect(expanded).toContain("已截断");
  });

  it("长结果折叠态只占一行,目标已足够时不铺开输出", () => {
    const summary = Array.from({ length: 8 }, (_, i) => `line ${i}: ${"x".repeat(24)}`).join("\n");
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "read_file",
        args: JSON.stringify({ path: "src/large.ts" }),
        status: "success",
        summary,
        isLast: true,
      }),
    );

    expect(output.trimEnd().split("\n")).toHaveLength(1);
    expect(output).toContain("src/large.ts");
    expect(output).not.toContain("line 0");
    expect(output).not.toContain("line 2");
    expect(output).not.toContain("已截断");
  });

  it("error/denied 折叠态使用可读错误摘要", () => {
    const errorOutput = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: "npm test" }),
        status: "error",
        summary: "\n\nError: command failed\n    at stack line\nmore details",
        isLast: true,
      }),
    );
    const deniedOutput = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: "rm -rf /" }),
        status: "denied",
        summary: "permissionDecision: deny\ncommand rejected by policy",
        isLast: true,
      }),
    );

    expect(errorOutput).toContain("Error");
    expect(errorOutput).toContain("可复制错误: Error: command failed");
    expect(errorOutput).not.toContain("at stack line");
    expect(deniedOutput).toContain("Denied");
    expect(deniedOutput).toContain("可复制错误: permissionDecision: deny");
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
        isLast: true,
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
        isLast: true,
      }),
    );

    expect(output).toContain("3 agents");
    expect(output).toContain("1/3 queued");
    expect(output).toContain("分析");
    expect(output).not.toContain(longGoal);
    expect(output.split("\n")).toHaveLength(1);
  });
});

describe("ToolCard collapsed layout", () => {
  it("历史标准工具卡不显示展开入口,避免 e 一次展开全部", () => {
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: 'curl -s "https://aihot.virxact.com/api/news?limit=20"' }),
        status: "success",
        summary: "0 字节 · ",
        isLast: false,
      }),
    );

    expect(output).toContain("⎿ bash");
    expect(output).toContain("curl aihot.virxact");
    expect(output).toContain("limit=20");
    expect(output).not.toContain("[e 展开]");
    expect(output.trimEnd().split("\n")).toHaveLength(1);
  });

  it("末条标准工具卡显示展开入口", () => {
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: "npm test" }),
        status: "success",
        summary: "100 字节 · pass",
        isLast: true,
      }),
    );

    expect(output).toContain("[⌃E]");
  });

  it("超长单行摘要在折叠态不铺开完整内容", () => {
    const longJson = `{"items":"${"中文内容".repeat(80)}"}`;
    const output = renderToString(
      React.createElement(ToolCard, {
        name: "bash",
        args: JSON.stringify({ command: `curl -s https://aihot.virxact.com/api/news && echo ${longJson}` }),
        status: "success",
        summary: `${longJson} · ${"x".repeat(500)}`,
        isLast: true,
      }),
    );

    expect(output.trimEnd().split("\n")).toHaveLength(1);
    expect(output).not.toContain(longJson);
    expect(output).toContain("…");
  });

  it.each(["Success", "Error", "Running"] as const)(
    "26 列时保留工具名、%s 状态和 Ctrl+E 提示",
    (statusText) => {
      const output = renderToString(
        React.createElement(ToolCard, {
          name: "read_file",
          args: JSON.stringify({ path: `src/${"deeply-nested/".repeat(8)}file.ts` }),
          status: statusText.toLowerCase() as "success" | "error" | "running",
          summary: `${"long result ".repeat(20)}`,
          isLast: true,
          wrapWidth: 26,
        }),
        { columns: 26 },
      );

      expect(output).toContain("read");
      expect(output).toContain(statusText);
      expect(output).toContain("[⌃E]");
      expect(output.split("\n")).toHaveLength(1);
    },
  );

  it.each([
    {
      label: "long MCP",
      name: "mcp__production_database_server__execute_dangerous_migration",
      status: "error" as const,
      statusText: "Error",
      args: JSON.stringify({ target: "production", operation: "migrate" }),
      expectedName: "mcp",
    },
    {
      label: "delegate_task",
      name: "delegate_task",
      status: "running" as const,
      statusText: "Running",
      args: JSON.stringify({
        agent_name: "reviewer-with-a-very-long-name",
        goal: "Review a very long implementation plan before continuing",
      }),
      expectedName: "Agents",
    },
    {
      label: "exit_plan_mode",
      name: "exit_plan_mode",
      status: "success" as const,
      statusText: "Success",
      args: JSON.stringify({ plan: "A very long plan ready for approval" }),
      expectedName: "exit",
    },
  ])("26 列时 $label header 保留名称、状态和 Ctrl+E", (tool) => {
    const output = renderToString(
      React.createElement(ToolCard, {
        name: tool.name,
        args: tool.args,
        status: tool.status,
        summary: "A long result that may be truncated after the required header fields",
        isLast: true,
        wrapWidth: 26,
      }),
      { columns: 26 },
    );

    expect(output).toContain(tool.expectedName);
    expect(output).toContain(tool.statusText);
    expect(output).toContain("[⌃E]");
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
