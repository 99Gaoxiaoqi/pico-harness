import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  createRuntimeNotification,
  isRunLiveRuntimeNotification,
  RuntimeNotificationBuffer,
  type RuntimeNotification,
} from "@pico/protocol";
import { publishDesktopReporterEvent } from "../../src/daemon/production-host.js";
import type { DesktopReporterEvent } from "../../src/daemon/desktop-reporter.js";
import { ToolLiveCoalescer } from "../../src/daemon/tool-live-coalescer.js";
import {
  transportSafeRuntimeNotificationWithin,
  type WorkspaceRuntimeService,
} from "../../src/daemon/workspace-runtime-service.js";

/**
 * 3-D Phase 1：run.live 工具/子代理实时事件。
 * 覆盖：publishDesktopReporterEvent 的新 kind 路由形状（durable timeline 照旧）、
 * ToolLiveCoalescer 的窗口合流与完成/终态冲刷顺序、协议校验器接受新 item、
 * RuntimeNotificationBuffer 不丢新 kind 且工具 append 参与同流合流、
 * 传输裁剪只裁 payload 不侵信封、未知 kind 的 wire 前向兼容语义。
 */

interface RecordedNotification {
  readonly topic: string;
  readonly payload: Record<string, unknown>;
}

function createRecordingService(): {
  ephemeral: RecordedNotification[];
  durable: RecordedNotification[];
  service: WorkspaceRuntimeService;
} {
  const ephemeral: RecordedNotification[] = [];
  const durable: RecordedNotification[] = [];
  return {
    ephemeral,
    durable,
    // publishDesktopReporterEvent 只调用这两个发布面；fake 只做记录。
    service: {
      publishEphemeralNotification: (notification: RuntimeNotification<"run.live">) => {
        ephemeral.push({
          topic: notification.topic,
          payload: notification.payload as Record<string, unknown>,
        });
      },
      publishDesktopNotification: (notification: RuntimeNotification) => {
        durable.push({
          topic: notification.topic,
          payload: notification.payload as Record<string, unknown>,
        });
      },
    } as unknown as WorkspaceRuntimeService,
  };
}

function reporterEvent(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  runId = "run_test",
): DesktopReporterEvent {
  return {
    runId,
    sessionId: "session_test",
    type,
    resourceVersion: 1,
    at: 1_000,
    payload,
  };
}

function liveItems(notifications: readonly RecordedNotification[]): Record<string, unknown>[] {
  return notifications
    .filter((entry) => entry.topic === "run.live")
    .map((entry) => (entry.payload["item"] as Record<string, unknown>) ?? {});
}

let resourceVersion = 0;
const nextResourceVersion = (): number => {
  resourceVersion += 1;
  return resourceVersion;
};

test("run.live tool events: started/output/completed route with correct shapes, timeline intact", () => {
  const recorder = createRecordingService();
  const route = (event: DesktopReporterEvent): void => {
    publishDesktopReporterEvent(recorder.service, "C:\\ws", event, nextResourceVersion);
  };

  route(
    reporterEvent("tool.started", {
      toolName: "bash",
      args: "npm test",
      turn: 2,
      providerCallId: "call_1",
    }),
  );
  const started = liveItems(recorder.ephemeral).find((item) => item["kind"] === "tool");
  assert.ok(started, "tool.started 应路由 run.live tool 项");
  assert.equal(started["operation"], "started");
  assert.equal(started["toolCallId"], "call_1");
  assert.equal(started["toolName"], "bash");
  assert.equal(started["args"], "npm test", "started 应携带有界调用参数（live 卡片展示）");
  assert.equal(started["turnId"], "turn:run_test:2");

  route(
    reporterEvent("tool.output", {
      toolName: "bash",
      stream: "stdout",
      chunk: "ok 1\nok 2\n",
      providerCallId: "call_1",
    }),
  );
  const output = liveItems(recorder.ephemeral).find(
    (item) => item["kind"] === "tool" && item["operation"] === "append",
  );
  assert.ok(output, "tool.output 应路由 run.live tool append 项");
  assert.equal(output["streamId"], "tool:live:run_test:call_1:stdout");
  assert.equal(output["stream"], "stdout");
  assert.equal(output["delta"], "ok 1\nok 2\n");
  assert.equal(output["toolCallId"], "call_1");

  route(
    reporterEvent("tool.completed", {
      result: {
        version: 1,
        toolCallId: "call_1",
        toolName: "bash",
        status: "succeeded",
        rawSizeBytes: 16,
        sha256: "0".repeat(64),
        projection: {
          version: 1,
          mode: "preview",
          text: "exit 0",
          strategy: "test",
          truncated: false,
        },
        deliveryTruncated: false,
      },
    }),
  );
  const completed = liveItems(recorder.ephemeral).find(
    (item) => item["kind"] === "tool" && item["operation"] === "completed",
  );
  assert.ok(completed, "tool.completed(succeeded) 应路由 completed 项");
  assert.equal(completed["summary"], "exit 0");
  assert.equal(completed["truncated"], undefined);

  // durable timeline 照旧：tool.started/completed 各有一条 timeline 记录。
  assert.ok(
    recorder.durable.some(
      (entry) =>
        entry.topic === "run.timeline" &&
        (entry.payload["item"] as Record<string, unknown>)?.["kind"] === "tool",
    ),
    "工具事件仍应进 durable timeline（live 只是 overlay）",
  );
  // tool.output 不进 timeline（既有语义）。
  assert.ok(
    !recorder.durable.some(
      (entry) => (entry.payload["item"] as Record<string, unknown>)?.["operation"] === "append",
    ),
  );
});

