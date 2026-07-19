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
