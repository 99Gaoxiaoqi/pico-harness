import assert from "node:assert/strict";
import { test } from "node:test";
import { DesktopInteractionBroker } from "../../src/daemon/desktop-interaction-broker.js";
import {
  AskUserHandler,
  AskUserTool,
  createAskUserRequestId,
  type AskUserRequest,
} from "../../src/tools/ask-user.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import {
  ClientSessionRuntime,
  type ClientPromptRequest,
  type DaemonSessionClient,
} from "../../src/tui/client-session-runtime.js";
import { LOCAL_RUNTIME_PROTOCOL_VERSION, type RuntimeNotification } from "@pico/protocol";

/**
 * 3-D Phase 3 自由文本 ask_user 全链路（统一方案：options 可选 0-6 + freeText
 * 声明）。引擎层（schema/answer 形状/校验拒绝）→ broker 放行 → TUI 客户端
 * prompt 事件投影 + respond RPC 形状。
 */

test("ask_user 纯文本问题：options 省略 + freeText → submitText → textAnswer", async () => {
  const handler = new AskUserHandler();
  const tool = new AskUserTool(handler);
  const pendingRequests: AskUserRequest[] = [];
  handler.subscribe((event) => {
    if (event.kind === "pending") pendingRequests.push(event.request);
  });

  const execution = tool.execute(
    JSON.stringify({ question: "这个函数准备叫什么名字？", freeText: true }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingRequests.length, 1);
  const request = pendingRequests[0]!;
  assert.equal(request.freeText, true);
  assert.deepEqual(request.options, []);

  assert.equal(handler.submitText(request.requestId, "  parseUserQuery  "), true);
  const result = JSON.parse(await execution) as {
    status: string;
    textAnswer?: string;
    selectedOption?: unknown;
  };
  assert.equal(result.status, "answered");
  assert.equal(result.textAnswer, "parseUserQuery");
  assert.equal(result.selectedOption, undefined);
});

test("ask_user 参数校验：省略 options 须 freeText；混合请求 options 仍 ≥2", async () => {
  const tool = new AskUserTool(new AskUserHandler());
  await assert.rejects(
    tool.execute(JSON.stringify({ question: "开放问题" })),
    /省略 options 时必须设 freeText=true/,
  );
  await assert.rejects(
    tool.execute(JSON.stringify({ question: "凑数", options: [], freeText: true })),
    /options 必须包含 2-6 项或省略/,
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({ question: "一个选项不够", options: [{ label: "A" }], freeText: true }),
    ),
    /options 必须包含 2-6 项或省略/,
  );
  await assert.rejects(
    tool.execute(JSON.stringify({ question: "坏类型", freeText: "yes" })),
    /freeText 必须是布尔值/,
  );
});

