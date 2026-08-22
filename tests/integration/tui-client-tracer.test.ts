import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeNotification, type RuntimeNotification } from "@pico/protocol";
import { TranscriptEventStore } from "../../src/presentation/transcript-event-store.js";
import { DaemonEventReporter } from "../../src/tui/daemon-event-reporter.js";
import { transcriptEventsFromRuntimeItems } from "../../src/tui/transcript-item-hydration.js";
import {
  advanceRuntimeTranscriptPagingState,
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
    payload: payload as Parameters<typeof createRuntimeNotification>[0]["payload"],
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
    liveItem({
      kind: "thinking",
      operation: "append",
      streamId: "t1",
      turnId: "turn1",
      delta: "推理中",
    }),
  );
  adapter.handleNotification(
    liveItem({
      kind: "assistantMessage",
      operation: "append",
      streamId: "a1",
      turnId: "turn1",
      delta: "你好",
    }),
  );
  adapter.handleNotification(
    liveItem({
      kind: "assistantMessage",
      operation: "append",
      streamId: "a1",
      turnId: "turn1",
      delta: "，世界",
    }),
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
    liveItem({
      kind: "tool",
      toolCallId: "call_1",
      toolName: "bash",
      operation: "started",
      args: "npm test",
    }),
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
    liveItem({
      kind: "subagent",
      operation: "update",
      activityId: "act_1",
      status: "running",
      task: "扫描",
    }),
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
    liveItem(
      { kind: "tool", toolCallId: "c9", toolName: "write_file", operation: "started", args: "x" },
      "run_9",
    ),
  );
  adapter.handleNotification(
    notification("run.finished", {}, { run: { runId: "run_9", status: "cancelled" } }, "run_9"),
  );
  assert.equal(adapter.running, false, "取消也应结束活跃态");

  adapter.handleNotification(
    notification(
      "approval.requested",
      {},
      {
        approvalId: "ap_1",
        runId: "run_9",
        request: { toolName: "bash", args: "rm -rf", title: "高危命令" },
      },
      "run_9",
    ),
  );
  assert.equal(approvals.length, 1);
});

test("daemon event reporter: wake-style back-to-back runs each drive onStart; mid-active repeats ignored", () => {
  // wake 触发的 run 经订阅以普通 run.started 到达（daemon 侧协调器已随会话宿主），
  // 客户端只需按生命周期渲染——背靠背 run（finished 后紧跟新 started）必须各自
  // 生效；active 期间的重复 started 是同会话串行的噪声，忽略（文档化语义）。
  const reporter = new TuiReporter();
  const runningStates: boolean[] = [];
  const adapter = new DaemonEventReporter({
    reporter,
    onRunStateChanged: (running) => runningStates.push(running),
  });

  const started = (runId: string): RuntimeNotification =>
    notification("run.started", {}, { run: { runId, status: "running" } }, runId);
  const finished = (runId: string): RuntimeNotification =>
    notification("run.finished", {}, { run: { runId, status: "succeeded" } }, runId);

  adapter.handleNotification(started("run_a"));
  // 重叠 started（排队链 B 先于 A 终态启���）：跟踪最新 runId——/interrupt 打对
  // 目标（对抗评审 P2 修复后的新语义，此前忽略导致 B 全程失跟踪）。
  adapter.handleNotification(started("run_a-repeat"));
  assert.equal(adapter.running, true);
  assert.equal(adapter.activeRunId, "run_a-repeat", "重叠 started 应跟踪最新 run");

  adapter.handleNotification(finished("run_a"));
  assert.equal(adapter.running, false);

  // wake 触发的新 run（无用户输入，daemon 侧发起）。
  adapter.handleNotification(started("run_b"));
  assert.equal(adapter.running, true, "背靠背新 run 应重新进入活跃态");
  assert.equal(adapter.activeRunId, "run_b");
  adapter.handleNotification(finished("run_b"));

  // true→false→true→false 两轮完整生命周期。
  assert.deepEqual(
    runningStates,
    [true, false, true, false],
    "每个 run 的起止都应驱动 running 相位",
  );
});

