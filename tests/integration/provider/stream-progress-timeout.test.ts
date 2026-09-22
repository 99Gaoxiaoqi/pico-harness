import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  ModelCommunicationError,
  type ProviderPhysicalAttempt,
  type LLMProviderRequestOptions,
} from "@pico/core";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { generateWithRetry } from "@pico/runtime/provider-retry";

const messages = [{ role: "user" as const, content: "fixture" }];
const encoder = new TextEncoder();

// Exercise the real SDK parser while moving only the local deadline clock. Node's native
// AbortSignal.timeout uses internal timers, so route that standard API through the same clock.
function clockAndTransport(context: TestContext) {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  let stream: ReadableStreamDefaultController<Uint8Array>;
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    calls++;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          const abort = () => controller.error(init?.signal?.reason);
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return {
    get calls() {
      return calls;
    },
    event(value: unknown, type?: string) {
      stream.enqueue(
        encoder.encode(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`),
      );
    },
    heartbeat() {
      stream.enqueue(encoder.encode(": heartbeat\n\n"));
    },
    close() {
      stream.close();
    },
    async tick(ms: number) {
      context.mock.timers.tick(ms);
      await nextTurn();
    },
  };
}

function provider(wire: "openai" | "responses" | "claude") {
  return new AiSdkProvider(wire, {
    baseURL: "https://fixture.invalid/v1",
    apiKey: "test-key",
    model: "synthetic",
  });
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

const chatDelta = (delta: unknown) => ({ choices: [{ index: 0, delta, finish_reason: null }] });
const chatEnd = (tool = false) => ({
  choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
});

test("stream progress can exceed two minutes across all three protocols, including reasoning and tool inputs", async (context) => {
  const io = clockAndTransport(context);
  for (const wire of ["openai", "responses", "claude"] as const) {
    let text = "";
    const call = observe(
      provider(wire).generateStream(messages, [], (delta) => {
        text += delta;
      }),
    );
    await nextTurn();
    const delta = () => {
      if (wire === "openai") io.event(chatDelta({ content: "x" }));
      if (wire === "responses")
        io.event({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg",
          delta: "x",
        });
      if (wire === "claude")
        io.event(
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
          "content_block_delta",
        );
    };
    if (wire === "responses")
      io.event({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg", role: "assistant", status: "in_progress", content: [] },
      });
    if (wire === "claude") {
      io.event(
        {
          type: "message_start",
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            model: "synthetic",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        "message_start",
      );
      io.event(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        "content_block_start",
      );
    }
    delta();
    await nextTurn();
    await io.tick(90_000);
    delta();
    await nextTurn();
    await io.tick(90_000);
    assert.equal(call.settled, false, `${wire} must remain active after 180s with progress`);
    if (wire === "openai") io.event(chatEnd());
    if (wire === "responses") {
      const item = {
        type: "message",
        id: "msg",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "xx", annotations: [] }],
      };
      io.event({ type: "response.output_item.done", output_index: 0, item });
      io.event({
        type: "response.completed",
        response: {
          id: "resp",
          object: "response",
          created_at: 1,
          model: "synthetic",
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      });
    }
    if (wire === "claude") {
      io.event({ type: "content_block_stop", index: 0 }, "content_block_stop");
      io.event(
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        "message_delta",
      );
      io.event({ type: "message_stop" }, "message_stop");
    }
    io.close();
    assert.ok("value" in (await call.result), wire);
    assert.equal(text, "xx");
  }
  for (const kind of ["reasoning", "tool"] as const) {
    const call = observe(provider("openai").generateStream(messages, [], () => {}));
    await nextTurn();
    io.event(
      chatDelta(
        kind === "reasoning"
          ? { reasoning_content: "thinking" }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: "tool_1",
                  type: "function",
                  function: { name: "inspect", arguments: "{" },
                },
              ],
            },
      ),
    );
    await nextTurn();
    await io.tick(90_000);
    io.event(
      chatDelta(
        kind === "reasoning"
          ? { reasoning_content: " more" }
          : { tool_calls: [{ index: 0, function: { arguments: "}" } }] },
      ),
    );
    await nextTurn();
    await io.tick(90_000);
    assert.equal(call.settled, false, kind);
    io.event(chatEnd(kind === "tool"));
    io.close();
    assert.ok("value" in (await call.result), kind);
  }
});

test("silence and heartbeats cannot extend idle deadlines; non-stream calls retain absolute deadlines", async (context) => {
  const io = clockAndTransport(context);
  for (const mode of ["silent", "heartbeat", "non-stream"]) {
    const call = observe(
      mode === "non-stream"
        ? provider("openai").generate(messages, [])
        : provider("openai").generateStream(messages, [], () => {}),
    );
    await nextTurn();
    await io.tick(60_000);
    if (mode !== "silent") {
      io.heartbeat();
      await nextTurn();
    }
    await io.tick(60_000);
    const result = await call.result;
    assert.ok("error" in result && result.error instanceof Error);
    assert.equal(result.error.name, "TimeoutError");
  }
});

test("partial text, thinking and tool input timeouts never replay; explicit deadlines and cancellation stay absolute", async (context) => {
  const io = clockAndTransport(context);
  for (const kind of ["text", "reasoning", "tool", "explicit", "cancel"] as const) {
    const parent = new AbortController();
    const attempts: ProviderPhysicalAttempt[] = [];
    const options: LLMProviderRequestOptions = {
      signal: parent.signal,
      onProviderAttempt: (attempt) => {
        attempts.push(attempt);
      },
      ...(kind === "explicit" ? { timeoutMs: 120_000 } : {}),
    };
    const startCalls = io.calls;
    const source = provider("openai");
    const call = observe(
      generateWithRetry(
        {
          generate: (history, tools, request) =>
            source.generateStream(history, tools, () => {}, { ...request, ...options }),
        },
        messages,
        [],
        { signal: parent.signal },
      ),
    );
    await nextTurn();
    const delta =
      kind === "reasoning"
        ? { reasoning_content: "thinking" }
        : kind === "tool"
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call",
                  type: "function",
                  function: { name: "inspect", arguments: "{" },
                },
              ],
            }
          : { content: "partial" };
    io.event(chatDelta(delta));
    await nextTurn();
    await io.tick(90_000);
    if (kind === "explicit" || kind === "cancel") {
      io.event(chatDelta({ content: " progress" }));
      await nextTurn();
    }
    if (kind === "cancel") parent.abort(new DOMException("User cancelled", "AbortError"));
    else await io.tick(30_000);
    const result = await call.result;
    assert.ok("error" in result);
    if (kind === "cancel") assert.equal((result.error as Error).name, "AbortError");
    else {
      assert.ok(result.error instanceof ModelCommunicationError);
      assert.equal(result.error.category, "incomplete_stream");
    }
    assert.equal(io.calls - startCalls, 1, kind);
    await nextTurn();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, "cancelled");
    assert.equal(attempts[0]!.httpStatus, 200);
    assert.ok(attempts[0]!.timeToFirstTokenMs !== undefined);
    assert.equal(attempts[0]!.usageBasis, "missing");
  }
});
