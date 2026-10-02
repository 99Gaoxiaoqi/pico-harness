import assert from "node:assert/strict";
import { createServer, Agent } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  RemoteRuntimeClient,
  RemoteProtocolError,
  type RemoteConnectionState,
} from "../../../packages/remote-client/src/index.js";
import { createRuntimeNotification, type RuntimeNotification } from "@pico/protocol/mobile";
import { REMOTE_MAX_FRAME_BYTES, REMOTE_METHODS, type RemoteRequest } from "@pico/protocol/remote";
import { createTestTlsFixture, trustedFetch } from "./tls-fixture.js";

// Trust is injected into this test's transport only. Production client options never
// disable TLS verification; the fixture certificate must match the HTTPS hostname.
async function fixture(t: TestContext) {
  const tls = await createTestTlsFixture();
  const { cert, key } = tls;
  const requests: Array<{
    path: string;
    method: string;
    authorization?: string | undefined;
    body?: unknown;
  }> = [];
  const rpc: RemoteRequest[] = [];
  const sockets = new Set<WebSocket>();
  let connectionCount = 0;
  let socketHandler: (socket: WebSocket, message: Record<string, unknown>) => void = () =>
    undefined;
  let rpcHandler: (
    body: RemoteRequest,
    response: ServerResponse,
    request: IncomingMessage,
  ) => void = (body, response) =>
    json(response, { requestId: body.requestId, ok: true, value: { sessions: [] } });
  let pairingApproved = false;
  let pairingAcked = false;
  let revoked = false;
  const server = createServer({ cert, key }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    requests.push({
      path: request.url!,
      method: request.method!,
      authorization: request.headers.authorization,
      body,
    });
    if (request.url === "/v1/pairings" && request.method === "POST") {
      return json(response, {
        pairingId: "pairing-a",
        pairingToken: "pairing-token",
        expiresAt: Date.now() + 30_000,
      });
    }
    if (request.url?.startsWith("/v1/pairings/pairing-a")) {
      assert.equal(request.headers.authorization, "Bearer pairing-token");
      if (request.url.endsWith("/ack")) {
        pairingAcked = true;
        return json(response, { acknowledged: true });
      }
      if (pairingAcked) return json(response, { status: "expired" });
      return json(
        response,
        pairingApproved
          ? {
              status: "approved",
              deviceId: "device-a",
              deviceToken: "device-token",
              publicUrl,
              gatewayId: "gateway-a",
              permissions: ["workspace.read", "session.control"],
              workspaceIds: ["workspace-a"],
            }
          : { status: "pending" },
      );
    }
    if (request.headers.authorization !== "Bearer device-token" || revoked) {
      return json(
        response,
        { error: { code: "UNAUTHORIZED", message: "设备授权已撤销", retryable: false } },
        401,
      );
    }
    if (request.url === "/v1/capabilities")
      return json(response, {
        version: 1,
        gatewayId: "gateway-a",
        platform: process.platform,
        permissions: ["workspace.read", "session.control", "terminal.control"],
        methods: REMOTE_METHODS,
        features: {},
        maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
      });
    if (request.url === "/v1/workspaces")
      return json(response, { workspaces: [{ id: "workspace-a", label: "我的电脑" }] });
    if (request.url === "/v1/device" && request.method === "DELETE") {
      revoked = true;
      for (const socket of sockets) socket.close(4001, "revoked");
      return json(response, { revoked: true });
    }
    if (request.url === "/v1/rpc") {
      rpc.push(body as RemoteRequest);
      return rpcHandler(body as RemoteRequest, response, request);
    }
    json(response, { error: { code: "NOT_FOUND", message: "未知接口" } }, 404);
  });
  const wss = new WebSocketServer({ server, path: "/v1/events" });
  wss.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer device-token");
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) =>
      socketHandler(socket, JSON.parse(data.toString()) as Record<string, unknown>),
    );
    send(socket, {
      type: "ready",
      version: 1,
      gatewayId: "gateway-a",
      connectionId: `connection-${connectionCount}`,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const publicUrl = `https://127.0.0.1:${address.port}`;
  const fetcher = tls.fetcher;
  function client(onState?: (state: RemoteConnectionState) => void) {
    const result = new RemoteRuntimeClient({
      publicUrl,
      gatewayId: "gateway-a",
      deviceToken: "device-token",
      fetch: fetcher,
      createWebSocket: tls.createWebSocket,
      ...(onState ? { onState } : {}),
    });
    t.after(() => result.close());
    return result;
  }
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tls.close();
  });
  return {
    publicUrl,
    fetcher,
    client,
    requests,
    rpc,
    sockets,
    get connectionCount() {
      return connectionCount;
    },
    setRpc(handler: typeof rpcHandler) {
      rpcHandler = handler;
    },
    setSocket(handler: typeof socketHandler) {
      socketHandler = handler;
    },
    approve() {
      pairingApproved = true;
    },
    get pairingAcked() {
      return pairingAcked;
    },
    revokeFromComputer() {
      revoked = true;
      for (const socket of sockets) socket.close(4001, "revoked");
    },
  };
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}
function notification(index: number): RuntimeNotification {
  return createRuntimeNotification({
    eventId: `event-${index}`,
    topic: "workspace.registered",
    scope: { workspacePath: "/computer/workspace" },
    resourceVersion: index,
    at: index,
    payload: { registered: true },
  });
}
async function until(condition: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    assert.ok(performance.now() < deadline, "expected condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function remoteError(code: string, outcome?: string) {
  return (error: unknown) =>
    error instanceof RemoteProtocolError &&
    error.code === code &&
    (outcome === undefined || error.outcome === outcome);
}

test("remote client HTTPS correlates RPC, decodes typed results and enforces UTF-8 budgets", async (t) => {
  const harness = await fixture(t);
  const client = harness.client();
  assert.deepEqual(await client.workspaces(), [{ id: "workspace-a", label: "我的电脑" }]);
  harness.setRpc((body, response) => {
    if (body.workspaceId === "wrong-id")
      return json(response, { requestId: "different-request", ok: true, value: { sessions: [] } });
    if (body.workspaceId === "wrong-type")
      return json(response, { requestId: body.requestId, ok: true, value: { sessions: 42 } });
    if (body.workspaceId === "too-large")
      return json(response, {
        requestId: body.requestId,
        ok: true,
        value: { sessions: [], text: "汉".repeat(350_000) },
      });
    setTimeout(
      () => json(response, { requestId: body.requestId, ok: true, value: { sessions: [] } }),
      body.workspaceId === "first" ? 25 : 1,
    );
  });
  assert.deepEqual(
    await Promise.all([
      client.request("session.list", {}, { workspaceId: "first" }),
      client.request("session.list", {}, { workspaceId: "second" }),
    ]),
    [{ sessions: [] }, { sessions: [] }],
  );
  assert.notEqual(harness.rpc[0]?.requestId, harness.rpc[1]?.requestId);
  await assert.rejects(
    client.request("session.list", {}, { workspaceId: "wrong-id" }),
    remoteError("INVALID_RESPONSE"),
  );
  await assert.rejects(client.request("session.list", {}, { workspaceId: "wrong-type" }));
  await assert.rejects(
    client.request("session.list", {}, { workspaceId: "too-large" }),
    remoteError("FRAME_TOO_LARGE"),
  );
  const before = harness.rpc.length;
  await assert.rejects(
    client.request(
      "session.send",
      { input: { kind: "text", text: "汉".repeat(350_000) }, idempotencyKey: "input-a" },
      { workspaceId: "workspace-a" },
    ),
    remoteError("FRAME_TOO_LARGE"),
  );
  assert.equal(harness.rpc.length, before, "UTF-8 oversized input must never reach the server");
  // No CA in this separate transport: a valid hostname alone does not grant trust.
  const untrusted = new Agent();
  t.after(() => untrusted.destroy());
  const unsafeClient = new RemoteRuntimeClient({
    publicUrl: harness.publicUrl,
    deviceToken: "device-token",
    fetch: trustedFetch(untrusted),
  });
  t.after(() => unsafeClient.close());
  await assert.rejects(unsafeClient.workspaces(), remoteError("CONNECTION_FAILED"));
});

test("remote client never replays terminal input when command reply is lost", async (t) => {
  const harness = await fixture(t);
  const client = harness.client();
  let executed = 0;
  harness.setRpc((_body, _response, request) => {
    executed++;
    request.socket.destroy();
  });
  await assert.rejects(
    client.request(
      "terminal.input",
      {
        sessionId: "session-a",
        terminalId: "terminal-a",
        resourceEpoch: "epoch-a",
        data: "echo 中文\n",
      },
      { workspaceId: "workspace-a" },
    ),
    remoteError("CONNECTION_FAILED", "unknown"),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(executed, 1);
  assert.equal(harness.rpc.length, 1);
});

test("remote client pairing waits for local approval and acknowledges saved credentials", async (t) => {
  const harness = await fixture(t);
  const offer = {
    version: 1 as const,
    publicUrl: harness.publicUrl,
    gatewayId: "gateway-a",
    secret: "a".repeat(48),
    expiresAt: Date.now() + 60_000,
  };
  const pairing = await RemoteRuntimeClient.submitPairing(
    offer,
    { deviceName: "手机", platform: "ios" },
    harness.fetcher,
  );
  assert.equal(
    harness.requests[0]?.authorization,
    undefined,
    "pairing does not send a long-lived device credential",
  );
  assert.equal(
    (await RemoteRuntimeClient.pairingStatus(harness.publicUrl, pairing, harness.fetcher)).status,
    "pending",
  );
  harness.approve();
  const approved = await RemoteRuntimeClient.pairingStatus(
    harness.publicUrl,
    pairing,
    harness.fetcher,
  );
  assert.equal(approved.status, "approved");
  if (approved.status !== "approved") throw new Error("unreachable");
  assert.equal(approved.deviceToken, "device-token");
  await RemoteRuntimeClient.acknowledgePairing(harness.publicUrl, pairing, harness.fetcher);
  assert.equal(harness.pairingAcked, true);
  assert.equal(
    (await RemoteRuntimeClient.pairingStatus(harness.publicUrl, pairing, harness.fetcher)).status,
    "expired",
  );
});

test("remote client WSS replays, deduplicates and pauses background reconnects", async (t) => {
  const harness = await fixture(t);
  const states: RemoteConnectionState[] = [];
  const client = harness.client((state) => states.push(state));
  const subscriptions: Array<Record<string, unknown>> = [];
  harness.setSocket((socket, message) => {
    if (message.type !== "subscribe") return;
    subscriptions.push(message);
    const initial = message.afterEventId === undefined;
    send(socket, {
      type: "notification",
      subscriptionId: message.subscriptionId,
      workspaceId: message.workspaceId,
      event: notification(initial ? 2 : 3),
    });
    send(socket, {
      type: "subscribed",
      subscriptionId: message.subscriptionId,
      workspaceId: message.workspaceId,
      replay: {
        subscribed: true,
        events: initial ? [notification(1), notification(2)] : [notification(2), notification(3)],
        hasMore: false,
        nextAfterEventId: initial ? "event-2" : "event-3",
        highWatermarkEventId: initial ? "event-2" : "event-3",
      },
    });
    if (initial)
      send(socket, {
        type: "notification",
        subscriptionId: message.subscriptionId,
        workspaceId: "other-workspace",
        event: notification(99),
      });
  });
  const received: string[] = [];
  const subscribed = await client.subscribe({ workspaceId: "workspace-a" }, (event) =>
    received.push(event.eventId),
  );
  assert.deepEqual(
    subscribed.replay.events.map((event) => event.eventId),
    ["event-1", "event-2"],
  );
  assert.equal(
    received.length,
    0,
    "initial replay is returned, live replay overlap must not deliver twice",
  );
  for (const socket of harness.sockets) socket.terminate();
  await until(() => received.includes("event-3"));
  assert.deepEqual(received, ["event-3"]);
  assert.equal(subscriptions[1]?.afterEventId, "event-2");
  client.setForeground(false);
  await until(() => harness.sockets.size === 0);
  const connectionCount = harness.connectionCount;
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(harness.connectionCount, connectionCount);
  await assert.rejects(client.connect(), remoteError("CLIENT_BACKGROUND"));
  client.setForeground(true);
  await until(() => harness.connectionCount > connectionCount && states.at(-1) === "connected");
  assert.deepEqual(received, ["event-3"]);
  subscribed.dispose();
});

test("remote client stops retrying after device authorization is revoked", async (t) => {
  const harness = await fixture(t);
  const states: RemoteConnectionState[] = [];
  const client = harness.client((state) => states.push(state));
  await client.connect();
  harness.revokeFromComputer();
  await until(() => states.includes("unauthorized"));
  const connectionCount = harness.connectionCount;
  const requestCount = harness.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  assert.equal(harness.connectionCount, connectionCount);
  assert.equal(harness.requests.length, requestCount);
  await assert.rejects(
    client.request("session.list", {}, { workspaceId: "workspace-a" }),
    remoteError("UNAUTHORIZED"),
  );
});

test("remote client completes multi-page WSS replay before buffered live events advance the cursor", async (t) => {
  const harness = await fixture(t);
  const client = harness.client();
  harness.setSocket((socket, message) => {
    if (message.type !== "subscribe") return;
    const reconnecting = message.afterEventId === "event-4";
    send(socket, {
      type: "notification",
      subscriptionId: message.subscriptionId,
      workspaceId: message.workspaceId,
      event: notification(reconnecting ? 6 : 2),
    });
    send(socket, {
      type: "notification",
      subscriptionId: message.subscriptionId,
      workspaceId: message.workspaceId,
      event: notification(reconnecting ? 7 : 4),
    });
    send(socket, {
      type: "subscribed",
      subscriptionId: message.subscriptionId,
      workspaceId: message.workspaceId,
      replay: {
        subscribed: true,
        events: [notification(reconnecting ? 5 : 1)],
        hasMore: true,
        nextAfterEventId: reconnecting ? "event-5" : "event-1",
        highWatermarkEventId: reconnecting ? "event-6" : "event-3",
      },
    });
  });
  harness.setRpc((body, response) => {
    assert.equal(body.method, "events.replay");
    assert.equal(body.workspaceId, "workspace-a");
    const reconnecting = (body.params as Record<string, unknown>).afterEventId === "event-5";
    assert.equal(
      (body.params as Record<string, unknown>).highWatermarkEventId,
      reconnecting ? "event-6" : "event-3",
    );
    json(response, {
      requestId: body.requestId,
      ok: true,
      value: {
        events: reconnecting ? [notification(6)] : [notification(2), notification(3)],
        hasMore: false,
        nextAfterEventId: reconnecting ? "event-6" : "event-3",
        highWatermarkEventId: reconnecting ? "event-6" : "event-3",
      },
    });
  });
  const received: string[] = [];
  const subscribed = await client.subscribe({ workspaceId: "workspace-a" }, (event) =>
    received.push(event.eventId),
  );
  assert.deepEqual(
    subscribed.replay.events.map((event) => event.eventId),
    ["event-1"],
  );
  await until(() => received.length === 3);
  assert.deepEqual(received, ["event-2", "event-3", "event-4"]);
  assert.equal(harness.rpc.length, 1);
  for (const socket of harness.sockets) socket.terminate();
  await until(() => received.length === 6);
  assert.deepEqual(received, ["event-2", "event-3", "event-4", "event-5", "event-6", "event-7"]);
  assert.equal(harness.rpc.length, 2);
  subscribed.dispose();
});

test("remote client fences an in-flight replay response when the app goes to background", async (t) => {
  const harness = await fixture(t);
  const client = harness.client();
  let deliverPage: (() => void) | undefined;
  let reads = 0;
  harness.setSocket((socket, message) => {
    if (message.type !== "subscribe") return;
    send(socket, {
      type: "subscribed",
      subscriptionId: message.subscriptionId,
      workspaceId: message.workspaceId,
      replay: {
        subscribed: true,
        events: [notification(1)],
        hasMore: true,
        nextAfterEventId: "event-1",
        highWatermarkEventId: "event-2",
      },
    });
  });
  harness.setRpc((body, response) => {
    reads++;
    const deliver = () =>
      json(response, {
        requestId: body.requestId,
        ok: true,
        value: {
          events: [notification(2)],
          hasMore: false,
          nextAfterEventId: "event-2",
          highWatermarkEventId: "event-2",
        },
      });
    if (reads === 1) deliverPage = deliver;
    else deliver();
  });
  const received: string[] = [];
  const subscribed = await client.subscribe({ workspaceId: "workspace-a" }, (event) =>
    received.push(event.eventId),
  );
  await until(() => deliverPage !== undefined);
  client.setForeground(false);
  deliverPage!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    received.length,
    0,
    "old replay must not advance the background application's cursor",
  );
  client.setForeground(true);
  await until(() => received.length === 1);
  assert.deepEqual(received, ["event-2"]);
  subscribed.dispose();
});