test("transcript item hydration: RPC items convert into a projectable transcript", () => {
  const events = transcriptEventsFromRuntimeItems(
    [
      { id: "i1", kind: "userMessage", content: "帮我跑测试" },
      { id: "i2", kind: "assistantMessage", content: "好的" },
      {
        id: "i3",
        kind: "tool",
        name: "bash",
        args: "npm test",
        status: "success",
        summary: "exit 0",
      },
      { id: "i4", kind: "runBoundary", status: "succeeded", startedAt: 1, finishedAt: 2 },
      { id: "i5", kind: "subagent", title: "扫描模块", state: "done" },
      { id: "i6", kind: "goal", title: "目标" },
    ],
    "s1",
  );
  assert.equal(events.length, 5, "goal 无 TranscriptEntry 对应 kind，应跳过");
  const store = new TranscriptEventStore({ initialEvents: events });
  const kinds = store.getProjection().entries.map(({ entry }) => entry.kind);
  assert.deepEqual([...new Set(kinds)].sort(), [
    "assistant",
    "run-boundary",
    "subagent-activity",
    "tool",
    "user",
  ]);
});

test("transcript item hydration: tool evidence and subagent identity survive RPC hydration", () => {
  const events = transcriptEventsFromRuntimeItems(
    [
      {
        id: "tool-entry",
        kind: "tool",
        name: "read_file",
        args: '{"path":"README.md"}',
        status: "success",
        summary: "bounded preview",
        result: {
          version: 1,
          toolCallId: "provider-call",
          toolName: "read_file",
          status: "succeeded",
          rawSizeBytes: 99,
          sha256: "a".repeat(64),
          deliveryTruncated: true,
          projection: {
            version: 1,
            mode: "preview",
            text: "bounded preview",
            strategy: "head-tail",
            truncated: true,
          },
          evidence: {
            uri: "evidence://session/tool-call",
            ref: {
              schemaVersion: 2,
              contentHash: "b".repeat(64),
              sessionId: "s1",
              kind: "tool-exchange",
            },
          },
        },
      },
      {
        id: "subagent-entry",
        kind: "subagent",
        name: "Explore",
        title: "检查分页边界",
        detail: "已完成",
        state: "done",
        data: { activityId: "activity-1", mode: "explore" },
      },
    ],
    "s1",
  );
  const store = new TranscriptEventStore({ initialEvents: events });
  const projection = store.getProjection();
  const tool = Object.values(projection.toolCalls)[0];
  assert.equal(tool?.resultAvailability, "evidence");
  assert.equal(tool?.resultEnvelope?.evidence?.uri, "evidence://session/tool-call");
  assert.equal(projection.subagents["activity-1"]?.activity.agentName, "Explore");
  assert.equal(projection.subagents["activity-1"]?.activity.mode, "explore");
  assert.equal(projection.subagents["activity-1"]?.activity.status, "completed");
});

test("transcript paging state: prepends older pages and preserves byte continuation cursor", () => {
  const cursor = {
    revision: "5",
    throughTranscriptSequence: 5,
    position: 3,
    ordinal: 1,
    byteOffset: 4096,
    direction: "older" as const,
  };
  const first = advanceRuntimeTranscriptPagingState(
    { items: [] },
    {
      session: {} as never,
      items: [{ id: "new", kind: "assistantMessage", content: "new" }],
      queuedInputs: [],
      revision: "5",
      nextCursor: cursor,
    },
  );
  assert.deepEqual(first.nextCursor, cursor, "large-record byteOffset 必须原样保留");
  const complete = advanceRuntimeTranscriptPagingState(first, {
    session: {} as never,
    items: [{ id: "old", kind: "userMessage", content: "old" }],
    queuedInputs: [],
    revision: "5",
  });
  assert.deepEqual(
    complete.items.map((item) => item.id),
    ["old", "new"],
  );
  assert.throws(
    () =>
      advanceRuntimeTranscriptPagingState(first, {
        session: {} as never,
        items: [],
        queuedInputs: [],
        revision: "6",
      }),
    /revision changed/u,
  );
});

