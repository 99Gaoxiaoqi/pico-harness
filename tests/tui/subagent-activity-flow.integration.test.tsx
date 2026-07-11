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
import { TuiReporter, type TuiEntry } from "../../src/tui/tui-reporter.js";

describe("subagent activity flow", () => {
  it("将两个并行委派的实时动作和结果投影为独立卡片", async () => {
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter((next) => {
      entries = next;
    });
    const releases = new Map<string, () => void>();
    const runner: AgentRunner = {
      async runSub(taskPrompt, _registry, childReporter): Promise<SubagentResult> {
        childReporter?.onToolCall("read_file", JSON.stringify({ path: `src/${taskPrompt}.ts` }));
        await new Promise<void>((resolve) => releases.set(taskPrompt, resolve));
        childReporter?.onToolResult("read_file", "ok", false);
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
