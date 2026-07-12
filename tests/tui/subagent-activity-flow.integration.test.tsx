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
import {
  createAgentNavigationState,
  projectAgentNavigationItems,
  reconcileAgentNavigationState,
  reduceAgentNavigation,
  visibleAgentNavigationItems,
} from "../../src/tui/agent-navigation.js";

describe("subagent activity flow", () => {
  it("required 委派在 provider 未回传最终正文时也撤销临时流", () => {
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter((next) => {
      entries = next;
    });
    const args = JSON.stringify({
      tasks: [{ goal: "检查流式边界" }],
      completion_policy: "required",
      background: true,
    });

    reporter.onTurnStart(1);
    reporter.onTextDelta("委派前临时正文");
    reporter.onToolCall("delegate_task", args, "delegate-stream-only");

    expect(entries.some((entry) => entry.kind === "assistant")).toBe(false);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "delegate_task", status: "running" }),
      ]),
    );
  });

  it("required 委派轮撤销已流式投影的主正文，保留委派卡与子代理详情", async () => {
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter((next) => {
      entries = next;
    });
    const runner: AgentRunner = {
      async runSub(taskPrompt, _registry, childReporter): Promise<SubagentResult> {
        childReporter?.onMessage(`trace-only:${taskPrompt}`);
        return { summary: `done:${taskPrompt}`, artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(runner, () => new ToolRegistry(), new DelegationManager(), {
      reporter,
    });
    const args = JSON.stringify({
      tasks: [{ agent_name: "tui-worker", goal: "检查委派投影" }],
      completion_policy: "required",
    });

    reporter.onTurnStart(1);
    reporter.onTextDelta("我先自己详细分析项目，然后再启动子代理。");
    reporter.onMessage("我先自己详细分析项目，然后再启动子代理。");
    reporter.onToolCall("delegate_task", args, "delegate-call");
    const result = await tool.execute(args);
    reporter.onToolResult("delegate_task", result, false, "delegate-call");

    expect(entries.some((entry) => entry.kind === "assistant")).toBe(false);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", name: "delegate_task", status: "success" }),
        expect.objectContaining({
          kind: "subagent-activity",
          agentName: "tui-worker",
          status: "completed",
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain("trace-only:");
    const subagent = Object.values(reporter.getProjection().subagents)[0];
    expect(subagent?.lifecycle).toBe("terminal_unconsumed");
    expect(subagent?.timeline).toEqual([
      expect.objectContaining({ kind: "message", content: "trace-only:检查委派投影" }),
    ]);
    let navigation = reduceAgentNavigation(
      createAgentNavigationState(),
      { type: "open-item", id: subagent!.activityId },
      projectAgentNavigationItems(reporter.getProjection()),
    );

    reporter.onTurnStart(2);
    reporter.onTextDelta("委派已完成，这是最终答复。");
    reporter.onMessage("委派已完成，这是最终答复。");
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", content: "委派已完成，这是最终答复。" }),
      ]),
    );
    const archivedProjection = reporter.getProjection();
    expect(archivedProjection.subagents[subagent!.activityId]).toMatchObject({
      lifecycle: "archived",
      timeline: [expect.objectContaining({ content: "trace-only:检查委派投影" })],
    });
    const archivedItems = projectAgentNavigationItems(archivedProjection);
    const visibleWhileViewing = visibleAgentNavigationItems(archivedItems, navigation.activeId);
    expect(visibleWhileViewing.map((item) => item.id)).toContain(subagent!.activityId);
    navigation = reconcileAgentNavigationState(navigation, visibleWhileViewing);
    expect(navigation.activeId).toBe(subagent!.activityId);
    navigation = reduceAgentNavigation(navigation, { type: "escape" }, visibleWhileViewing);
    expect(navigation.activeId).toBe("main");
    expect(visibleAgentNavigationItems(archivedItems, navigation.activeId)).toHaveLength(1);

    const replayed = new TuiEventStore({ initialSnapshot: reporter.getReplaySnapshot() });
    expect(replayed.getProjection().entries).toEqual(reporter.getProjection().entries);
    expect(replayed.getProjection().subagents).toEqual(archivedProjection.subagents);
  });

  it("optional 终态只在 completion 被空闲 wake claim 后归档", () => {
    const reporter = new TuiReporter(() => undefined);
    reporter.onSubagentActivity({
      activityId: "optional-pending-wake",
      task: "异步检查",
      status: "running",
      completionPolicy: "optional",
    });
    reporter.onSubagentActivity({
      activityId: "optional-pending-wake",
      task: "异步检查",
      status: "completed",
      completionPolicy: "optional",
      summary: "等待主 Agent 消费",
    });

    reporter.onMessage("当前主循环的无关答复");
    expect(reporter.getProjection().subagents["optional-pending-wake"]?.lifecycle).toBe(
      "terminal_unconsumed",
    );

    reporter.markAsyncSubagentCompletionsDelivered();
    expect(reporter.getProjection().subagents["optional-pending-wake"]?.lifecycle).toBe(
      "terminal_claimed",
    );
    reporter.onMessage("已吸收异步检查结果");
    expect(reporter.getProjection().subagents["optional-pending-wake"]?.lifecycle).toBe("archived");
  });

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
    expect(auth?.activity.completionPolicy).toBe("required");
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

  it("dispatch rejected 时把已创建 queued activity 全部收口", async () => {
    const reporter = new TuiReporter(() => undefined);
    const runner: AgentRunner = {
      async runSub() {
        return { summary: "must not run", artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(
      runner,
      () => new ToolRegistry(),
      new DelegationManager({ maxAsyncChildren: 0 }),
      { reporter },
    );

    const dispatch = JSON.parse(
      await tool.execute(
        JSON.stringify({
          tasks: [{ goal: "one" }, { goal: "two" }],
          completion_policy: "optional",
        }),
      ),
    ) as { status: string; error?: string };

    expect(dispatch.status).toBe("rejected");
    expect(dispatch.error).toContain("上限");
    const subagents = Object.values(reporter.getProjection().subagents);
    expect(subagents).toHaveLength(2);
    expect(subagents.map((subagent) => subagent.activity.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(subagents.every((subagent) => subagent.lifecycle === "terminal_unconsumed")).toBe(true);
  });

  it("外部 abort 保留已完成结果并取消运行中与 queued children", async () => {
    const reporter = new TuiReporter(() => undefined);
    const controller = new AbortController();
    let secondStarted = false;
    const runner: AgentRunner = {
      async runSub(taskPrompt, _registry, _reporter, options) {
        if (taskPrompt === "first") return { summary: "kept", artifacts: [] };
        secondStarted = true;
        await new Promise<void>((_resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { summary: "unreachable", artifacts: [] };
      },
    };
    const tool = new DelegateTaskTool(
      runner,
      () => new ToolRegistry(),
      new DelegationManager({ maxConcurrentChildren: 1 }),
      { reporter },
    );
    const execution = tool.execute(
      JSON.stringify({ tasks: [{ goal: "first" }, { goal: "second" }, { goal: "third" }] }),
      { signal: controller.signal },
    );
    await waitUntil(() => secondStarted);
    controller.abort(new DOMException("stop batch", "AbortError"));

    const result = JSON.parse(await execution) as {
      status: string;
      results: Array<{ status: string; summary?: string }>;
    };
    expect(result).toMatchObject({
      status: "partial",
      results: [
        { status: "completed", summary: "kept" },
        { status: "cancelled" },
        { status: "cancelled" },
      ],
    });
    const statuses = Object.values(reporter.getProjection().subagents).map(
      (subagent) => subagent.activity.status,
    );
    expect(statuses).toEqual(["completed", "cancelled", "cancelled"]);
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
