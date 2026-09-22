import { capturePhysicalAttempts } from "../../fixtures/native-accounting.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { ModelCommunicationError, type ModelCommunicationCategory } from "@pico/core";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { defaultIsRetryableError, generateWithRetry } from "@pico/runtime/provider-retry";
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

test("SDK unwraps fetch failures without losing safe transport retry classification", async (context) => {
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("PRIVATE_CONNECTION_DETAIL"), { code: "ECONNRESET" }),
    });
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
      assert.equal(error.diagnostic.sdkError, "APICallError");
      assert.equal(defaultIsRetryableError(error), true);
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

test("safe pre-response transport failures recover within the existing attempt budget", async (context) => {
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  const secret = "PRIVATE_NETWORK_CAUSE_AND_REQUEST";
  const messages = [{ role: "user" as const, content: secret }];
  const records: PhysicalAttemptRecord[] = [];
  const provider = new CostTracker(
    new AiSdkProvider("openai", {
      baseURL: "https://fixture.invalid/v1",
      model: "synthetic",
      apiKey: secret,
    }),
    "synthetic",
    undefined,
    { ledger: capturePhysicalAttempts(records) },
  );
  const success = () =>
    new Response(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [
          { index: 0, message: { role: "assistant", content: "Recovered" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  for (const code of [
    "ECONNRESET",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(secret), { code }),
        });
      return success();
    };
    assert.equal(
      (await generateWithRetry(provider, messages, [], { maxAttempts: 2 })).content,
      "Recovered",
    );
    assert.equal(calls, 2, code);
    assert.deepEqual(
      records.slice(-2).map((record) => record.status),
      ["failed", "succeeded"],
    );
    assert.deepEqual(
      records.slice(-2).map((record) => record.retryAttempt),
      [0, 1],
    );
    assert.equal(records.at(-1)!.logicalCallId, records.at(-2)!.logicalCallId);
  }
  let exhaustedCalls = 0;
  globalThis.fetch = async () => {
    exhaustedCalls++;
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error(secret), { code: "ECONNRESET" }),
    });
  };
  await assert.rejects(
    generateWithRetry(provider, messages, [], { maxAttempts: 3 }),
    ModelCommunicationError,
  );
  assert.equal(exhaustedCalls, 3);
  assert.deepEqual(
    records.slice(-3).map((record) => record.retryAttempt),
    [0, 1, 2],
  );
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_/u);
});

test("unknown, permanent, cancelled and post-response failures cannot enter transport retry", async (context) => {
  const original = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  const provider = new AiSdkProvider("openai", {
    baseURL: "https://fixture.invalid/v1",
    model: "synthetic",
    apiKey: "PRIVATE_KEY",
  });
  const messages = [{ role: "user" as const, content: "synthetic" }];
  for (const code of [
    "ECONNREFUSED",
    "ENOTFOUND",
    "UND_ERR_BODY_TIMEOUT",
    "PRIVATE_UNKNOWN_CODE",
    undefined,
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (code === undefined) throw new TypeError("PRIVATE_UNKNOWN_FETCH_FAILURE");
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_CAUSE"), { code }),
      });
    };
    await assert.rejects(generateWithRetry(provider, messages, []), (error: unknown) => {
      assert.ok(error instanceof ModelCommunicationError);
      assert.equal(defaultIsRetryableError(error), false);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_/u);
      return true;
    });
    assert.equal(calls, 1, String(code));
  }
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"visible"}}]}\n\n'),
          );
          setTimeout(
            () =>
              controller.error(
                new TypeError("fetch failed", {
                  cause: Object.assign(new Error("PRIVATE_STREAM_CAUSE"), { code: "ECONNRESET" }),
                }),
              ),
            10,
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  let output = "";
  await assert.rejects(
    generateWithRetry(
      {
        generate: (history, tools, options) =>
          provider.generateStream(
            history,
            tools,
            (delta) => {
              output += delta;
            },
            options,
          ),
      },
      messages,
      [],
    ),
    (error: unknown) => {
      assert.ok(error instanceof ModelCommunicationError);
      assert.equal(error.diagnostic.httpStatus, 200);
      assert.equal(error.diagnostic.transportCode, "ECONNRESET");
      assert.equal(defaultIsRetryableError(error), false);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_/u);
      return true;
    },
  );
  assert.equal(output, "visible");
  assert.equal(calls, 1);
  // Locally classified SDK failures cannot gain retries merely by carrying a transport code.
  for (const diagnostic of [{ httpStatus: 200 }, { headersMs: 1 }]) {
    assert.equal(
      defaultIsRetryableError(
        new ModelCommunicationError("request_failed", {
          diagnosticId: "fixture",
          durationMs: 1,
          transportCode: "ECONNRESET",
          ...diagnostic,
        }),
      ),
      false,
    );
  }
  const abort = new AbortController();
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    abort.abort();
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("PRIVATE_CAUSE"), { code: "ECONNRESET" }),
    });
  };
  await assert.rejects(generateWithRetry(provider, messages, [], { signal: abort.signal }), {
    name: "AbortError",
  });
  assert.equal(calls, 1);
});
