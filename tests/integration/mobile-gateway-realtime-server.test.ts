import assert from "node:assert/strict";
import test from "node:test";
import type {
  MobileGatewayApi,
  MobileGatewayRealtimeApi,
} from "../../src/mobile-gateway/service.js";
import { startMobileGateway } from "../../src/mobile-gateway/server.js";
import WebSocket from "ws";

const token = "t".repeat(32);

test("mobile realtime socket authenticates before subscribing and strips URL credentials", async (context) => {
  const subscriptions: Array<{ projectId: string; sessionId: string }> = [];
  let disposed = false;
  let resolveDisposed: () => void = () => undefined;
  const disposedPromise = new Promise<void>((resolve) => {
    resolveDisposed = resolve;
  });
  const gateway = await startMobileGateway({
    token,
    api: createApi({
      async subscribeEvents(projectId, sessionId, listener) {
        subscriptions.push({ projectId, sessionId });
        listener({
          type: "live",
          runId: "run-1",
          item: {
            kind: "assistantMessage",
            operation: "append",
            streamId: "assistant:run-1:1",
            delta: "Hello",
          },
        });
        return {
          dispose: () => {
            disposed = true;
            resolveDisposed();
          },
        };
      },
    }),
  });
  context.after(() => gateway.close());

  const socket = new WebSocket(
    `${gateway.origin.replace("http://", "ws://")}/v1/projects/opaque/sessions/session-1/events`,
  );
  await waitForOpen(socket);
  assert.equal(subscriptions.length, 0);
  assert.doesNotMatch(socket.url, new RegExp(token));

  const messagesPromise = waitForMessages(socket, 2);
  socket.send(JSON.stringify({ type: "authenticate", token }));
  assert.deepEqual(await messagesPromise, [
    { type: "ready", sessionId: "session-1" },
    {
      type: "live",
      runId: "run-1",
      item: {
        kind: "assistantMessage",
        operation: "append",
        streamId: "assistant:run-1:1",
        delta: "Hello",
      },
    },
  ]);
  assert.deepEqual(subscriptions, [{ projectId: "opaque", sessionId: "session-1" }]);

  const closed = waitForClose(socket);
  socket.close();
  await closed;
  await withTimeout(disposedPromise, 1_000);
  assert.equal(disposed, true);
});

test("mobile realtime socket rejects a wrong first-frame token before subscribing", async (context) => {
  let subscriptions = 0;
  const gateway = await startMobileGateway({
    token,
    api: createApi({
      async subscribeEvents() {
        subscriptions += 1;
        return { dispose: () => undefined };
      },
    }),
  });
  context.after(() => gateway.close());

  const socket = new WebSocket(
    `${gateway.origin.replace("http://", "ws://")}/v1/projects/opaque/sessions/session-1/events`,
  );
  await waitForOpen(socket);
  const closed = waitForClose(socket);
  socket.send(JSON.stringify({ type: "authenticate", token: "wrong-token" }));
  assert.equal((await closed).code, 1008);
  assert.equal(subscriptions, 0);
});

function createApi(
  overrides: Partial<MobileGatewayRealtimeApi> = {},
): MobileGatewayApi & MobileGatewayRealtimeApi {
  const api: MobileGatewayApi & MobileGatewayRealtimeApi = {
    listProjects: async () => [],
    listSessions: async () => [],
    getTranscript: async () => ({ session: mobileSession(), items: [], revision: "revision-1" }),
    sendMessage: async () => ({ session: mobileSession(), disposition: "started" }),
    async subscribeEvents(projectId, sessionId, listener) {
      assert.equal(this, api);
      const subscribe = overrides.subscribeEvents ?? (async () => ({ dispose: () => undefined }));
      return subscribe(projectId, sessionId, listener);
    },
  };
  return api;
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

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForMessages(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    socket.on("message", (raw) => {
      try {
        messages.push(JSON.parse(raw.toString()) as unknown);
        if (messages.length === count) resolve(messages);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for WebSocket cleanup")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
