import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:https";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_METHODS,
  type RemotePairingOffer,
} from "@pico/protocol/remote";
import type { RemoteRelayEndpoint } from "@pico/protocol/relay";
import {
  RemoteRuntimeClient,
  RemoteProtocolError,
  type RemoteSocket,
} from "../../../packages/remote-client/src/index.js";
import {
  createRelayIdentity,
  createRelayHostSession,
} from "../../../packages/remote-client/src/relay-crypto.js";
import { RecoverablePairing, PENDING_PAIRING_KEY } from "../../../apps/mobile/src/pairing.js";
import type { SavedHost } from "../../../apps/mobile/src/core.js";
import { createTestTlsFixture } from "./tls-fixture.js";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "中继恢复没有到达预期状态");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture(t: TestContext) {
  const tls = await createTestTlsFixture();
  const server = createServer({ cert: tls.cert, key: tls.key }, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server, path: "/v1/relay" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const relayUrl = `https://127.0.0.1:${address.port}`;
  const identity = createRelayIdentity(randomBytes);
  const endpoint: RemoteRelayEndpoint = {
    mode: "relay",
    relayUrl,
    gatewayId: "gateway-a",
    hostPublicKey: identity.publicKey,
  };
  const caps = {
    version: 1,
    gatewayId: endpoint.gatewayId,
    platform: "test",
    permissions: ["workspace.read", "session.control"],
    methods: REMOTE_METHODS,
    features: {},
    maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
  };
  const wire: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const sockets = new Set<WebSocket>();
  let connections = 0;
  let dropCommand = false;
  let loseAck = false;
  let verificationUnavailable = false;
  let acknowledged = false;
  let tamper = false;
  wss.on("connection", (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, undefined, "中继的 TLS/WS 握手没有手机凭据");
    sockets.add(socket);
    const session = createRelayHostSession(endpoint, identity.secretKey, randomBytes);
    const send = (message: unknown) =>
      socket.send(JSON.stringify({ version: 1, type: "data", payload: session.send(message) }));
    socket.on("close", () => {
      sockets.delete(socket);
      session.close();
    });
    socket.on("message", (raw) => {
      wire.push(raw.toString());
      const outer = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (outer.type === "join") {
        assert.equal(outer.gatewayId, endpoint.gatewayId);
        socket.send(
          JSON.stringify({ version: 1, type: "joined", channelId: `channel-${connections}` }),
        );
        return;
      }
      try {
        const result = session.receive(String(outer.payload));
        if ("reply" in result) {
          const reply = JSON.parse(result.reply) as { ciphertext: string };
          if (tamper)
            reply.ciphertext =
              (reply.ciphertext[0] === "0" ? "1" : "0") + reply.ciphertext.slice(1);
          socket.send(
            JSON.stringify({
              version: 1,
              type: "data",
              payload: tamper ? JSON.stringify(reply) : result.reply,
            }),
          );
          return;
        }
        const message = result.message as Record<string, unknown>;
        messages.push(message);
        if (message.kind === "request") {
          const response = (body: unknown, status = 200) =>
            send({ kind: "response", id: message.id, status, body });
          if (message.path === "/v1/pairings")
            return response({
              pairingId: "pairing-a",
              pairingToken: "pairing-token",
              expiresAt: Date.now() + 60_000,
            });
          if (message.path === "/v1/pairings/pairing-a/ack") {
            assert.equal(message.token, "pairing-token");
            acknowledged = true;
            if (loseAck) return socket.close();
            return response({ acknowledged: true });
          }
          if (message.path === "/v1/pairings/pairing-a")
            return response({
              status: "approved",
              deviceId: "device-a",
              deviceToken: "device-token",
              publicUrl: relayUrl,
              gatewayId: endpoint.gatewayId,
              relay: endpoint,
              permissions: ["workspace.read"],
              workspaceIds: ["workspace-a"],
            });
          assert.equal(message.token, "device-token");
          if (message.path === "/v1/capabilities") {
            if (verificationUnavailable) return socket.close();
            return response(caps);
          }
          if (message.path === "/v1/workspaces")
            return response({ workspaces: [{ id: "workspace-a", label: "project" }] });
          if (message.path === "/v1/device") return response({ revoked: true });
          const request = message.body as { requestId: string; method: string };
          if (request.method === "session.send" && dropCommand) {
            dropCommand = false;
            return socket.close();
          }
          return response({ requestId: request.requestId, ok: true, value: { sessions: [] } });
        }
        if (message.kind === "events.open") {
          assert.equal(message.token, "device-token");
          return send({
            kind: "event",
            value: {
              type: "ready",
              version: 1,
              gatewayId: endpoint.gatewayId,
              connectionId: "events-a",
            },
          });
        }
        if (message.kind === "events.send") {
          const frame = message.value as Record<string, unknown>;
          if (frame.type === "subscribe")
            send({
              kind: "event",
              value: {
                type: "subscribed",
                subscriptionId: frame.subscriptionId,
                workspaceId: frame.workspaceId,
                replay: { subscribed: true, events: [], hasMore: false },
              },
            });
        }
      } catch {
        socket.close();
      }
    });
  });
  const options = {
    relay: endpoint,
    randomBytes,
    createWebSocket: (url: string, headers: Readonly<Record<string, string>>) =>
      new WebSocket(url, { ca: tls.cert, headers }) as unknown as RemoteSocket,
  };
  const client = (relay = endpoint, onState?: (state: string) => void) =>
    new RemoteRuntimeClient({
      ...options,
      relay,
      publicUrl: relayUrl,
      gatewayId: endpoint.gatewayId,
      deviceToken: "device-token",
      onState,
    });
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tls.close();
  });
  return {
    options,
    client,
    endpoint,
    relayUrl,
    messages,
    wire,
    get connections() {
      return connections;
    },
    get acknowledged() {
      return acknowledged;
    },
    loseAck(value: boolean) {
      loseAck = value;
    },
    failVerification(value: boolean) {
      verificationUnavailable = value;
    },
    dropCommand() {
      dropCommand = true;
    },
    tamper() {
      tamper = true;
    },
  };
}