test("submitText 只对声明 freeText 的请求生效（选项请求不受影响）", async () => {
  const handler = new AskUserHandler();
  const tool = new AskUserTool(handler);
  const pendingRequests: AskUserRequest[] = [];
  handler.subscribe((event) => {
    if (event.kind === "pending") pendingRequests.push(event.request);
  });

  const execution = tool.execute(
    JSON.stringify({
      question: "选一个",
      options: [{ label: "A" }, { label: "B" }],
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const request = pendingRequests[0]!;
  assert.equal(request.freeText, undefined);
  assert.equal(handler.submitText(request.requestId, "别的"), false, "未声明 freeText 拒绝文本");
  assert.equal(handler.select(request.requestId, "option-1"), true);
  const result = JSON.parse(await execution) as {
    status: string;
    selectedOption?: { label: string };
  };
  assert.equal(result.status, "answered");
  assert.equal(result.selectedOption?.label, "A");
});

test("broker answerPrompt：freeText 请求未命中选项时按文本提交；空白拒绝", async () => {
  const broker = new DesktopInteractionBroker();
  const handler = broker.askUserHandler;
  const pendingRequests: AskUserRequest[] = [];
  handler.subscribe((event) => {
    if (event.kind === "pending") pendingRequests.push(event.request);
  });

  const settled = handler.waitForAnswer({
    requestId: createAskUserRequestId(),
    question: "路径？",
    options: [
      { optionId: "option-1", label: "默认" },
      { optionId: "option-2", label: "自定义" },
    ],
    freeText: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const requestId = pendingRequests[0]!.requestId;

  // 选项 label 命中优先。
  assert.equal(broker.answerPrompt(requestId, "自定义"), true);
  assert.equal((await settled).kind, "selected");

  const freeSettled = handler.waitForAnswer({
    requestId: createAskUserRequestId(),
    question: "纯文本",
    options: [],
    freeText: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const freeId = pendingRequests[1]!.requestId;
  assert.equal(broker.answerPrompt(freeId, "   "), false, "空白文本拒绝");
  assert.equal(broker.answerPrompt(freeId, "D:\\work\\repo"), true);
  assert.deepEqual(await freeSettled, { kind: "text", requestId: freeId, text: "D:\\work\\repo" });
  broker.close();
});

test("TUI 客户端：prompt.requested 事件投影（freeText 透传）+ respondPrompt RPC 形状", async () => {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const prompts: ClientPromptRequest[] = [];
  const resolved: string[] = [];
  let listener: ((notification: RuntimeNotification) => void) | undefined;
  const client = {
    connect: async () => undefined,
    subscribeSessionFrames: () => ({ dispose: () => undefined }),
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "session.subscription.open") {
        return {
          session: {
            sessionId: "s1",
            workspacePath: "C:\\ws",
            title: "Session",
            status: "active",
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
          },
          hostEpoch: "host-test",
          subscriptionId: "subscription-test",
          nextSequence: 1,
          watermark: { historyEpoch: "history-test", projectorVersion: 3, throughSequence: 0 },
          durableTail: [],
          activeOverlay: [],
          queuedInputs: [],
        };
      }
      if (method === "session.subscription.close") return { closed: true };
      if (method === "prompt.respond") return { accepted: true, alreadyResolved: false };
      if (method === "prompt.cancel") return { cancelled: true };
      return {};
    },
    subscribe: async (
      _params: unknown,
      notificationListener: (notification: RuntimeNotification) => void,
    ) => {
      listener = notificationListener;
      return { replay: { subscribed: true, events: [], hasMore: false }, dispose: () => undefined };
    },
  };
  const runtime = new ClientSessionRuntime({
    client: client as unknown as DaemonSessionClient,
    workspacePath: "C:\\ws",
    sessionId: "s1",
    reporter: new TuiReporter(),
    onPrompt: (request) => prompts.push(request),
    onPromptResolved: (promptId) => resolved.push(promptId),
  });
  await runtime.start();

  listener?.({
    eventId: "e1",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    topic: "prompt.requested",
    scope: { workspacePath: "C:\\ws", sessionId: "s1", runId: "run_1" },
    resourceVersion: 1,
    at: 1,
    payload: {
      promptId: "ask_1",
      runId: "run_1",
      prompt: {
        question: "数据库迁移叫什么名？",
        header: "命名",
        options: [],
        freeText: true,
      },
    },
  } as unknown as RuntimeNotification);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.requestId, "ask_1");
  assert.equal(prompts[0]!.freeText, true);
  assert.equal(prompts[0]!.header, "命名");
  assert.deepEqual(prompts[0]!.options, []);

  // 自由文本回答 → prompt.respond（answer=文本 + 幂等键）。
  assert.equal(await runtime.respondPrompt("ask_1", "add_users_table"), true);
  const respond = requests.find((entry) => entry.method === "prompt.respond");
  assert.equal(respond?.params.promptId, "ask_1");
  assert.equal(respond?.params.answer, "add_users_table");
  assert.equal(typeof respond?.params.idempotencyKey, "string");

  // 跨会话 prompt.resolved 前置清理（scope 过滤不影响收口）。
  listener?.({
    eventId: "e2",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    topic: "prompt.resolved",
    scope: { workspacePath: "C:\\ws", sessionId: "s-other" },
    resourceVersion: 2,
    at: 2,
    payload: { promptId: "ask_1" },
  } as unknown as RuntimeNotification);
  assert.deepEqual(resolved, ["ask_1"]);

  // 其他会话的 prompt.requested 被 scope 过滤（不进对话框）。
  listener?.({
    eventId: "e3",
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    topic: "prompt.requested",
    scope: { workspacePath: "C:\\ws", sessionId: "s-other" },
    resourceVersion: 3,
    at: 3,
    payload: {
      promptId: "ask_2",
      runId: "run_2",
      prompt: {
        question: "别的问题",
        options: [
          { optionId: "option-1", label: "A" },
          { optionId: "option-2", label: "B" },
        ],
      },
    },
  } as unknown as RuntimeNotification);
  assert.equal(prompts.length, 1, "他会有话 prompt 不进本会话");
  runtime.dispose();
});