test("run.live tool events: failed status maps to failed operation", () => {
  const recorder = createRecordingService();
  publishDesktopReporterEvent(
    recorder.service,
    "C:\\ws",
    reporterEvent("tool.completed", {
      result: {
        version: 1,
        toolCallId: "call_bad",
        toolName: "bash",
        status: "failed",
        rawSizeBytes: 8,
        sha256: "1".repeat(64),
        projection: {
          version: 1,
          mode: "synthetic",
          text: "boom",
          strategy: "test",
          truncated: false,
        },
        deliveryTruncated: true,
      },
    }),
    nextResourceVersion,
  );
  const failed = liveItems(recorder.ephemeral).find((item) => item["kind"] === "tool");
  assert.ok(failed, "tool.completed 应路由 run.live tool 项");
  assert.equal(failed["operation"], "failed");
  assert.equal(failed["truncated"], true, "deliveryTruncated 应映射 truncated");
});

test("run.live subagent events: activity snapshot routes as update", () => {
  const recorder = createRecordingService();
  publishDesktopReporterEvent(
    recorder.service,
    "C:\\ws",
    reporterEvent("subagent.activity", {
      activityId: "act_1",
      task: "扫描模块",
      status: "running",
      agentName: "ExploreAgent",
      mode: "explore",
      currentAction: "reading src/engine/loop.ts",
      completionPolicy: "required",
    }),
    nextResourceVersion,
  );
  const update = liveItems(recorder.ephemeral).find((item) => item["kind"] === "subagent");
  assert.ok(update, "subagent.activity 应路由 run.live subagent 项");
  assert.equal(update["operation"], "update");
  assert.equal(update["activityId"], "act_1");
  assert.equal(update["status"], "running");
  assert.equal(update["mode"], "explore");
  assert.equal(update["currentAction"], "reading src/engine/loop.ts");
  assert.equal(update["completionPolicy"], undefined, "快照不携带非卡片字段");
  // 校验器接受（不会被 RuntimeNotificationBuffer 的 drop-unknown 路径丢弃）。
  const notification = createRuntimeNotification({
    topic: "run.live",
    scope: { workspacePath: "C:\\ws", runId: "run_test", sessionId: "session_test" },
    resourceVersion: 1,
    at: 1,
    payload: {
      runId: "run_test",
      item: {
        kind: "subagent",
        operation: "update",
        activityId: "act_1",
        status: "running",
      },
    },
  });
  assert.ok(isRunLiveRuntimeNotification(notification), "subagent item 应通过协议校验器");
});

test("ToolLiveCoalescer: window merge, completion flush order, dispose flush", async () => {
  const routed: DesktopReporterEvent[] = [];
  const coalescer = new ToolLiveCoalescer((event) => routed.push(event), { flushMs: 30 });

  coalescer.push(
    reporterEvent("tool.output", {
      toolName: "bash",
      stream: "stdout",
      chunk: "a",
      providerCallId: "c1",
    }),
  );
  coalescer.push(
    reporterEvent("tool.output", {
      toolName: "bash",
      stream: "stdout",
      chunk: "b",
      providerCallId: "c1",
    }),
  );
  coalescer.push(
    reporterEvent("tool.output", {
      toolName: "bash",
      stream: "stderr",
      chunk: "e1",
      providerCallId: "c1",
    }),
  );
  // 窗口内 3 条只应在 flush 后产出 2 条（stdout 合并 / stderr 独立流）。
  assert.equal(routed.length, 0, "窗口内不应立即发布");
  await waitFor(() => routed.length >= 2, 1000);
  assert.deepEqual(
    routed.map((event) => [String(event.payload["stream"]), String(event.payload["chunk"])]),
    [
      ["stdout", "ab"],
      ["stderr", "e1"],
    ],
    "同流 chunk 应合并，异流独立",
  );

  // tool.completed 先冲刷对应缓冲，输出增量先于完成标记。
  coalescer.push(
    reporterEvent("tool.output", {
      toolName: "bash",
      stream: "stdout",
      chunk: "c",
      providerCallId: "c1",
    }),
  );
  coalescer.push(
    reporterEvent("tool.completed", {
      result: { toolCallId: "c1", toolName: "bash", status: "succeeded" },
    }),
  );
  // 窗口 flush 产生 routed[0..1]，completed 冲刷产生 routed[2](output c) 与 routed[3]。
  const tail = routed.slice(2);
  assert.equal(tail.length, 2, "完成事件应先冲刷再放行");
  assert.equal(tail[0]?.type, "tool.output");
  assert.equal(String(tail[0]?.payload["chunk"]), "c");
  assert.equal(tail[1]?.type, "tool.completed");

  // dispose：残留缓冲无条件冲刷。
  coalescer.push(
    reporterEvent("tool.output", {
      toolName: "bash",
      stream: "stdout",
      chunk: "z",
      providerCallId: "c2",
    }),
  );
  coalescer.dispose();
  const flushed = routed.at(-1);
  assert.equal(flushed?.type, "tool.output");
  assert.equal(String(flushed?.payload["chunk"]), "z");
  assert.equal(String(flushed?.payload["providerCallId"]), "c2");
});