test("transcript paging state: reassembles out-of-order UTF-8 fragments before item de-duplication", () => {
  const item = {
    id: "large-assistant",
    kind: "assistantMessage" as const,
    content: `prefix-${"😀".repeat(512)}-suffix`,
  };
  const json = JSON.stringify(item);
  const splitAt = json.indexOf("😀") + "😀".length;
  const firstJson = json.slice(0, splitAt);
  const secondJson = json.slice(splitAt);
  const firstBytes = Buffer.byteLength(firstJson, "utf8");
  const secondBytes = Buffer.byteLength(secondJson, "utf8");
  const totalBytes = firstBytes + secondBytes;
  const tailFirst = advanceRuntimeTranscriptPagingState(
    { items: [] },
    {
      session: {} as never,
      items: [],
      queuedInputs: [],
      revision: "7",
      fragments: [
        {
          itemId: item.id,
          position: 1,
          ordinal: 0,
          byteOffset: firstBytes,
          byteLength: secondBytes,
          totalBytes,
          json: secondJson,
        },
      ],
      nextCursor: {
        revision: "7",
        throughTranscriptSequence: 7,
        position: 1,
        ordinal: 0,
        byteOffset: firstBytes,
        direction: "older",
      },
    },
  );
  assert.deepEqual(tailFirst.items, []);
  assert.equal(tailFirst.fragments?.[item.id]?.length, 1);

  assert.throws(
    () =>
      advanceRuntimeTranscriptPagingState(tailFirst, {
        session: {} as never,
        items: [],
        queuedInputs: [],
        revision: "7",
        fragments: [
          {
            itemId: item.id,
            position: 1,
            ordinal: 0,
            byteOffset: firstBytes,
            byteLength: secondBytes,
            totalBytes,
            json: `${secondJson.slice(0, -1)}x`,
          },
        ],
      }),
    /range content/u,
  );
  assert.throws(
    () =>
      advanceRuntimeTranscriptPagingState(tailFirst, {
        session: {} as never,
        items: [],
        queuedInputs: [],
        revision: "7",
        fragments: [
          {
            itemId: item.id,
            position: 1,
            ordinal: 0,
            byteOffset: 0,
            byteLength: firstBytes,
            totalBytes: totalBytes + 1,
            json: firstJson,
          },
        ],
      }),
    /item metadata/u,
  );

  const complete = advanceRuntimeTranscriptPagingState(tailFirst, {
    session: {} as never,
    items: [],
    queuedInputs: [],
    revision: "7",
    fragments: [
      {
        itemId: item.id,
        position: 1,
        ordinal: 0,
        byteOffset: 0,
        byteLength: firstBytes,
        totalBytes,
        json: firstJson,
      },
    ],
  });
  assert.deepEqual(complete.items, [item]);
  assert.equal(complete.fragments, undefined);
});

interface FakeClientHarness {
  readonly client: DaemonSessionClient;
  readonly requests: { method: string; params: Record<string, unknown> }[];
  emit(notification: RuntimeNotification): void;
  setTranscriptItems(items: unknown[]): void;
  setTranscriptPages(pages: readonly Record<string, unknown>[]): void;
}

function createFakeClient(): FakeClientHarness {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let listener: ((notification: RuntimeNotification) => void) | undefined;
  let transcriptItems: unknown[] = [];
  let transcriptPages: Record<string, unknown>[] = [];
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
        const queuedPage = transcriptPages.shift();
        if (queuedPage) return { session, queuedInputs: [], ...queuedPage };
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
      if (method === "config.effective.get") {
        // 真实 wire 形状：config 才是 RuntimeEffectiveConfig（嵌套，对抗评审 P0）。
        return {
          config: {
            defaultModelRouteId: "p1/m1",
            providers: [
              {
                id: "p1",
                protocol: "openai",
                baseURL: "http://x",
                apiKeyEnv: "K",
                models: ["m1", "m2"],
                discoverModels: false,
              },
            ],
            sources: {},
            revisions: { user: "1", project: "1" },
          },
        };
      }
      if (method === "session.settings.update") {
        return { settings: {} };
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
    setTranscriptPages: (pages) => {
      transcriptPages = [...pages];
    },
  };
}

