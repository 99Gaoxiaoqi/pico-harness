import assert from "node:assert/strict";
import test from "node:test";
import {
  MobileGatewayRealtimeClient,
  parseMobileRealtimeEvent,
  type MobileWebSocket,
} from "../../apps/mobile/src/lib/mobile-gateway-realtime.js";
import type { MobileRealtimeEvent } from "@pico/protocol";
import type {
  MobileGatewayApi,
  MobileGatewayRealtimeApi,
} from "../../src/mobile-gateway/service.js";
import { startMobileGateway } from "../../src/mobile-gateway/server.js";
import WebSocket from "ws";

const token = "t".repeat(32);

test("mobile realtime client authenticates and parses gateway events", async (context) => {
  const gateway = await startMobileGateway({
    token,
    api: createApi({
      async subscribeEvents(_projectId, _sessionId, listener) {
        listener({
          type: "live",
          runId: "run-1",
          item: { kind: "assistantMessage", operation: "append", delta: "Hello" },
        });
        return { dispose: () => undefined };
      },
    }),
  });
  context.after(() => gateway.close());
  const events: MobileRealtimeEvent[] = [];
  const states: string[] = [];
  const ready = new Promise<void>((resolve) => {
    const client = new MobileGatewayRealtimeClient(
      { origin: gateway.origin, token },
      (url) => new WebSocket(url) as unknown as MobileWebSocket,
    );
    const subscription = client.subscribe("opaque", "session-1", {
      onEvent(event) {
        events.push(event);
        if (events.length === 2) {
          subscription.dispose();
          resolve();
        }
      },
      onStateChange(state) {
        states.push(state);
      },
    });
  });
  await withTimeout(ready, 2_000);

  assert.deepEqual(states.slice(0, 2), ["connecting", "connected"]);
  assert.deepEqual(events, [
    { type: "ready", sessionId: "session-1" },
    {
      type: "live",
      runId: "run-1",
      item: { kind: "assistantMessage", operation: "append", delta: "Hello" },
    },
  ]);
});

test("mobile realtime client rejects events that expose private runtime fields", () => {
  assert.throws(
    () =>
      parseMobileRealtimeEvent(
        JSON.stringify({
          type: "run",
          run: {
            runId: "run-1",
            description: "Private event",
            status: "running",
            startedAt: 10,
            updatedAt: 20,
            workspacePath: "/private/workspace",
          },
        }),
      ),
    /格式无效/u,
  );
});

test("mobile realtime client resets reconnect backoff and reconnects immediately on app foreground", async (context) => {
  // 注入 AppState mock：验证前台回归（"active"）时重置退避并立即重连（不等待 backoff），
  // 且旧 socket 迟到的 onclose 被身份守卫忽略（不形成重连风暴）。
  const appState = createAppStateMock();
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const client = new MobileGatewayRealtimeClient(
    { origin: "http://127.0.0.1:9", token },
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    appState.source,
  );
  const subscription = client.subscribe("opaque", "session-1", {
    onEvent: () => undefined,
    onStateChange: (state) => states.push(state),
  });
  context.after(() => subscription.dispose());

  assert.equal(sockets.length, 1); // 初始连接
  assert.deepEqual(states, ["connecting"]);

  // 网络中断（1006）→ 进入退避重连（1s）
  sockets[0]!.closeFromServer(1006);
  await flushMicrotasks();
  assert.deepEqual(states, ["connecting", "connecting"]);

  // 非 active 状态不触发重连
  appState.emit("background");
  await flushMicrotasks();
  assert.equal(sockets.length, 1);

  // 前台回归：重置退避并立即重连（同步重开新 socket，无需等 1s 退避）
  appState.emit("active");
  assert.equal(sockets.length, 2);
  await flushMicrotasks();
  // openSocket 内部 close 旧 socket 的迟到 onclose 必须被身份守卫忽略（不重连、不加状态）
  assert.deepEqual(states, ["connecting", "connecting"]);

  // 新 socket 完成握手与认证
  sockets[1]!.open();
  assert.equal(sockets[1]!.sent.length, 1);
  assert.match(sockets[1]!.sent[0]!, /"authenticate"/u);

  // ready 后进入 connected；此后前台回归不再重连
  sockets[1]!.sendMessage(JSON.stringify({ type: "ready", sessionId: "session-1" }));
  assert.deepEqual(states, ["connecting", "connecting", "connected"]);

  appState.emit("active");
  await flushMicrotasks();
  assert.equal(sockets.length, 2);

  // 越过原 1s 退避窗口：若 active 未清除 pending 退避定时器，这里会出现幽灵重连
  await sleep(1_100);
  assert.equal(sockets.length, 2);
  assert.ok(!appState.isRemoved()); // 监听保持挂载，dispose 前不移除
});

