import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES } from "../../src/daemon/protocol.js";
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

test("mobile client accepts ToolResult Evidence v2 and rejects legacy v1", async () => {
  const contentHash = "a".repeat(64);
  const response = (schemaVersion: number) => ({
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
        id: "tool-1",
        kind: "tool",
        name: "read_file",
        args: "{}",
        status: "success",
        result: {
          version: 1,
          toolCallId: "call-1",
          toolName: "read_file",
          status: "succeeded",
          rawSizeBytes: 100_000,
          sha256: "b".repeat(64),
          deliveryTruncated: false,
          projection: {
            version: 1,
            mode: "preview",
            text: "bounded",
            strategy: "head-tail",
            truncated: true,
          },
          evidence: {
            uri: `pico://evidence/session-1/${contentHash}`,
            ref: {
              schemaVersion,
              contentHash,
              sessionId: "session-1",
              kind: "tool-exchange",
            },
          },
        },
      },
    ],
    revision: "revision-1",
  });
  const client = (schemaVersion: number) =>
    new MobileGatewayClient(
      { origin: "http://127.0.0.1:47831", token: "temporary-token" },
      async () => Response.json(response(schemaVersion)),
    );

  assert.equal((await client(2).getTranscript("opaque", "session-1")).items.length, 1);
  await assert.rejects(
    () => client(1).getTranscript("opaque", "session-1"),
    /会话条目响应格式无效/u,
  );
});

test("mobile client rejects malformed or overexposed ToolResult envelopes", async () => {
  const contentHash = "a".repeat(64);
  const validEnvelope = {
    version: 1,
    toolCallId: "call-1",
    toolName: "read_file",
    status: "succeeded",
    rawSizeBytes: 100_000,
    sha256: "b".repeat(64),
    deliveryTruncated: false,
    projection: {
      version: 1,
      mode: "preview",
      text: "bounded",
      strategy: "head-tail",
      truncated: true,
    },
    evidence: {
      uri: `pico://evidence/session-1/${contentHash}`,
      ref: {
        schemaVersion: 2,
        contentHash,
        sessionId: "session-1",
        kind: "tool-exchange",
      },
    },
  };
  const invalidEnvelopes = [
    { ...validEnvelope, rawOutput: "must not cross the mobile boundary" },
    { ...validEnvelope, body: { content: "must not cross the mobile boundary" } },
    {
      ...validEnvelope,
      projection: {
        ...validEnvelope.projection,
        rawOutput: "must not cross the mobile boundary",
      },
    },
    {
      ...validEnvelope,
      evidence: {
        ...validEnvelope.evidence,
        ref: {
          ...validEnvelope.evidence.ref,
          absolutePath: "/private/evidence/blob",
        },
      },
    },
    { ...validEnvelope, status: "legacy-success" },
    { ...validEnvelope, rawSizeBytes: -1 },
    { ...validEnvelope, sha256: "not-a-sha256" },
    {
      ...validEnvelope,
      projection: { ...validEnvelope.projection, mode: "legacy-preview" },
    },
    {
      ...validEnvelope,
      projection: { ...validEnvelope.projection, strategy: 42 },
    },
  ];
  const toolItem = {
    id: "tool-1",
    kind: "tool",
    name: "read_file",
    args: "{}",
    status: "success",
  };
  const invalidItems = [
    ...invalidEnvelopes.map((result) => ({ ...toolItem, result })),
    {
      ...toolItem,
      result: validEnvelope,
      rawOutput: "must not cross beside the canonical envelope",
    },
  ];

  const boundaryClient = new MobileGatewayClient(
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
            ...toolItem,
            result: {
              ...validEnvelope,
              projection: {
                ...validEnvelope.projection,
                text: "x".repeat(MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES),
              },
            },
          },
        ],
        revision: "revision-1",
      }),
  );
  assert.equal((await boundaryClient.getTranscript("opaque", "session-1")).items.length, 1);

  invalidItems.push(
    {
      ...toolItem,
      result: {
        ...validEnvelope,
        projection: {
          ...validEnvelope.projection,
          text: "x".repeat(MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES + 1),
        },
      },
    },
    {
      ...toolItem,
      result: {
        ...validEnvelope,
        projection: {
          ...validEnvelope.projection,
          text: "你".repeat(Math.floor(MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES / 3) + 1),
        },
      },
    },
  );

  for (const invalidItem of invalidItems) {
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
          items: [invalidItem],
          revision: "revision-1",
        }),
    );
    await assert.rejects(
      () => client.getTranscript("opaque", "session-1"),
      /会话条目响应格式无效/u,
    );
  }
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
