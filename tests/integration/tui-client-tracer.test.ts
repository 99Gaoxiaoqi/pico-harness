import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeNotification, type RuntimeNotification } from "@pico/protocol";
import { TranscriptEventStore } from "../../src/presentation/transcript-event-store.js";
import { DaemonEventReporter } from "../../src/tui/daemon-event-reporter.js";
import { transcriptEventsFromRuntimeItems } from "../../src/tui/transcript-item-hydration.js";
import {
  ClientSessionRuntime,
  type DaemonSessionClient,
} from "../../src/tui/client-session-runtime.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import type { ApprovalNotice } from "../../src/approval/manager.js";

/**
 * 3-D Phase 2 TUI 客户端 tracer：驱动组件层之下（无 Ink）——
 * DaemonEventReporter（通知→TuiReporter 投影）、transcript 转换器、
 * ClientSessionRuntime 客户端环（fake client 全链路）。
 */

function notification(
  topic: RuntimeNotification["topic"],
  scope: Record<string, string>,
  payload: Record<string, unknown>,
  runId = "run_1",
): RuntimeNotification {
  return createRuntimeNotification({
    topic,
    scope: { workspacePath: "C:\\ws", runId, ...scope },
    resourceVersion: 1,
    at: 1,
    payload,
  }) as RuntimeNotification;
}

function liveItem(item: Record<string, unknown>, runId = "run_1"): RuntimeNotification {
  return notification("run.live", {}, { runId, item }, runId);
}

test("daemon event reporter: text stream + tool card + run lifecycle drive TuiReporter", () => {
  const reporter = new TuiReporter();
  let runningChanges = 0;
  const adapter = new DaemonEventReporter({
    reporter,
    onRunStateChanged: () => {
      runningChanges += 1;
    },
  });

  adapter.handleNotification(
    notification("run.started", {}, { run: { runId: "run_1", status: "running" } }),
  );
  adapter.handleNotification(
    liveItem({ kind: "thinking", operation: "append", streamId: "t1", turnId: "turn1", delta: "推理中" }),
  );
  adapter.handleNotification(
    liveItem({ kind: "assistantMessage", operation: "append", streamId: "a1", turnId: "turn1", delta: "你好" }),
  );
  adapter.handleNotification(
    liveItem({ kind: "assistantMessage", operation: "append", streamId: "a1", turnId: "turn1", delta: "，世界" }),
  );
  let projection = reporter.getProjection();
  const contents = projection.entries
    .map(({ entry }) => entry)
    .filter((entry) => entry.kind === "assistant")
    .map((entry) => (entry as { content?: string }).content ?? "");
  assert.ok(contents.includes("你好，世界"), `流式文本应拼接，实际 ${JSON.stringify(contents)}`);
  assert.ok(
    projection.entries.some(({ entry }) => entry.kind === "thinking"),
    "thinking 流应入投影",
  );

  // 工具卡：started(带 args) → output → completed。
  adapter.handleNotification(
    liveItem({ kind: "tool", toolCallId: "call_1", toolName: "bash", operation: "started", args: "npm test" }),
  );
  adapter.handleNotification(
    liveItem({
      kind: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      operation: "append",
      streamId: "tool:live:run_1:call_1:stdout",
      stream: "stdout",
      delta: "ok 1\n",
    }),
  );
  adapter.handleNotification(
    liveItem({
      kind: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      operation: "completed",
      summary: "exit 0",
    }),
  );
  projection = reporter.getProjection();
  const toolEntry = projection.entries
    .map(({ entry }) => entry)
    .find((entry) => entry.kind === "tool");
  assert.ok(toolEntry, "工具卡应入投影");
  if (toolEntry?.kind === "tool") {
    assert.equal(toolEntry.name, "bash");
    assert.equal(toolEntry.args, "npm test");
    assert.equal(toolEntry.status, "success");
  }

  // 子代理活动卡。
  adapter.handleNotification(
    liveItem({ kind: "subagent", operation: "update", activityId: "act_1", status: "running", task: "扫描" }),
  );
  assert.ok(
    reporter.getProjection().entries.some(({ entry }) => entry.kind === "subagent-activity"),
    "子代理卡应入投影",
  );

  // run 完成 → onFinish + running 回 false。
  assert.equal(adapter.running, true);
  adapter.handleNotification(
    notification("run.finished", {}, { run: { runId: "run_1", status: "succeeded" } }),
  );
  assert.equal(adapter.running, false);
  assert.ok(runningChanges >= 2, "running 状态变化应透传");
});