test("client session runtime: hydrates every fixed-watermark transcript page", async () => {
  const harness = createFakeClient();
  const reporter = new TuiReporter();
  const cursor = {
    revision: "2",
    throughTranscriptSequence: 2,
    position: 2,
    ordinal: 0,
    byteOffset: 8192,
    direction: "older",
  } as const;
  harness.setTranscriptPages([
    {
      items: [{ id: "new", kind: "assistantMessage", content: "new" }],
      revision: "2",
      nextCursor: cursor,
    },
    {
      items: [{ id: "old", kind: "userMessage", content: "old" }],
      revision: "2",
    },
  ]);
  const runtime = new ClientSessionRuntime({
    client: harness.client,
    workspacePath: "C:\\ws",
    sessionId: "s1",
    reporter,
  });
  await runtime.start();

  const transcriptRequests = harness.requests.filter(
    (request) => request.method === "session.transcript",
  );
  assert.equal(transcriptRequests.length, 2, "TUI 不得在首页 200 items 处停止");
  assert.deepEqual(transcriptRequests[1]?.params.cursor, cursor);
  assert.deepEqual(
    reporter.getProjection().entries.map(({ entry }) => entry.kind),
    ["user", "assistant"],
  );
  runtime.dispose();
});

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

  // 斜杠分派归 processClientInput（对抗评审 P2：sendText 的核心层守卫已删——
  // 命令语法知识只在命令层）；直接调用 sendText 时按普通文本上送。
  assert.equal(await runtime.sendText("/help"), true, "sendText 不再拦截斜杠（分派在上层）");
  assert.ok(
    harness.requests.some((entry) => entry.method === "session.send"),
    "直接 sendText 按文本上送",
  );

  // 正常文本 → session.send 参数形状（取最后一条——前一步的 /help 直发也在记录里）。
  assert.equal(await runtime.sendText("跑一下构建"), true);
  const send = harness.requests.filter((entry) => entry.method === "session.send").at(-1);
  assert.ok(send, "应发出 session.send");
  const sendInput = send?.params.input as Record<string, unknown>;
  assert.equal(sendInput.kind, "text");
  assert.deepEqual({ ...sendInput }.text, "跑一下构建");
  assert.equal(typeof send?.params.idempotencyKey, "string");
  assert.equal(send?.params.behavior, "auto");
  assert.equal(runtime.activeSessionId, "s1");

  // 图片附件（3-D 漏账补齐）：sendText 第三参 → input.attachments 原样上送；
  // 无附件时不携带字段。
  const attachment = { type: "image_base64" as const, mimeType: "image/png", data: "aGl=" };
  assert.equal(await runtime.sendText("看这张图", "auto", [attachment]), true);
  const sendWithImage = harness.requests.filter((entry) => entry.method === "session.send").at(-1);
  assert.deepEqual(
    (sendWithImage?.params.input as Record<string, unknown>).attachments,
    [attachment],
    "附件应随 input 上送",
  );
  assert.equal(await runtime.sendText("纯文本"), true);
  const sendPlain = harness.requests.filter((entry) => entry.method === "session.send").at(-1);
  assert.ok(
    !("attachments" in (sendPlain?.params.input as object)),
    "无附件时不应携带 attachments 字段",
  );

  // 事件流：run.live 文本增量直投投影。
  harness.emit(
    liveItem({
      kind: "assistantMessage",
      operation: "append",
      streamId: "a1",
      turnId: "turn1",
      delta: "开始",
    }),
  );
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
    notification(
      "approval.requested",
      {},
      {
        approvalId: "ap_1",
        runId: "run_1",
        request: {
          toolName: "bash",
          args: "rm -rf /tmp/x",
          title: "高危命令审批",
          providerCallId: "call_1",
          sessionScope: { type: "bash-command", command: "rm -rf /tmp/", match: "prefix" },
        },
      },
    ),
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]?.taskId, "ap_1");
  assert.equal(approvals[0]?.toolName, "bash");
  assert.equal(approvals[0]?.message, "高危命令审批");
  // 3-D 漏账补齐：providerCallId/diff/sessionScope 透传（面板据此渲染 diff
  // 预览与"本会话内允许"第三选项）。
  assert.equal(approvals[0]?.providerCallId, "call_1");
  assert.equal(approvals[0]?.diff, undefined);
  assert.deepEqual(approvals[0]?.sessionScope, {
    type: "bash-command",
    command: "rm -rf /tmp/",
    match: "prefix",
  });

  // 编辑类审批带 diff：notice 原样携带（面板 formatDiffPreview 消费）。
  harness.emit(
    notification(
      "approval.requested",
      {},
      {
        approvalId: "ap_diff",
        runId: "run_1",
        request: {
          toolName: "edit_file",
          args: JSON.stringify({ path: "a.txt" }),
          title: "修改 a.txt",
          providerCallId: "call_2",
          diff: "--- a.txt\n+++ a.txt\n@@\n-a\n+b",
          sessionScope: { type: "file", path: "a.txt", access: "edit" },
        },
      },
    ),
  );
  const editNotice = approvals.at(-1);
  assert.equal(editNotice?.taskId, "ap_diff");
  assert.equal(editNotice?.providerCallId, "call_2");
  assert.equal(editNotice?.diff, "--- a.txt\n+++ a.txt\n@@\n-a\n+b");
  assert.deepEqual(editNotice?.sessionScope, { type: "file", path: "a.txt", access: "edit" });

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

  harness.emit(notification("approval.resolved", {}, { approvalId: "ap_1", decision: "deny" }));
  assert.deepEqual(resolved, ["ap_1"], "对端解析应回调清理对话框");

  // plan 类审批：wire 元数据映射 + plan.respond 适配器参数形状（Phase 3 首批）。
  harness.emit(
    notification(
      "approval.requested",
      {},
      {
        approvalId: "ap_plan",
        runId: "run_1",
        request: {
          kind: "plan",
          toolName: "exit_plan_mode",
          title: "计划待审",
          planId: "plan_42",
          expectedRevision: 3,
          expectedSessionSequence: 7,
        },
      },
    ),
  );
  const planNotice = approvals.at(-1) as ApprovalNotice & {
    planId?: string;
    expectedRevision?: number;
    expectedSessionSequence?: number;
  };
  assert.equal(planNotice.taskId, "ap_plan");
  assert.equal(planNotice.toolName, "exit_plan_mode");
  assert.equal(planNotice.planId, "plan_42");
  assert.equal(planNotice.expectedRevision, 3);
  assert.equal(planNotice.expectedSessionSequence, 7);

  const planControl = runtime.createPlanControl();
  await planControl.respond({
    sessionId: "s1",
    planId: "plan_42",
    action: "execute",
    expectedRevision: 3,
    expectedSessionSequence: 7,
    operationId: "op-test",
  });
  const planRespond = harness.requests.find((entry) => entry.method === "plan.respond");
  assert.ok(planRespond, "应发出 plan.respond");
  assert.equal(planRespond?.params.planId, "plan_42");
  assert.equal(planRespond?.params.action, "execute");
  assert.equal(planRespond?.params.expectedRevision, 3);

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

