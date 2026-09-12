import assert from "node:assert/strict";
import { test } from "node:test";
import { AiSdkProvider } from "../../../src/provider/ai-sdk-provider.js";
import { toCanonicalUsage, type Usage } from "../../../src/schema/message.js";

const expectedUsage: Usage = {
  promptTokens: 100,
  completionTokens: 5,
  inputTokens: 40,
  cacheWriteTokens: 10,
  cacheReadTokens: 50,
  reportedFields: ["prompt", "input", "completion", "cacheWrite", "cacheRead"],
};

const expectedStreamUsage: Usage = {
  ...expectedUsage,
  reportedFields: ["prompt", "input", "cacheWrite", "cacheRead", "completion"],
};

const expectedCanonicalUsage = {
  inputTokens: 40,
  outputTokens: 5,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  reasoningTokens: 0,
  totalPromptTokens: 100,
  totalCompletionTokens: 5,
};

test("Claude keeps uncached input separate from prompt-cache usage", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body["stream"] === true) {
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"claude-fixture","content":[],"usage":{"output_tokens":0,"input_tokens":40,"cache_creation_input_tokens":10,"cache_read_input_tokens":50}}}',
          "",
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          "",
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
          "",
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
          "",
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
          "",
          'event: message_stop\ndata: {"type":"message_stop"}',
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-fixture",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 5,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 50,
      },
    });
  };

  const provider = new AiSdkProvider("claude", {
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "claude-test",
  });

  const response = await provider.generate([{ role: "user", content: "test" }], []);
  assert.deepEqual(
    { ...response.usage, reportedFields: new Set(response.usage?.reportedFields) },
    { ...expectedUsage, reportedFields: new Set(expectedUsage.reportedFields) },
  );
  assert.deepEqual(toCanonicalUsage(response.usage!), expectedCanonicalUsage);

  const deltas: string[] = [];
  const streamResponse = await provider.generateStream(
    [{ role: "user", content: "test" }],
    [],
    (delta) => deltas.push(delta),
  );
  assert.deepEqual(deltas, ["OK"]);
  assert.deepEqual(
    { ...streamResponse.usage, reportedFields: new Set(streamResponse.usage?.reportedFields) },
    { ...expectedStreamUsage, reportedFields: new Set(expectedStreamUsage.reportedFields) },
  );
  assert.deepEqual(toCanonicalUsage(streamResponse.usage!), expectedCanonicalUsage);
});