test("RuntimeNotificationBuffer: tool/subagent items survive and tool appends coalesce", () => {
  const buffer = new RuntimeNotificationBuffer();
  const subagent = createRuntimeNotification({
    topic: "run.live",
    scope: { workspacePath: "C:\\ws", runId: "r1", sessionId: "s1" },
    resourceVersion: 1,
    at: 1,
    payload: {
      runId: "r1",
      item: { kind: "subagent", operation: "update", activityId: "a1", status: "running" },
    },
  });
  const toolAppend = (delta: string): ReturnType<typeof createRuntimeNotification> =>
    createRuntimeNotification({
      topic: "run.live",
      scope: { workspacePath: "C:\\ws", runId: "r1", sessionId: "s1" },
      resourceVersion: 1,
      at: 1,
      payload: {
        runId: "r1",
        item: {
          kind: "tool",
          toolCallId: "c1",
          toolName: "bash",
          operation: "append",
          streamId: "tool:live:r1:c1:stdout",
          stream: "stdout",
          delta,
        },
      },
    });

  assert.ok(buffer.push(subagent), "subagent 快照不应被 buffer 丢弃");
  assert.ok(buffer.push(toolAppend("hello ")), "tool append 不应被 buffer 丢弃");
  assert.ok(buffer.push(toolAppend("world")), "tool append 不应被 buffer 丢弃");

  const drained = buffer.drain();
  assert.equal(drained.length, 2, "同流 tool append 应在 buffer 内合并为一条");
  const mergedItem = (drained[1]?.payload as Record<string, unknown>)["item"] as Record<
    string,
    unknown
  >;
  assert.equal(mergedItem["delta"], "hello world");
  assert.equal(mergedItem["toolCallId"], "c1", "合并不丢失工具身份字段");
  assert.ok(isRunLiveRuntimeNotification(drained[1]), "合并后的 tool append 仍通过校验器");
});

test("transport trimming: oversized tool summary is trimmed, envelope survives", () => {
  const hugeSummary = "x".repeat(200 * 1024);
  const notification = createRuntimeNotification({
    topic: "run.live",
    scope: { workspacePath: "C:\\ws", runId: "r1", sessionId: "s1" },
    resourceVersion: 42,
    at: 1,
    payload: {
      runId: "r1",
      item: {
        kind: "tool",
        toolCallId: "c1",
        toolName: "bash",
        operation: "completed",
        summary: hugeSummary,
      },
    },
  });
  const trimmed = transportSafeRuntimeNotificationWithin(notification, 92 * 1024);
  const item = (trimmed.payload as Record<string, unknown>)["item"] as Record<string, unknown>;
  assert.ok(String(item["summary"]).length < hugeSummary.length, "超限 summary 应被裁剪");
  assert.ok(String(item["summary"]).includes("[truncated"), "裁剪应带显式标记");
  assert.equal(trimmed.eventId, notification.eventId, "eventId 不裁");
  assert.equal(trimmed.topic, "run.live", "topic 不裁");
  assert.equal((trimmed.scope as Record<string, unknown>)["runId"], "r1", "scope 不裁");
});

test("wire forward compatibility: unknown live item kinds are ignored downstream, not fatal", () => {
  // 未来新增 kind 的前向兼容语义：校验器拒绝（buffer 侧静默丢弃），但已订阅的
  // 旧客户端消费方必须把未知 kind 当噪声忽略——Desktop renderer 的 kind 守卫
  // 即此语义；这里固化 buffer 的 drop-unknown 行为作为协议契约。
  const future = createRuntimeNotification({
    topic: "run.live",
    scope: { workspacePath: "C:\\ws", runId: "r1", sessionId: "s1" },
    resourceVersion: 1,
    at: 1,
    payload: {
      runId: "r1",
      item: {
        // @ts-expect-error 测试故意构造未知 kind（wire 前向兼容语义）
        kind: "hyperspace",
        operation: "append",
        streamId: "x",
        delta: "?",
      },
    },
  });
  assert.ok(!isRunLiveRuntimeNotification(future), "未知 kind 不应通过校验器");
  const buffer = new RuntimeNotificationBuffer();
  assert.ok(buffer.push(future), "drop-unknown 不算溢出失败");
  assert.equal(buffer.drain().length, 0, "未知 kind 应被 buffer 静默丢弃");
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}