test("client session runtime: session scope filtering isolates foreign-session events", async () => {
  const harness = createFakeClient();
  const reporter = new TuiReporter();
  const runningStates: boolean[] = [];
  const runtime = new ClientSessionRuntime({
    client: harness.client,
    workspacePath: "C:\\ws",
    sessionId: "s_mine",
    reporter,
    onRunStateChanged: (running) => runningStates.push(running),
  });
  harness.setTranscriptItems([{ id: "m1", kind: "userMessage", content: "我的会话" }]);
  await runtime.start();

  // 他会话（wake/cron/另一客户端）的 run 事件不得驱动本会话。
  harness.emit(
    notification(
      "run.started",
      { sessionId: "s_other" },
      { run: { runId: "r_other", status: "running" } },
    ),
  );
  harness.emit(
    notification(
      "run.live",
      { sessionId: "s_other" },
      {
        runId: "r_other",
        item: {
          kind: "assistantMessage",
          operation: "append",
          streamId: "x",
          turnId: "t",
          delta: "他会的流",
        },
      },
      "r_other",
    ),
  );
  assert.equal(runtime.running, false, "他会话 run.started 不得驱动 running");
  assert.ok(
    !reporter.getProjection().entries.some(({ entry }) => entry.kind === "assistant"),
    "他会话 run.live 不得进投影",
  );

  // 本会话事件照常。
  harness.emit(
    notification(
      "run.started",
      { sessionId: "s_mine" },
      { run: { runId: "r_mine", status: "running" } },
    ),
  );
  assert.equal(runtime.running, true);

  // 切换：run 跟踪复位 + 水化替换 + 切换后旧会话事件被过滤。
  harness.setTranscriptItems([{ id: "m2", kind: "userMessage", content: "切换后的历史" }]);
  await runtime.switchSession("s_new");
  assert.equal(runtime.running, false, "切换应复位 run 跟踪");
  assert.ok(
    !reporter
      .getProjection()
      .entries.some(({ entry }) => entry.kind === "user" && entry.content === "我的会话"),
    "切换后投影应被新会话水化替换",
  );
  harness.emit(
    notification(
      "run.started",
      { sessionId: "s_mine" },
      { run: { runId: "r_mine2", status: "running" } },
    ),
  );
  assert.equal(runtime.running, false, "切换后旧会话事件应被过滤");

  // 新会话事件照常进入。
  harness.emit(
    notification(
      "run.started",
      { sessionId: "s_new" },
      { run: { runId: "r_new", status: "running" } },
    ),
  );
  assert.equal(runtime.running, true);

  // /new（sessionId=undefined）：放行采纳新会话首事件。
  await runtime.switchSession(undefined);
  harness.emit(
    notification(
      "session.transcriptUpdated",
      { sessionId: "s_fresh" },
      { sessionId: "s_fresh", operation: "reload" },
    ),
  );
  assert.equal(runtime.activeSessionId, "s_fresh", "无会话态应重新采纳事件 scope");

  runtime.dispose();
});

