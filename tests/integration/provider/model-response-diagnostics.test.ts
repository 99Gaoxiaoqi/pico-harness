import { capturePhysicalAttempts } from "../../fixtures/native-accounting.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { ModelCommunicationError, type ModelCommunicationCategory } from "@pico/core";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { defaultIsRetryableError } from "@pico/runtime/provider-retry";
import type { PhysicalAttemptRecord } from "@pico/storage/runtime-control-types";

test("HTTP stream diagnostics distinguish failures through SDK and ledger without exposing remote data", async (context) => {
  const secret = "PRIVATE_RESPONSE_KEY_PROMPT_MUST_NOT_LEAK";
  let payload = "";
  let contentType = "text/event-stream";
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    calls++;
    res.writeHead(200, { "content-type": contentType, "x-request-id": secret });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = new AiSdkProvider("openai", {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    model: "synthetic",
    apiKey: secret,
  });
  const records: PhysicalAttemptRecord[] = [];
  const ledger = capturePhysicalAttempts(records);
  const tracked = new CostTracker(provider, "synthetic", undefined, { ledger });
  const messages = [{ role: "user" as const, content: secret }];
  const sse = (...events: unknown[]) =>
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const finish = { choices: [{ delta: {}, finish_reason: "stop" }] };
  payload = sse({ choices: [{ delta: { content: "OK" } }] }, finish) + "data: [DONE]\n\n";
  assert.equal((await tracked.generateStream(messages, [], () => {})).content, "OK");
  const cases: Array<{
    category: ModelCommunicationCategory;
    payload: string;
    streaming?: boolean;
    sdkError?: string;
  }> = [
    { category: "incomplete_stream", payload: sse({ choices: [{ delta: { content: secret } }] }) },
    {
      category: "rejected_completion",
      payload: sse({ choices: [{ delta: {}, finish_reason: "error" }] }),
    },
    {
      category: "invalid_response",
      payload: sse({ choices: [{ delta: { content: 123, extra: secret } }] }),
      sdkError: "TypeValidationError",
    },
    { category: "invalid_json", payload: `data: {${secret}\n\n`, sdkError: "JSONParseError" },
    { category: "invalid_json", payload: `{${secret}`, streaming: false, sdkError: "SyntaxError" },
    {
      category: "stream_error",
      payload: sse({ error: { message: secret, type: secret, code: secret } }),
      sdkError: "StreamProviderError",
    },
    {
      category: "invalid_tool_call",
      payload: sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { arguments: "{}" } },
              ],
            },
          },
        ],
      }),
      sdkError: "InvalidResponseDataError",
    },
  ];
  const ids = new Set<string>();
  for (const entry of cases) {
    payload = entry.payload;
    contentType = entry.streaming === false ? "application/json" : "text/event-stream";
    await assert.rejects(
      entry.streaming === false
        ? tracked.generate(messages, [])
        : tracked.generateStream(messages, [], () => {}),
      (error: unknown) => {
        assert.ok(error instanceof ModelCommunicationError);
        assert.equal(error.category, entry.category);
        assert.equal(error.diagnostic.sdkError, entry.sdkError);
        assert.equal(error.diagnostic.httpStatus, 200);
        assert.ok(error.diagnostic.durationMs >= 0);
        assert.ok(error.diagnostic.headersMs! >= 0);
        assert.match(error.diagnostic.diagnosticId, /^[0-9a-f-]{36}$/u);
        assert.ok(error.message.includes(error.diagnostic.diagnosticId));
        assert.equal(error.cause, undefined);
        assert.equal(defaultIsRetryableError(error), false);
        assert.equal(ids.has(error.diagnostic.diagnosticId), false);
        ids.add(error.diagnostic.diagnosticId);
        const record = records.at(-1)!;
        assert.ok(["failed", "interrupted"].includes(record.status));
        assert.equal(record.httpStatus, 200);
        assert.equal(record.usageBasis, "missing");
        assert.doesNotMatch(
          JSON.stringify(error) + error.message + JSON.stringify(records),
          new RegExp(secret),
        );
        return true;
      },
    );
  }
  assert.equal(calls, cases.length + 1);
});

test("SDK failures before HTTP response are not attributed to server stream errors", async (context) => {
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw Object.assign(new Error("PRIVATE_CONNECTION_DETAIL"), { code: "ECONNRESET" });
  };
  const provider = new AiSdkProvider("openai", {
    baseURL: "https://fixture.invalid/v1",
    model: "synthetic",
    apiKey: "PRIVATE_KEY",
  });
  await assert.rejects(
    provider.generateStream([{ role: "user", content: "synthetic" }], [], () => {}),
    (error: unknown) => {
      assert.ok(error instanceof ModelCommunicationError);
      assert.equal(error.category, "request_failed");
      assert.equal(error.diagnostic.httpStatus, undefined);
      assert.equal(error.diagnostic.transportCode, "ECONNRESET");
      assert.equal(defaultIsRetryableError(error), false);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_/u);
      return true;
    },
  );
});

test("providers without physical lifecycle cannot create accounting facts", async () => {
  const records: PhysicalAttemptRecord[] = [];
  const tracker = new CostTracker(
    {
      async generate() {
        throw Object.assign(new Error("PRIVATE_ERROR_MESSAGE"), {
          name: "PRIVATE_ERROR_NAME",
          statusCode: 12345,
        });
      },
    },
    "synthetic",
    undefined,
    { ledger: capturePhysicalAttempts(records) },
  );
  await assert.rejects(tracker.generate([{ role: "user", content: "synthetic" }], []));
  assert.deepEqual(records, []);
});