test("mobile realtime client stops reconnecting on auth failure and removes AppState listener on dispose", async (context) => {
  const appState = createAppStateMock();
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const errors: string[] = [];
  const client = new MobileGatewayRealtimeClient(
    { origin: "http://127.0.0.1:9", token },
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    appState.source,
  );
  const subscription = client.subscribe("opaque", "session-1", {
    onEvent: () => undefined,
    onStateChange: (state) => states.push(state),
    onError: (error) => errors.push(error.message),
  });
  context.after(() => subscription.dispose());

  // 认证拒绝（1008 Policy Violation）：停止重连，避免认证风暴；状态转 disconnected
  sockets[0]!.closeFromServer(1008);
  await flushMicrotasks();
  assert.equal(sockets.length, 1); // 不重开 socket
  assert.deepEqual(states, ["connecting", "disconnected"]);
  assert.deepEqual(errors, ["Gateway Token 无效或已过期，请返回重新连接"]);

  // 认证失败后前台回归仍允许重连（监听保持挂载，与真机行为一致）
  appState.emit("active");
  await flushMicrotasks();
  assert.equal(sockets.length, 2);

  // dispose 后移除 AppState 监听，不再重连
  subscription.dispose();
  assert.ok(appState.isRemoved());
  appState.emit("active");
  await flushMicrotasks();
  assert.equal(sockets.length, 2);
});

function createApi(
  realtime: MobileGatewayRealtimeApi,
): MobileGatewayApi & MobileGatewayRealtimeApi {
  return {
    listProjects: async () => [],
    listSessions: async () => [],
    getTranscript: async () => ({ session: mobileSession(), items: [], revision: "revision-1" }),
    sendMessage: async () => ({ session: mobileSession(), disposition: "started" }),
    subscribeEvents: (...args) => realtime.subscribeEvents(...args),
  };
}

function mobileSession() {
  return {
    sessionId: "session-1",
    title: "Mobile foundation",
    status: "active" as const,
    pinned: false,
    createdAt: 10,
    updatedAt: 20,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for realtime client")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 可控 WebSocket 替身：不连真实网络，测试可手动触发 open/服务端 close/消息推送。
 *  close 事件异步派发（贴近真实 WebSocket），且可对同一 socket 重复触发，
 *  以模拟 openSocket 重开时旧 socket 迟到的 onclose（用于验证客户端身份守卫）。 */
class FakeSocket implements MobileWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    queueMicrotask(() => {
      this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
    });
  }

  /** 模拟服务端完成握手。 */
  open(): void {
    this.onopen?.();
  }

  /** 模拟服务端关闭连接（如网络中断 1006 / 认证拒绝 1008）。 */
  closeFromServer(code: number): void {
    queueMicrotask(() => {
      this.onclose?.({ code, reason: "" });
    });
  }

  /** 模拟服务端推送一条消息。 */
  sendMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

/** AppState mock：捕获 addEventListener 的 change 处理器，测试可手动触发各前台状态。 */
function createAppStateMock() {
  let handler: ((state: string) => void) | undefined;
  let removed = false;
  return {
    source: {
      addEventListener(_type: "change", changeHandler: (state: string) => void) {
        handler = changeHandler;
        return {
          remove() {
            removed = true;
            handler = undefined;
          },
        };
      },
    },
    emit(state: string) {
      handler?.(state);
    },
    isRemoved() {
      return removed;
    },
  };
}

/** 冲刷 FakeSocket 异步派发的 close 微任务。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
