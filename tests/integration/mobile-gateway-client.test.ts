import assert from "node:assert/strict";
import test from "node:test";
import {
  MobileGatewayClient,
  normalizeGatewayOrigin,
} from "../../apps/mobile/src/lib/mobile-gateway-client.js";

test("mobile client only allows simulator loopback origins", () => {
  assert.equal(normalizeGatewayOrigin("http://127.0.0.1:47831"), "http://127.0.0.1:47831");
  assert.equal(normalizeGatewayOrigin("http://10.0.2.2:47831"), "http://10.0.2.2:47831");
  assert.throws(() => normalizeGatewayOrigin("http://192.168.1.12:47831"), /仅支持本机模拟器/);
  assert.throws(() => normalizeGatewayOrigin("https://example.com"), /仅支持本机模拟器/);
});

test("mobile client authenticates project reads and validates the response", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = new MobileGatewayClient(
    { origin: "http://127.0.0.1:47831", token: "temporary-token" },
    async (input, init) => {
      calls.push({ input: String(input), ...(init ? { init } : {}) });
      return Response.json({ projects: [{ projectId: "opaque", name: "pico-harness" }] });
    },
  );

  assert.deepEqual(await client.listProjects(), [{ projectId: "opaque", name: "pico-harness" }]);
  assert.equal(calls[0]?.input, "http://127.0.0.1:47831/v1/projects");
  assert.deepEqual(calls[0]?.init?.headers, { Authorization: "Bearer temporary-token" });
  assert.equal(calls[0]?.init?.redirect, "error");
});

test("mobile client does not include the token in authorization errors", async () => {
  const client = new MobileGatewayClient(
    { origin: "http://127.0.0.1:47831", token: "do-not-leak" },
    async () => new Response("unauthorized", { status: 401 }),
  );
  await assert.rejects(
    () => client.listProjects(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /do-not-leak/);
      assert.match(error.message, /Token 无效/);
      return true;
    },
  );
});

test("mobile client reads project sessions without accepting workspace paths", async () => {
  const client = new MobileGatewayClient(
    { origin: "http://127.0.0.1:47831", token: "temporary-token" },
    async (input) => {
      assert.equal(String(input), "http://127.0.0.1:47831/v1/projects/opaque/sessions");
      return Response.json({
        sessions: [
          {
            sessionId: "session-1",
            title: "Mobile foundation",
            status: "active",
            pinned: false,
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      });
    },
  );

  assert.deepEqual(await client.listSessions("opaque"), [
    {
      sessionId: "session-1",
      title: "Mobile foundation",
      status: "active",
      pinned: false,
      createdAt: 10,
      updatedAt: 20,
    },
  ]);
});

test("mobile client reads a sanitized session transcript", async () => {
  const client = new MobileGatewayClient(
    { origin: "http://127.0.0.1:47831", token: "temporary-token" },
    async (input) => {
      assert.equal(
        String(input),
        "http://127.0.0.1:47831/v1/projects/opaque/sessions/session-1/transcript",
      );
      return Response.json({
        session: {
          sessionId: "session-1",
          title: "Mobile foundation",
          status: "active",
          pinned: false,
          createdAt: 10,
          updatedAt: 20,
        },
        items: [
          { id: "user-1", kind: "userMessage", content: "Continue" },
          { id: "assistant-1", kind: "assistantMessage", content: "Done" },
        ],
        revision: "revision-1",
      });
    },
  );

  const transcript = await client.getTranscript("opaque", "session-1");
  assert.deepEqual(transcript.items, [
    { id: "user-1", kind: "userMessage", content: "Continue" },
    { id: "assistant-1", kind: "assistantMessage", content: "Done" },
  ]);
  assert.equal(transcript.revision, "revision-1");
});

test("mobile client rejects private Runtime fields in transcript items", async () => {
  const client = new MobileGatewayClient(
    { origin: "http://127.0.0.1:47831", token: "temporary-token" },
    async () =>
      Response.json({
        session: {
          sessionId: "session-1",
          title: "Mobile foundation",
          status: "active",
          pinned: false,
          createdAt: 10,
          updatedAt: 20,
        },
        items: [
          {
            id: "goal-1",
            kind: "goal",
            title: "Ship",
            data: { workspacePath: "/private/workspace" },
          },
        ],
        revision: "revision-1",
      }),
  );

  await assert.rejects(() => client.getTranscript("opaque", "session-1"), /会话条目响应格式无效/);
});

test("mobile client posts one idempotent text message", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const client = new MobileGatewayClient(
    { origin: "http://127.0.0.1:47831", token: "temporary-token" },
    async (input, init) => {
      calls.push({ input: String(input), ...(init ? { init } : {}) });
      return Response.json({
        session: {
          sessionId: "session-1",
          title: "Mobile foundation",
          status: "active",
          pinned: false,
          createdAt: 10,
          updatedAt: 20,
        },
        run: {
          runId: "run-1",
          sessionId: "session-1",
          description: "Continue",
          status: "running",
          startedAt: 21,
          updatedAt: 22,
        },
        disposition: "started",
      });
    },
  );

  const result = await client.sendMessage("opaque", {
    sessionId: "session-1",
    text: "Continue",
    idempotencyKey: "mobile-message-1",
  });

  assert.equal(result.run?.runId, "run-1");
  assert.equal(result.disposition, "started");
  assert.equal(calls[0]?.input, "http://127.0.0.1:47831/v1/projects/opaque/messages");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(calls[0]?.init?.headers, {
    Authorization: "Bearer temporary-token",
    "Content-Type": "application/json",
  });
  assert.equal(
    calls[0]?.init?.body,
    JSON.stringify({
      sessionId: "session-1",
      text: "Continue",
      idempotencyKey: "mobile-message-1",
    }),
  );
});
