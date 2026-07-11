import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { DelegationManager } from "../../src/tools/delegation-manager.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import {
  DelegateTaskTool,
  type AgentRunner,
  type SubagentResult,
} from "../../src/tools/subagent.js";
import { MessageList } from "../../src/tui/message-list.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import { TuiEventStore, TuiReporter, type TuiEntry } from "../../src/tui/tui-reporter.js";

describe("subagent activity flow", () => {
  it("将两个并行委派的实时动作和结果投影为独立卡片", async () => {
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter(
      (next) => {
        entries = next;
      },
      [],
      { eventStore: new TuiEventStore({ maxSegmentEvents: 3 }) },
    );
    const releases = new Map<string, () => void>();
    const runner: AgentRunner = {
      async runSub(taskPrompt, _registry, childReporter): Promise<SubagentResult> {
        childReporter?.onThinking();
        childReporter?.onMessage(`working:${taskPrompt}`);
        childReporter?.onToolCall(
          "read_file",
          JSON.stringify({ path: `src/${taskPrompt}.ts` }),
          `call:${taskPrompt}`,
        );
        await new Promise<void>((resolve) => releases.set(taskPrompt, resolve));
        childReporter?.onToolResult(
          "read_file",
          `contents:${taskPrompt}`,
          false,
          `call:${taskPrompt}`,
        );
        return { summary: `done:${taskPrompt}`, artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(
      runner,
      () => new ToolRegistry(),
      new DelegationManager({ maxConcurrentChildren: 2 }),
      { reporter },
    );

    const execution = tool.execute(
      JSON.stringify({ tasks: [{ goal: "auth" }, { goal: "cache" }] }),
    );
    await waitUntil(
      () =>
        entries.filter((entry) => entry.kind === "subagent-activity" && entry.status === "running")
          .length === 2,
    );

    const running = renderEntries(entries);
    expect(running).toContain("auth · running");
    expect(running).toContain("read_file：src/auth.ts");
    expect(running).toContain("cache · running");
    expect(running).toContain("read_file：src/cache.ts");
    expect(JSON.stringify(entries)).not.toContain("activityId");
    const runningProjection = reporter.getProjection();
    const auth = Object.values(runningProjection.subagents).find(
      (subagent) => subagent.activity.task === "auth",
    );
    const cache = Object.values(runningProjection.subagents).find(
      (subagent) => subagent.activity.task === "cache",
    );
    expect(auth?.timeline.map((item) => item.kind)).toEqual(["thinking", "message", "tool"]);
    expect(cache?.timeline.map((item) => item.kind)).toEqual(["thinking", "message", "tool"]);
    expect(auth?.timeline.find((item) => item.kind === "message")).toMatchObject({
      content: "working:auth",
    });
    expect(cache?.timeline.find((item) => item.kind === "message")).toMatchObject({
      content: "working:cache",
    });

    releases.get("auth")?.();
    releases.get("cache")?.();
    const result = JSON.parse(await execution) as {
      results: Array<{ status: string; summary?: string }>;
    };

    expect(result.results).toEqual([
      expect.objectContaining({ status: "completed", summary: "done:auth" }),
      expect.objectContaining({ status: "completed", summary: "done:cache" }),
    ]);
    const completed = renderEntries(entries);
    expect(completed).toContain("auth · completed");
    expect(completed).toContain("done:auth");
    expect(completed).toContain("cache · completed");
    expect(completed).toContain("done:cache");

    const completedProjection = reporter.getProjection();
    const completedAuth = Object.values(completedProjection.subagents).find(
      (subagent) => subagent.activity.task === "auth",
    );
    const authTool = completedAuth?.timeline.find((item) => item.kind === "tool");
    expect(authTool).toMatchObject({
      status: "success",
      result: "contents:auth",
    });
    expect(authTool?.id).toBe(auth?.timeline.find((item) => item.kind === "tool")?.id);
    expect(JSON.stringify(entries)).not.toContain("working:auth");

    const replayed = new TuiEventStore({ initialSnapshot: reporter.getReplaySnapshot() });
    expect(replayed.getProjection().subagents).toEqual(completedProjection.subagents);
  });

  it("全部是运行中工具时不驱逐待完成轨迹", () => {
    const reporter = new TuiReporter(() => undefined);
    reporter.onSubagentActivity({
      activityId: "many-running-tools",
      task: "并发工具边界",
      status: "running",
    });
    for (let index = 0; index <= 256; index++) {
      reporter.onSubagentTrace({
        activityId: "many-running-tools",
        traceId: `tool-${index}`,
        type: "tool.started",
        name: "read_file",
        args: JSON.stringify({ path: `src/${index}.ts` }),
      });
    }

    expect(() =>
      reporter.onSubagentTrace({
        activityId: "many-running-tools",
        traceId: "tool-0",
        type: "tool.completed",
        result: "done",
        isError: false,
      }),
    ).not.toThrow();
    expect(reporter.getProjection().subagents["many-running-tools"]?.timeline).toHaveLength(256);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("等待子代理活动状态超时");
}

function renderEntries(entries: TuiEntry[]): string {
  return renderToString(
    React.createElement(MessageList, {
      layout: buildTranscriptLayout(entries, { wrapWidth: 80 }),
    }),
  );
}
