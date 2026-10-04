import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  startRelayServer,
  requestRelayControl,
  type RelayLimits,
  RELAY_MAX_PAYLOAD_BYTES,
} from "../../../packages/remote-relay/src/index.js";
import { createTestTlsFixture } from "./tls-fixture.js";

type Frame = Record<string, unknown>;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class Client {
  readonly messages: Frame[] = [];
  private readonly waiters = new Set<() => void>();
  readonly closed: Promise<void>;
  constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
    socket.on("error", () => undefined);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      assert.equal(frame.version, 1);
      this.messages.push(frame);
      for (const notify of this.waiters) notify();
    });
  }
  send(frame: Frame) {
    this.socket.send(JSON.stringify(frame));
  }
  next(type: string): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`No ${type} frame`));
      }, 3000);
      const check = () => {
        const index = this.messages.findIndex((message) => message.type === type);
        if (index < 0) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(this.messages.splice(index, 1)[0]!);
      };
      this.waiters.add(check);
      check();
    });
  }
}
async function fixture(t: TestContext, limits: Partial<RelayLimits> = {}) {
  const home = await mkdtemp(join(tmpdir(), "pico-relay-test-"));
  const tls = await createTestTlsFixture();
  let server = await startRelayServer({
    home,
    port: 0,
    tls: { cert: tls.cert, key: tls.key },
    limits,
  });
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await server.close();
    await tls.close();
    await rm(home, { recursive: true, force: true });
  });
  const http = async (path: string, body?: unknown) => {
    const response = await tls.fetcher(`${server.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Frame };
  };
  const connect = async (frame?: Frame) => {
    const socket = new WebSocket(`${server.origin.replace("https:", "wss:")}/v1/relay`, {
      ca: tls.cert,
    });
    const client = new Client(socket);
    clients.push(client);
    await once(socket, "open");
    if (frame) client.send(frame);
    return client;
  };
  const invite = async () =>
    (await requestRelayControl(home, "invite", {})) as { invitation: string };
  const enroll = (invitation: string, gatewayId: string, hostToken: string) =>
    http("/v1/enroll", { version: 1, invitation, gatewayId, tokenHash: hash(hostToken) });
  const host = async (gatewayId: string, hostToken: string) => {
    const client = await connect({ version: 1, type: "host", gatewayId, token: hostToken });
    await client.next("registered");
    return client;
  };
  const mobile = async (gatewayId: string) => {
    const client = await connect({ version: 1, type: "join", gatewayId });
    const joined = await client.next("joined");
    return { client, channelId: joined.channelId as string };
  };
  return {
    home,
    http,
    connect,
    invite,
    enroll,
    host,
    mobile,
    restart: async () => {
      await server.close();
      server = await startRelayServer({
        home,
        port: 0,
        tls: { cert: tls.cert, key: tls.key },
        limits,
      });
    },
  };
}

test("真实 HTTPS/WSS 邀请重试、私有持久化、多租户不透明双向转发与在线撤销", async (t) => {
  const f = await fixture(t),
    gatewayId = "desktop-one",
    hostToken = token();
  assert.deepEqual(await f.http("/v1/health"), { status: 200, body: { version: 1, status: "ok" } });
  const invitation = (await f.invite()).invitation;
  assert.equal((await f.enroll(invitation, gatewayId, hostToken)).status, 200);
  // Deliberately discard the first response; retry uses the original locally generated token.
  assert.deepEqual(await f.enroll(invitation, gatewayId, hostToken), {
    status: 200,
    body: { version: 1, enrolled: true },
  });
  assert.equal((await f.enroll(invitation, "other-desktop", hostToken)).status, 403);
  assert.equal((await f.enroll(invitation, gatewayId, token())).status, 403);
  const stateText = await readFile(join(f.home, "state.json"), "utf8");
  assert.equal(stateText.includes(invitation), false);
  assert.equal(stateText.includes(hostToken), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(f.home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.home, "state.json"))).mode & 0o777, 0o600);
  }
  await f.restart();
  assert.equal((await f.enroll(invitation, gatewayId, hostToken)).status, 200);
  const desktop = await f.host(gatewayId, hostToken);
  const duplicate = await f.connect({ version: 1, type: "host", gatewayId, token: hostToken });
  assert.equal((await duplicate.next("error")).code, "HOST_ALREADY_CONNECTED");
  await duplicate.closed;
  const one = await f.mobile(gatewayId),
    two = await f.mobile(gatewayId);
  assert.equal((await desktop.next("open")).channelId, one.channelId);
  assert.equal((await desktop.next("open")).channelId, two.channelId);
  const opaque = "not JSON: 密文 / random ciphertext ==";
  one.client.send({ version: 1, type: "data", payload: opaque });
  assert.deepEqual(await desktop.next("data"), {
    version: 1,
    type: "data",
    channelId: one.channelId,
    payload: opaque,
  });
  desktop.send({ version: 1, type: "data", channelId: two.channelId, payload: opaque });
  assert.deepEqual(await two.client.next("data"), { version: 1, type: "data", payload: opaque });
  assert.equal(
    one.client.messages.some((message) => message.type === "data"),
    false,
  );
  const maximalCiphertext = "a".repeat(RELAY_MAX_PAYLOAD_BYTES);
  one.client.send({ version: 1, type: "data", payload: maximalCiphertext });
  assert.equal((await desktop.next("data")).payload, maximalCiphertext);
  desktop.send({ version: 1, type: "data", channelId: one.channelId, payload: maximalCiphertext });
  assert.equal((await one.client.next("data")).payload, maximalCiphertext);
  const otherToken = token();
  assert.equal(
    (await f.enroll((await f.invite()).invitation, "desktop-two", otherToken)).status,
    200,
  );
  const otherHost = await f.host("desktop-two", otherToken);
  otherHost.send({
    version: 1,
    type: "data",
    channelId: one.channelId,
    payload: "foreign ciphertext",
  });
  assert.equal((await otherHost.next("error")).code, "CHANNEL_NOT_FOUND");
  await otherHost.closed;
  assert.equal(
    one.client.messages.some((message) => message.type === "data"),
    false,
  );
  assert.equal((await f.http("/v1/admin/revoke", { gatewayId })).status, 404);
  assert.deepEqual(await requestRelayControl(f.home, "revoke", { gatewayId }), {
    version: 1,
    revoked: true,
  });
  await Promise.all([desktop.closed, one.client.closed, two.client.closed]);
  const revoked = await f.connect({ version: 1, type: "host", gatewayId, token: hostToken });
  assert.equal((await revoked.next("error")).code, "HOST_AUTH_FAILED");
  await revoked.closed;
  assert.equal(
    (await f.enroll(invitation, gatewayId, hostToken)).status,
    403,
    "retry cannot undo revocation",
  );
  assert.equal((await readFile(join(f.home, "state.json"), "utf8")).includes(opaque), false);
});

test("错误令牌、缺版本、channel 限额和首帧超时被拒绝；host 掉线不缓存命令", async (t) => {
  const f = await fixture(t, { maxChannelsPerHost: 1, handshakeTimeoutMs: 150 });
  const gatewayId = "desktop",
    hostToken = token();
  await f.enroll((await f.invite()).invitation, gatewayId, hostToken);
  const wrong = await f.connect({ version: 1, type: "host", gatewayId, token: token() });
  assert.equal((await wrong.next("error")).code, "HOST_AUTH_FAILED");
  await wrong.closed;
  const desktop = await f.host(gatewayId, hostToken);
  const stalled = await f.connect();
  assert.equal((await stalled.next("error")).code, "HANDSHAKE_TIMEOUT");
  await stalled.closed;
  const missing = await f.connect({ type: "join", gatewayId });
  assert.equal((await missing.next("error")).code, "INVALID_FRAME");
  await missing.closed;
  const one = await f.mobile(gatewayId);
  await desktop.next("open");
  const excess = await f.connect({ version: 1, type: "join", gatewayId });
  assert.equal((await excess.next("error")).code, "CHANNEL_LIMIT");
  await excess.closed;
  one.client.send({ type: "data", payload: "missing version" });
  assert.equal((await one.client.next("error")).code, "INVALID_FRAME");
  await one.client.closed;
  assert.equal((await desktop.next("close")).channelId, one.channelId);
  const active = await f.mobile(gatewayId);
  await desktop.next("open");
  desktop.socket.terminate();
  await Promise.all([desktop.closed, active.client.closed]);
  const offline = await f.connect({ version: 1, type: "join", gatewayId });
  assert.equal((await offline.next("error")).code, "HOST_OFFLINE");
  await offline.closed;
  const recovered = await f.host(gatewayId, hostToken),
    fresh = await f.mobile(gatewayId);
  assert.equal((await recovered.next("open")).channelId, fresh.channelId);
  fresh.client.send({ version: 1, type: "data", payload: "fresh-only" });
  assert.equal((await recovered.next("data")).payload, "fresh-only");
  assert.equal(
    recovered.messages.some((message) => message.type === "data"),
    false,
  );
});
