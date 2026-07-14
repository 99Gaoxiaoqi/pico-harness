import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList, shouldRenderStatically } from "../../src/tui/message-list.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import { TuiReporter, type TuiEntry } from "../../src/tui/tui-reporter.js";

describe("subagent activity transcript projection", () => {
  it("用同一 activityId 原位更新卡片，并保留并行子代理", () => {
    let entries: TuiEntry[] = [];
    const reporter = new TuiReporter((next) => {
      entries = next;
    });

    reporter.onSubagentActivity({
      activityId: "activity-runtime-secret",
      task: "接入子代理事件",
      agentName: "runtime-worker",
      mode: "worker",
      status: "queued",
      currentAction: "等待可用 worker",
    });
    const firstEntryId = reporter.getProjection().entries[0]?.id;
    expect(renderEntries(entries)).toContain("queued");

    reporter.onSubagentActivity({
      activityId: "activity-tui-secret",
      task: "渲染活动卡片",
      agentName: "tui-explorer",
      mode: "explore",
      status: "running",
      currentAction: "检查 transcript 布局",
      requestedModelRoute: "volcengine/glm-5.2",
      resolvedModelRoute: "volcengine/glm-5.2",
      thinkingEffort: "high",
      modelSelectionSource: "ephemeral",
    });
    const runningOutput = renderEntries(entries);
    expect(runningOutput).toContain("渲染活动卡片 · running");
    expect(runningOutput).toContain("检查 transcript 布局");
    expect(runningOutput).toContain("model:volcengine/glm-5.2");
    expect(runningOutput).toContain("thinking:high");
    reporter.onSubagentActivity({
      activityId: "activity-runtime-secret",
      task: "接入子代理事件",
      agentName: "runtime-worker",
      mode: "worker",
      status: "completed",
      summary: "集成测试已通过",
    });

    expect(entries).toHaveLength(2);
    expect(reporter.getProjection().entries[0]?.id).toBe(firstEntryId);
    expect(entries[0]).toMatchObject({
      kind: "subagent-activity",
      status: "completed",
      summary: "集成测试已通过",
    });
    expect(entries[1]).toMatchObject({
      kind: "subagent-activity",
      status: "running",
      currentAction: "检查 transcript 布局",
    });

    reporter.onSubagentActivity({
      activityId: "activity-tui-secret",
      task: "渲染活动卡片",
      agentName: "tui-explorer",
      mode: "explore",
      status: "failed",
      summary: "渲染校验失败",
      requestedModelRoute: "volcengine/glm-5.2",
      resolvedModelRoute: "volcengine/glm-5.2",
      thinkingEffort: "high",
      modelSelectionSource: "ephemeral",
    });

    const output = renderEntries(entries);
    expect(output).toContain("接入子代理事件 · completed");
    expect(output).toContain("runtime-worker · worker");
    expect(output).toContain("集成测试已通过");
    expect(output).toContain("渲染活动卡片 · failed");
    expect(output).toContain("tui-explorer · explore");
    expect(output).toContain("渲染校验失败");
    expect(output).not.toContain("activity-runtime-secret");
    expect(output).not.toContain("activity-tui-secret");
    expect(JSON.stringify(entries)).not.toContain("activityId");
  });

  it("将进行中活动留在动态区，完成或失败后固化", () => {
    const base = {
      kind: "subagent-activity" as const,
      task: "检查状态",
    };

    expect(shouldRenderStatically({ ...base, status: "queued" }, false, false)).toBe(false);
    expect(shouldRenderStatically({ ...base, status: "running" }, false, false)).toBe(false);
    expect(shouldRenderStatically({ ...base, status: "completed" }, false, false)).toBe(true);
    expect(shouldRenderStatically({ ...base, status: "failed" }, false, false)).toBe(true);
  });
});

function renderEntries(entries: TuiEntry[]): string {
  return renderToString(
    React.createElement(MessageList, {
      layout: buildTranscriptLayout(entries, { wrapWidth: 80 }),
    }),
  );
}
