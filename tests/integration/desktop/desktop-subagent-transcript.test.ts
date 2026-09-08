import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import { mergeConversationItemGroups } from "../../../apps/desktop/src/renderer/conversation/items.js";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import { applyTimelineNotification } from "../../../apps/desktop/src/renderer/timeline.js";
import { DesktopReporter } from "../../../src/daemon/desktop-reporter.js";
import type { RuntimeNotification } from "../../../src/daemon/protocol.js";
import { publishDesktopReporterEvent } from "../../../src/daemon/production-host.js";
import type { WorkspaceRuntimeService } from "../../../src/daemon/workspace-runtime-service.js";
import { ScopedSubagentActivityReporter } from "../../../src/tools/subagent-activity-reporter.js";

Object.assign(globalThis, { React });

function presentation() {
  let timeline: ReturnType<typeof applyTimelineNotification> = [];
  let version = 0;
  const service = {
    publishDesktopNotification: (notification: RuntimeNotification) => {
      if (notification.topic === "run.timeline")
        timeline = applyTimelineNotification(timeline, notification);
    },
  } as unknown as WorkspaceRuntimeService;
  const reporter = new DesktopReporter({
    runId: "parent-run",
    sessionId: "parent-session",
    publish: (event) => publishDesktopReporterEvent(service, "/workspace", event, () => ++version),
  });
  return { reporter, timeline: () => timeline };
}

test("子代理真实 Reporter 轨迹保持单张活动卡，终态水合后显示完成且不重复", () => {
  const view = presentation();
  const scope = {
    activityId: "subagent-child",
    agentName: "只读验收",
    task: "读取随机 token",
    mode: "explore" as const,
    completionPolicy: "required" as const,
  };
  const child = new ScopedSubagentActivityReporter(view.reporter, scope);
  view.reporter.onSubagentActivity({ ...scope, status: "running" });
  const startedAt = view.timeline()[0]?.at;
  for (let index = 0; index < 12; index++) {
    child.onThinking();
    child.onToolCall("read_file", '{"path":"token.txt"}', `tool-${index}`);
    child.onMessage(`读取进展 ${index}`);
    assert.equal(
      view.timeline().length,
      1,
      "trace and activity updates must not create additional cards",
    );
  }
  assert.equal(view.timeline()[0]?.id, "subagent:subagent-child");
  assert.equal(
    view.timeline()[0]?.at,
    startedAt,
    "updates must preserve the card's original position",
  );
  view.reporter.onSubagentActivity({ ...scope, status: "completed", summary: "读取成功" });
  view.reporter.onSubagentActivitiesClaimed([scope.activityId]);
  assert.equal(view.timeline().length, 1);
  assert.equal(view.timeline()[0]?.state, "done");
  const durable = parseConversation(
    {
      items: [
        {
          id: "subagent:subagent-child",
          kind: "subagent",
          name: scope.agentName,
          title: scope.task,
          detail: "读取成功",
          state: "completed",
          data: { activityId: scope.activityId },
        },
      ],
    },
    "/workspace",
    "parent-session",
  ).items;
  const live = parseConversation(
    {
      items: view.timeline().map((item) => ({ ...item, kind: "subagent", name: scope.agentName })),
    },
    "/workspace",
    "parent-session",
  ).items;
  const merged = mergeConversationItemGroups(durable, live);
  assert.equal(merged.length, 1, "terminal hydration must replace the stable live identity");
  assert.equal(merged[0]?.kind === "subagent" && merged[0].state, "done");
  const html = renderToStaticMarkup(React.createElement(ConversationTranscript, { items: merged }));
  assert.match(html, /已完成/);
  assert.doesNotMatch(html, /进行中/);

  view.reporter.onSubagentActivity({ ...scope, activityId: "another-child", status: "running" });
  assert.equal(
    view.timeline().length,
    2,
    "different activities with identical task names must remain separate",
  );
});

test("排队及未成功子代理在实时和历史投影中不会误显示持续运行", () => {
  const view = presentation();
  const statuses = ["queued", "failed", "timed_out", "cancelled", "partial"] as const;
  for (const status of statuses) {
    view.reporter.onSubagentActivity({
      activityId: status,
      task: "受控子任务",
      agentName: "Reader",
      mode: "explore",
      completionPolicy: "required",
      status,
    });
  }
  assert.deepEqual(
    view.timeline().map((item) => item.state),
    ["waiting", "failed", "failed", "failed", "failed"],
  );
  const durable = parseConversation(
    {
      items: statuses.map((status) => ({
        id: `subagent:${status}`,
        kind: "subagent",
        name: "Reader",
        title: "受控子任务",
        state: status,
      })),
    },
    "/workspace",
    "parent-session",
  ).items;
  assert.deepEqual(
    durable.map((item) => (item.kind === "subagent" ? item.state : undefined)),
    view.timeline().map((item) => item.state),
  );
});
