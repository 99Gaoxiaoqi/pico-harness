import React from "react";
import { PassThrough } from "node:stream";
import { render, type Instance } from "ink";
import { describe, expect, it, vi } from "vitest";
import { App, resolveAgentNavigationInput } from "../../src/tui/app.js";
import {
  createAgentNavigationState,
  createMainAgentItem,
  projectAgentNavigationItems,
  reduceAgentNavigation,
  type AgentNavigationItem,
} from "../../src/tui/agent-navigation.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

describe("agent navigation interaction", () => {
  it("单击直接打开详情，Esc 保留选择，Tab 从 picker 回到输入", async () => {
    const items: AgentNavigationItem[] = [
      createMainAgentItem(),
      {
        id: "agent-tests",
        kind: "subagent",
        status: "running",
        agentName: "tests-agent",
        task: "检查测试结构",
      },
    ];
    const app = (
      <App
        model="test-model"
        workDir="/workspace/demo"
        entries={[]}
        agents={items}
        running
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app);

    try {
      await harness.rerender(app);
      // 24 行终端中，子代理是 switcher 的最后一行。
      const opened = await harness.write("\u001b[<0;5;24M");
      expect(opened).toContain("← Main / tests-agent");
    } finally {
      await harness.cleanup();
    }

    let state = reduceAgentNavigation(
      createAgentNavigationState(),
      { type: "open-item", id: "agent-tests" },
      items,
    );
    state = reduceAgentNavigation(state, { type: "escape" }, items);
    expect(state).toMatchObject({ activeId: "main", selectedId: "agent-tests", focus: "picker" });

    const tabAction = resolveAgentNavigationInput(
      "\t",
      { tab: true },
      {
        state,
        inputState: { text: "", hasSuggestions: false, historyIndex: null },
        hasSubagents: true,
        blocked: false,
      },
    );
    expect(tabAction).toEqual({ type: "focus-input" });
    state = reduceAgentNavigation(state, tabAction!, items);
    expect(state).toMatchObject({ activeId: "main", selectedId: "agent-tests", focus: "input" });
  });

  it("从真实子代理轨迹投影工具目标、参数和截断状态", () => {
    const reporter = new TuiReporter(() => undefined);
    reporter.onSubagentActivity({
      activityId: "agent-search",
      task: "搜索关键测试",
      status: "running",
    });
    reporter.onSubagentTrace({
      activityId: "agent-search",
      traceId: "tool-search",
      type: "tool.started",
      name: "[Subagent] grep",
      args: JSON.stringify({ pattern: "describe\\(", path: "tests" }),
    });
    reporter.onSubagentTrace({
      activityId: "agent-search",
      traceId: "tool-search",
      type: "tool.completed",
      result: "many matching lines",
      isError: false,
      truncated: true,
    });

    const tool = projectAgentNavigationItems(reporter.getProjection())[1]?.timeline?.[0];
    expect(tool).toMatchObject({
      kind: "tool",
      name: "grep",
      status: "completed",
      args: JSON.stringify({ pattern: "describe\\(", path: "tests" }),
      target: "describe\\(",
      summary: "many matching lines",
      truncated: true,
    });
  });
});

function createInteractiveApp(node: React.ReactNode): {
  write: (input: string) => Promise<string>;
  rerender: (node: React.ReactNode) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
  });
  Object.assign(stdin, { setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 80, writable: true },
    rows: { value: 24, writable: true },
  });
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance: Instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    async write(input: string): Promise<string> {
      const offset = output.length;
      stdin.write(input);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async rerender(nextNode: React.ReactNode): Promise<string> {
      const offset = output.length;
      instance.rerender(nextNode);
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