test("加密中继完成可恢复手机配对、RPC和事件订阅，外层不泄露手机凭据", async (t) => {
  const f = await fixture(t);
  const storage = new Map<string, string>();
  let installed: SavedHost | undefined;
  const offer: RemotePairingOffer = {
    version: 1,
    publicUrl: f.relayUrl,
    gatewayId: f.endpoint.gatewayId,
    relay: f.endpoint,
    secret: "pairing-secret-".repeat(4),
    expiresAt: Date.now() + 60_000,
  };
  const verify = async () => {
    const client = f.client();
    try {
      await client.capabilities();
    } finally {
      client.close();
    }
  };
  const pairing = () =>
    new RecoverablePairing(
      {
        getItemAsync: async (key) => storage.get(key) ?? null,
        setItemAsync: async (key, value) => {
          storage.set(key, value);
        },
        deleteItemAsync: async (key) => {
          storage.delete(key);
        },
      },
      {
        submit: (offer, name) =>
          RemoteRuntimeClient.submitPairing(
            offer,
            { deviceName: name, platform: "android" },
            undefined,
            f.options,
          ),
        status: (url, claim, relay) =>
          RemoteRuntimeClient.pairingStatus(url, claim, undefined, { ...f.options, relay }),
        acknowledge: (url, claim, relay) =>
          RemoteRuntimeClient.acknowledgePairing(url, claim, undefined, { ...f.options, relay }),
        verify,
        install: async (host) => {
          installed = host;
        },
        revoke: async () => {},
        forget: async () => {},
        changed: () => {},
      },
    );
  f.loseAck(true);
  f.failVerification(true);
  await assert.rejects(pairing().start(offer, "手机"), /配对确认结果未确认/);
  assert.equal(f.acknowledged, true);
  assert.equal(installed, undefined);
  assert.deepEqual(JSON.parse(storage.get(PENDING_PAIRING_KEY)!).relay, f.endpoint);
  f.loseAck(false);
  f.failVerification(false);
  const saved = await pairing().resume();
  assert.equal(saved?.id, "gateway-a.device-a");
  assert.deepEqual(saved?.relay, f.endpoint);
  assert.equal(storage.size, 0);
  assert.equal(f.messages.filter((m) => m.path === "/v1/pairings").length, 1);
  const client = f.client();
  t.after(() => client.close());
  await client.connect();
  assert.deepEqual(await client.workspaces(), [{ id: "workspace-a", label: "project" }]);
  const subscription = await client.subscribe({ workspaceId: "workspace-a" }, () => {});
  assert.equal(subscription.replay.subscribed, true);
  assert.deepEqual(await client.request("session.list", {}, { workspaceId: "workspace-a" }), {
    sessions: [],
  });
  subscription.dispose();
  assert.throws(() => client.artifactUrl("w", "s", "a"), /加密分块/);
  const visible = f.wire.join("\n");
  for (const secret of [
    "device-token",
    "pairing-token",
    offer.secret,
    "session.list",
    "Authorization",
  ])
    assert.equal(visible.includes(secret), false, `中继可见帧不得包含 ${secret}`);
});

test("中继丢失命令回执保持unknown，重连只恢复事件；篡改密文阻断连接且不降级", async (t) => {
  const f = await fixture(t);
  const states: string[] = [];
  const client = f.client(f.endpoint, (state) => states.push(state));
  t.after(() => client.close());
  await client.connect();
  f.dropCommand();
  await assert.rejects(
    client.request(
      "session.send",
      { input: { kind: "text", text: "只执行一次" }, idempotencyKey: "original-command" },
      { workspaceId: "workspace-a" },
    ),
    (error: unknown) => error instanceof RemoteProtocolError && error.outcome === "unknown",
  );
  await until(() => f.connections > 1 && states.at(-1) === "connected");
  assert.equal(
    f.messages.filter(
      (m) => m.kind === "request" && (m.body as { method?: string })?.method === "session.send",
    ).length,
    1,
  );
  client.close();
  f.tamper();
  const badStates: string[] = [];
  const bad = f.client(f.endpoint, (state) => badStates.push(state));
  t.after(() => bad.close());
  await assert.rejects(
    bad.connect(),
    (error: unknown) =>
      error instanceof RemoteProtocolError && error.code === "RELAY_IDENTITY_ERROR",
  );
  assert.equal(badStates.at(-1), "incompatible");
  const count = f.connections;
  await assert.rejects(bad.connect());
  assert.equal(f.connections, count, "身份失败不重连或降级直连");
});
