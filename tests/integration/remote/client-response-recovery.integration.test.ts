import assert from "node:assert/strict";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import test, { type TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { REMOTE_MAX_FRAME_BYTES, type RemoteRequest } from "@pico/protocol/remote";
import {
  RemoteProtocolError,
  RemoteRuntimeClient,
} from "../../../packages/remote-client/src/index.js";
import { createTestTlsFixture } from "./tls-fixture.js";

const capability = {
  version: 1,
  gatewayId: "gateway-a",
  platform: "darwin",
  permissions: ["workspace.read", "terminal.control"],
  methods: ["session.list", "terminal.input"],
  features: {},
  maxFrameBytes: REMOTE_MAX_FRAME_BYTES,
};

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function fixture(t: TestContext) {
  const tls = await createTestTlsFixture();
  let capabilities: unknown = capability;
  let rpc = (request: RemoteRequest, response: ServerResponse) =>
    json(response, {
      requestId: request.requestId,
      ok: true,
      value: request.method === "session.list" ? { sessions: [] } : { accepted: true, sequence: 1 },
    });
  const requests: RemoteRequest[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer({ cert: tls.cert, key: tls.key }, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer device-token");
    if (request.url === "/v1/capabilities") return json(response, capabilities);
    assert.equal(request.url, "/v1/rpc");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RemoteRequest;
    requests.push(input);
    rpc(input, response);
  });
  server.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.authorization, "Bearer device-token");
    sockets.handleUpgrade(request, socket, head, (connection) =>
      connection.send(
        JSON.stringify({ type: "ready", version: 1, gatewayId: "gateway-a", connectionId: "a" }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const clients: RemoteRuntimeClient[] = [];
  t.after(async () => {
    clients.forEach((client) => client.close());
    sockets.clients.forEach((socket) => socket.terminate());
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tls.close();
  });
  return {
    requests,
    setCapabilities(value: unknown) {
      capabilities = value;
    },
    setRpc(handler: typeof rpc) {
      rpc = handler;
    },
    client() {
      const client = new RemoteRuntimeClient({
        publicUrl: `https://127.0.0.1:${address.port}`,
        gatewayId: "gateway-a",
        deviceToken: "device-token",
        fetch: tls.fetcher,
        createWebSocket: tls.createWebSocket,
      });
      clients.push(client);
      return client;
    },
  };
}

function errorIs(code: string, outcome?: "unknown" | "not_executed") {
  return (error: unknown) =>
    error instanceof RemoteProtocolError && error.code === code && error.outcome === outcome;
}

test("remote client connects to additive host capabilities and keeps its known request surface", async (t) => {
  const host = await fixture(t);
  host.setCapabilities({ ...capability, methods: [...capability.methods, "session.futureRead"] });
  const client = host.client();
  await client.connect();
  assert.deepEqual((await client.capabilities()).methods, capability.methods);
  assert.deepEqual(await client.request("session.list", {}, { workspaceId: "workspace-a" }), {
    sessions: [],
  });
  assert.equal(host.requests.length, 1);
});

test("remote capability compatibility retains version, identity, permission and frame validation", async (t) => {
  const host = await fixture(t);
  for (const [override, code] of [
    [{ methods: ["session.list", 42] }, "VERSION_MISMATCH"],
    [{ version: 2 }, "VERSION_MISMATCH"],
    [{ gatewayId: "another-host" }, "GATEWAY_MISMATCH"],
    [{ permissions: ["unreviewed.permission"] }, "VERSION_MISMATCH"],
    [{ maxFrameBytes: REMOTE_MAX_FRAME_BYTES + 1 }, "VERSION_MISMATCH"],
  ] as const) {
    host.setCapabilities({ ...capability, ...override });
    await assert.rejects(host.client().connect(), errorIs(code));
  }
  assert.equal(host.requests.length, 0);
});

const input = {
  sessionId: "session-a",
  terminalId: "terminal-a",
  resourceEpoch: "epoch-a",
  data: "echo delivery\n",
};

test("remote commands preserve confirmed results, explicit rejections and local preflight failures", async (t) => {
  const host = await fixture(t);
  const client = host.client();
  await client.connect();
  assert.deepEqual(await client.request("terminal.input", input, { workspaceId: "workspace-a" }), {
    accepted: true,
    sequence: 1,
  });
  host.setRpc((request, response) =>
    json(response, {
      requestId: request.requestId,
      ok: false,
      error: { code: "CONFLICT", message: "资源已变化", outcome: "not_executed" },
    }),
  );
  await assert.rejects(
    client.request("terminal.input", input, { workspaceId: "workspace-a" }),
    errorIs("CONFLICT", "not_executed"),
  );
  const before = host.requests.length;
  await assert.rejects(
    client.request(
      "session.send",
      { input: { kind: "text", text: "汉".repeat(350_000) }, idempotencyKey: "oversized-input" },
      { workspaceId: "workspace-a" },
    ),
    errorIs("FRAME_TOO_LARGE"),
  );
  assert.equal(host.requests.length, before, "an oversized request must never reach the host");
});

test("executed commands with unreadable replies remain unknown and are never automatically replayed", async (t) => {
  const host = await fixture(t);
  const client = host.client();
  await client.connect();
  let executed = 0;
  for (const [reply, code] of [
    [
      (_request: RemoteRequest, response: ServerResponse) => {
        response.writeHead(502, { "Content-Type": "text/html" });
        response.end("<html>proxy lost the upstream reply</html>");
      },
      "INVALID_RESPONSE",
    ],
    [
      (_request: RemoteRequest, response: ServerResponse) =>
        json(response, {
          requestId: "wrong-request",
          ok: true,
          value: { accepted: true, sequence: 1 },
        }),
      "INVALID_RESPONSE",
    ],
    [
      (request: RemoteRequest, response: ServerResponse) =>
        json(response, { requestId: request.requestId, ok: true, value: { accepted: "yes" } }),
      "INVALID_RESPONSE",
    ],
    [
      (request: RemoteRequest, response: ServerResponse) =>
        json(response, { requestId: request.requestId, ok: false, error: {} }),
      "INVALID_RESPONSE",
    ],
    [
      (_request: RemoteRequest, response: ServerResponse) => {
        response.writeHead(200, { "Content-Length": REMOTE_MAX_FRAME_BYTES + 1 });
        response.end(" ".repeat(REMOTE_MAX_FRAME_BYTES + 1));
      },
      "FRAME_TOO_LARGE",
    ],
  ] as const) {
    host.setRpc((request, response) => {
      executed++;
      reply(request, response);
    });
    await assert.rejects(
      client.request("terminal.input", input, { workspaceId: "workspace-a" }),
      errorIs(code, "unknown"),
    );
    assert.equal(
      host.requests.length,
      executed,
      "a bad reply must not resend the admitted command",
    );
  }
  host.setRpc((_request, response) => {
    response.end("<html>unreadable query reply</html>");
  });
  await assert.rejects(
    client.request("session.list", {}, { workspaceId: "workspace-a" }),
    errorIs("INVALID_RESPONSE"),
  );
  await client.capabilities();
  assert.equal(executed, 5, "later health checks do not replay any command");
});
