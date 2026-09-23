import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { LLMStatusError, ModelCommunicationError } from "@pico/core";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { generateWithRetry, type RetryInfo } from "@pico/runtime/provider-retry";

const messages = [{ role: "user" as const, content: "fixture" }];
function setup(context: TestContext, failures: number) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    if (++calls <= failures) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("PRIVATE_TLS_DETAIL"), { code: "ECONNRESET" }),
      });
    }
    return new Response(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "synthetic",
        choices: [
          { index: 0, message: { role: "assistant", content: "Recovered" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return {
    provider: new AiSdkProvider("openai", {
      baseURL: "https://fixture.invalid/v1",
      apiKey: "test-key",
      model: "synthetic",
    }),
    get calls() {
      return calls;
    },
  };
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise
    .then(
      (value) => ({ value }),
      (error) => ({ error: error as unknown }),
    )
    .finally(() => {
      settled = true;
    });
  return {
    result,
    get settled() {
      return settled;
    },
  };
}
async function drive(context: TestContext, call: ReturnType<typeof observe>, retries: RetryInfo[]) {
  let advanced = 0;
  for (let turns = 0; turns < 40 && !call.settled; turns++) {
    await nextTurn();
    if (advanced < retries.length) context.mock.timers.tick(retries[advanced++]!.delayMs);
  }
  assert.equal(call.settled, true, "bounded retry must settle without real backoff waits");
}
function assertDelays(retries: RetryInfo[]) {
  retries.forEach((info, index) => {
    const base = Math.min(32_000, 1_000 * 2 ** index);
    assert.ok(
      info.delayMs >= base && info.delayMs <= base * 1.25,
      `attempt ${index + 1}: ${info.delayMs} must be within ${base}..${base * 1.25}`,
    );
    assert.equal(info.failedAttempt, index + 1);
    assert.equal(info.nextAttempt, index + 2);
    assert.equal(info.maxAttempts, 10);
  });
}

test("default network budget recovers after three consecutive pre-response TLS resets", async (context) => {
  const fixture = setup(context, 3);
  context.mock.method(Math, "random", () => 0);
  const retries: RetryInfo[] = [];
  const call = observe(
    generateWithRetry(fixture.provider, messages, [], {
      onRetry: (info) => {
        retries.push(info);
      },
    }),
  );
  await drive(context, call, retries);
  const result = await call.result;
  assert.ok("value" in result);
  assert.equal(result.value.content, "Recovered");
  assert.equal(fixture.calls, 4);
  assert.equal(retries.length, 3);
  assertDelays(retries);
  assert.equal(retries[0]!.delayMs, 1_000);
});

test("persistent transport failure exhausts exactly ten attempts with bounded positive jitter", async (context) => {
  const fixture = setup(context, Infinity);
  context.mock.method(Math, "random", () => 1 - Number.EPSILON);
  const retries: RetryInfo[] = [];
  const call = observe(
    generateWithRetry(fixture.provider, messages, [], {
      onRetry: (info) => {
        retries.push(info);
      },
    }),
  );
  await drive(context, call, retries);
  const result = await call.result;
  assert.ok("error" in result && result.error instanceof ModelCommunicationError);
  assert.equal(result.error.diagnostic.transportCode, "ECONNRESET");
  assert.doesNotMatch(JSON.stringify(result.error) + result.error.message, /PRIVATE_/u);
  assert.equal(fixture.calls, 10);
  assert.equal(retries.length, 9);
  assertDelays(retries);
  assert.equal(retries.at(-1)!.delayMs, 40_000, "jitter is applied after the 32s base cap");
});

test("user cancellation interrupts scheduled backoff without dispatching another request", async (context) => {
  const fixture = setup(context, Infinity);
  const abort = new AbortController();
  const retries: RetryInfo[] = [];
  const call = observe(
    generateWithRetry(fixture.provider, messages, [], {
      signal: abort.signal,
      onRetry: (info) => {
        retries.push(info);
      },
    }),
  );
  for (let turn = 0; turn < 20 && retries.length === 0; turn++) await nextTurn();
  assert.equal(retries.length, 1);
  assert.equal(fixture.calls, 1);
  assert.equal(call.settled, false);
  const reason = new DOMException("User cancelled", "AbortError");
  abort.abort(reason);
  await nextTurn();
  assert.equal(call.settled, true, "cancel must settle before the backoff timer advances");
  const result = await call.result;
  assert.ok("error" in result);
  assert.equal(result.error, reason);
  context.mock.timers.tick(400_000);
  await nextTurn();
  assert.equal(fixture.calls, 1);
});

test("a no-output incomplete stream recovers once and emits both retry phases", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(Math, "random", () => 0);
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    const events =
      calls === 1
        ? 'data: {"choices":[{"delta":{}}]}\n\n'
        : 'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(events, { headers: { "content-type": "text/event-stream" } });
  });
  const scheduled: RetryInfo[] = [];
  const started: RetryInfo[] = [];
  let output = "";
  const provider = new AiSdkProvider("openai", {
    baseURL: "https://fixture.invalid/v1",
    apiKey: "test-key",
    model: "synthetic",
  });
  const call = observe(
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
      {
        maxAttempts: 3,
        onRetry: (info) => scheduled.push(info),
        onRetryStarted: (info) => started.push(info),
      },
    ),
  );
  await drive(context, call, scheduled);
  const result = await call.result;
  assert.ok("value" in result);
  assert.equal(result.value.content, "Recovered");
  assert.equal(output, "Recovered");
  assert.equal(calls, 2);
  assert.deepEqual(
    scheduled.map(({ failedAttempt }) => failedAttempt),
    [1],
  );
  assert.deepEqual(
    started.map(({ nextAttempt }) => nextAttempt),
    [2],
  );
  assert.equal(scheduled[0]?.maxAttempts, 2);
});

test("Retry-After controls a retryable status delay without exposing the response", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const retries: RetryInfo[] = [];
  const call = observe(
    generateWithRetry(
      {
        async generate() {
          if (++calls === 1) throw new LLMStatusError(429, "response omitted", 2_500);
          return { role: "assistant", content: "Recovered" };
        },
      },
      messages,
      [],
      { maxAttempts: 2, onRetry: (info) => retries.push(info) },
    ),
  );
  await drive(context, call, retries);
  assert.ok("value" in (await call.result));
  assert.equal(calls, 2);
  assert.equal(retries[0]?.delayMs, 2_500);
});

test("a no-output incomplete stream spends only one recovery opportunity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const retries: RetryInfo[] = [];
  const failure = () =>
    new ModelCommunicationError("incomplete_stream", {
      diagnosticId: "fixture",
      durationMs: 1,
      httpStatus: 200,
      observableOutput: false,
    });
  const call = observe(
    generateWithRetry(
      {
        async generate() {
          calls++;
          throw failure();
        },
      },
      messages,
      [],
      { maxAttempts: 10, onRetry: (info) => retries.push(info) },
    ),
  );
  await drive(context, call, retries);
  const result = await call.result;
  assert.ok("error" in result && result.error instanceof ModelCommunicationError);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0]?.maxAttempts, 2);
});