test("client session runtime: BYOK overrides apply once via session.settings.update", async () => {
  // 用例 1：--model m2（裸模型名）→ 解析为路由 p1/m2，sessionId 确立后应用一次。
  const harness = createFakeClient();
  const reporter = new TuiReporter();
  const runtime = new ClientSessionRuntime({
    client: harness.client,
    workspacePath: "C:\\ws",
    reporter,
    modelOverride: "m2",
    thinkingOverride: "high",
  });
  await runtime.start();
  harness.setTranscriptItems([]);
  await runtime.sendText("跑起来");
  const update = harness.requests.find((entry) => entry.method === "session.settings.update");
  assert.ok(update, "覆盖应在 sessionId 确立后发出 session.settings.update");
  assert.equal(update.params.modelRouteId, "p1/m2");
  assert.equal(update.params.thinkingEffort, "high");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").length,
    1,
    "覆盖只应用一次（sendText 与事件采纳双入口不重复）",
  );
  runtime.dispose();

  // 用例 2：无覆盖 → 零调用。
  const bare = createFakeClient();
  const bareRuntime = new ClientSessionRuntime({
    client: bare.client,
    workspacePath: "C:\\ws",
    reporter: new TuiReporter(),
  });
  await bareRuntime.start();
  await bareRuntime.sendText("hi");
  assert.ok(
    !bare.requests.some((entry) => entry.method === "session.settings.update"),
    "无覆盖不应发 settings.update",
  );
  bareRuntime.dispose();

  // 用例 3：模型不存在 → 错误提示 + 不发 update + 不阻断。
  const missing = createFakeClient();
  const missingReporter = new TuiReporter();
  const missingRuntime = new ClientSessionRuntime({
    client: missing.client,
    workspacePath: "C:\\ws",
    reporter: missingReporter,
    modelOverride: "no-such-model",
  });
  await missingRuntime.start();
  assert.ok(
    missingReporter.getProjection().entries.some(({ entry }) => entry.kind === "error"),
    "解析失败应以错误条目提示",
  );
  await missingRuntime.sendText("仍可发送");
  assert.ok(
    !missing.requests.some((entry) => entry.method === "session.settings.update"),
    "解析失败不应发 settings.update",
  );
  missingRuntime.dispose();
});