test("daemon event reporter: cancelled run drives onInterrupted; approval events pass through", () => {
  const reporter = new TuiReporter();
  const approvals: ApprovalNotice[] = [];
  const adapter = new DaemonEventReporter({
    reporter,
    onApprovalRequested: (payload) => {
      approvals.push(payload as unknown as ApprovalNotice);
    },
  });
  adapter.handleNotification(
    notification("run.started", {}, { run: { runId: "run_9", status: "running" } }, "run_9"),
  );
  adapter.handleNotification(
    liveItem({ kind: "tool", toolCallId: "c9", toolName: "write_file", operation: "started", args: "x" }, "run_9"),
  );
  adapter.handleNotification(
    notification("run.finished", {}, { run: { runId: "run_9", status: "cancelled" } }, "run_9"),
  );
  assert.equal(adapter.running, false, "取消也应结束活跃态");

  adapter.handleNotification(
    notification(
      "approval.requested",
      {},
      { approvalId: "ap_1", runId: "run_9", request: { toolName: "bash", args: "rm -rf", title: "高危命令" } },
      "run_9",
    ),
  );
  assert.equal(approvals.length, 1);
});

test("transcript item hydration: RPC items convert into a projectable transcript", () => {
  const events = transcriptEventsFromRuntimeItems(
    [
      { id: "i1", kind: "userMessage", content: "帮我跑测试" },
      { id: "i2", kind: "assistantMessage", content: "好的" },
      { id: "i3", kind: "tool", name: "bash", args: "npm test", status: "success", summary: "exit 0" },
      { id: "i4", kind: "runBoundary", status: "succeeded", startedAt: 1, finishedAt: 2 },
      { id: "i5", kind: "subagent", title: "扫描模块", state: "done" },
      { id: "i6", kind: "goal", title: "目标" },
    ],
    "s1",
  );
  assert.equal(events.length, 5, "goal 无 TranscriptEntry 对应 kind，应跳过");
  const store = new TranscriptEventStore({ initialEvents: events });
  const kinds = store
    .getProjection()
    .entries.map(({ entry }) => entry.kind);
  assert.deepEqual([...new Set(kinds)].sort(), [
    "assistant",
    "run-boundary",
    "subagent-activity",
    "tool",
    "user",
  ]);
});

interface FakeClientHarness {
  readonly client: DaemonSessionClient;
  readonly requests: { method: string; params: Record<string, unknown> }[];
  emit(notification: RuntimeNotification): void;
  setTranscriptItems(items: unknown[]): void;
}

function createFakeClient(): FakeClientHarness {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let listener: ((notification: RuntimeNotification) => void) | undefined;
  let transcriptItems: unknown[] = [];
  const session = {
    sessionId: "s1",
    workspacePath: "C:\\ws",
    title: "t",
    status: "active",
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const client = {
    connect: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "session.send") {
        return { session, run: { runId: "run_1", status: "running" }, disposition: "started" };
      }
      if (method === "session.transcript") {
        return {
          session,
          items: transcriptItems,
          queuedInputs: [],
          revision: "v1",
        };
      }
      if (method === "approval.respond") {
        return { accepted: true, alreadyResolved: false };
      }
      if (method === "run.cancel") {
        return { run: { runId: "run_1", status: "cancelling" } };
      }
      if (method === "plan.respond") {
        return { accepted: true };
      }
      return {};
    },
    subscribe: async (
      _params: unknown,
      notificationListener: (notification: RuntimeNotification) => void,
    ) => {
      listener = notificationListener;
      return {
        replay: { subscribed: true, events: [], hasMore: false },
        dispose: () => {
          listener = undefined;
        },
      };
    },
  };
  return {
    client: client as unknown as DaemonSessionClient,
    requests,
    emit: (event) => listener?.(event),
    setTranscriptItems: (items) => {
      transcriptItems = items;
    },
  };
}

test("client session runtime: start hydrates, send maps to session.send, live events project", async () => {
  const harness = createFakeClient();
  const reporter = new TuiReporter();
  const runtime = new ClientSessionRuntime({
    client: harness.client,
    workspacePath: "C:\\ws",
    sessionId: "s1",
    reporter,
  });
  harness.setTranscriptItems([{ id: "i1", kind: "userMessage", content: "历史消息" }]);
  await runtime.start();
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "session.transcript" && entry.params.sessionId === "s1",
    ),
    "显式 sessionId 启动应先水化 transcript",
  );
  assert.ok(
    reporter.getProjection().entries.some(({ entry }) => entry.kind === "user"),
    "历史消息应入投影",
  );

  // 斜杠命令本地拦截。
  assert.equal(await runtime.sendText("/help"), false, "斜杠命令 v1 本地拦截");
  assert.ok(
    !harness.requests.some((entry) => entry.method === "session.send"),
    "拦截不应上送",
  );

  // 正常文本 → session.send 参数形状。
  assert.equal(await runtime.sendText("跑一下构建"), true);
  const send = harness.requests.find((entry) => entry.method === "session.send");
  assert.ok(send, "应发出 session.send");
  assert.equal(send?.params.input.kind, "text");
  assert.deepEqual(
    { ...(send?.params.input as Record<string, unknown>) }.text,
    "跑一下构建",
  );
  assert.equal(typeof send?.params.idempotencyKey, "string");
  assert.equal(send?.params.behavior, "auto");
  assert.equal(runtime.activeSessionId, "s1");

  // 事件流：run.live 文本增量直投投影。
  harness.emit(liveItem({ kind: "assistantMessage", operation: "append", streamId: "a1", turnId: "turn1", delta: "开始" }));
  assert.ok(
    reporter.getProjection().entries.some(({ entry }) => entry.kind === "assistant"),
    "live 文本应入投影",
  );

  // 中断：无 run 时静默；有 run 时 run.cancel。
  const before = harness.requests.length;
  await runtime.interrupt();
  assert.equal(harness.requests.length, before, "无活跃 run 不应发 run.cancel");
  harness.emit(notification("run.started", {}, { run: { runId: "run_1", status: "running" } }));
  await runtime.interrupt();
  assert.ok(harness.requests.some((entry) => entry.method === "run.cancel"));

  runtime.dispose();
});

test("client session runtime: approvals map to approval.respond and dialog callbacks", async () => {
  const harness = createFakeClient();
  const reporter = new TuiReporter();
  const approvals: ApprovalNotice[] = [];
  const resolved: string[] = [];
  const runtime = new ClientSessionRuntime({
    client: harness.client,
    workspacePath: "C:\\ws",
    reporter,
    onApproval: (notice) => {
      approvals.push(notice);
    },
    onApprovalResolved: (approvalId) => {
      resolved.push(approvalId);
    },
  });
  await runtime.start();

  harness.emit(
    notification("approval.requested", {}, {
      approvalId: "ap_1",
      runId: "run_1",
      request: { toolName: "bash", args: "rm -rf /tmp/x", title: "高危命令审批" },
    }),
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.taskId, "ap_1");
  assert.equal(approvals[0]?.toolName, "bash");
  assert.equal(approvals[0]?.message, "高危命令审批");

  assert.equal(await runtime.resolvePlain("approve", "ap_1"), true);
  const respond = harness.requests.find((entry) => entry.method === "approval.respond");
  assert.ok(respond, "应发出 approval.respond");
  assert.equal(respond?.params.approvalId, "ap_1");
  assert.equal(respond?.params.decision, "allow_once");

  assert.equal(await runtime.resolvePlain("reject", "ap_1"), true);
  assert.equal(
    harness.requests.filter((entry) => entry.method === "approval.respond").at(-1)?.params.decision,
    "deny",
  );

  harness.emit(
    notification("approval.resolved", {}, { approvalId: "ap_1", decision: "deny" }),
  );
  assert.deepEqual(resolved, ["ap_1"], "对端解析应回调清理对话框");

  // transcriptUpdated reload 触发重取（对账）——本用例无初始 sessionId，
  // 首次水化被跳过，reload 是唯一的 transcript 请求来源（顺带验证 scope 采纳）。
  harness.setTranscriptItems([
    { id: "i1", kind: "userMessage", content: "历史" },
    { id: "i2", kind: "assistantMessage", content: "回答" },
  ]);
  harness.emit(
    notification(
      "session.transcriptUpdated",
      { sessionId: "s1" },
      { sessionId: "s1", operation: "reload" },
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "session.transcript" && entry.params.sessionId === "s1",
    ),
    "reload 应采纳 scope sessionId 并触发 transcript 重取",
  );

  runtime.dispose();
});
