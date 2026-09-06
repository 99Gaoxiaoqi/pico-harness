import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool } from "ai";
import { fromAiSdkContent, toAiSdkMessages } from "../../src/provider/ai-sdk-messages.js";
import type { Message } from "../../src/schema/message.js";

test("AI SDK clients round-trip signed thinking, Responses metadata, images and Pico tool chronology", async () => {
  const requests: Record<string, unknown>[] = [];
  const anthropic = createAnthropic({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content:
          requests.length === 1
            ? [
                { type: "thinking", thinking: "inspect first", signature: "authentic-signature" },
                { type: "redacted_thinking", data: "opaque-redacted" },
                { type: "text", text: "Checking." },
                { type: "tool_use", id: "call_one", name: "inspect", input: { path: "a.ts" } },
              ]
            : [{ type: "text", text: "Done." }],
        stop_reason: requests.length === 1 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    },
  });
  const history: Message[] = [
    {
      role: "user",
      content: "Inspect this",
      images: [{ type: "image_base64", mimeType: "image/png", data: "iVBORw0KGgo=" }],
    },
  ];
  const tools = {
    inspect: tool({
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
    }),
  };
  const first = await generateText({
    model: anthropic("claude-sonnet-4-5"),
    tools,
    messages: toAiSdkMessages(history, "claude"),
    maxRetries: 0,
  });
  const answer = fromAiSdkContent(first.content, "claude");
  assert.equal(answer.content, "Checking.");
  assert.equal(answer.reasoning, "inspect first");
  assert.deepEqual(answer.toolCalls, [
    { id: "call_one", name: "inspect", arguments: '{"path":"a.ts"}' },
  ]);
  history.push(JSON.parse(JSON.stringify(answer)), {
    role: "user",
    toolCallId: "call_one",
    content: "file contents",
  });
  const replay = toAiSdkMessages(history, "claude");
  assert.deepEqual(
    replay.map((message) => message.role),
    ["user", "assistant", "tool"],
  );
  await generateText({
    model: anthropic("claude-sonnet-4-5"),
    tools,
    messages: replay,
    maxRetries: 0,
  });
  const wireMessages = requests[1]!.messages as { role: string; content: unknown[] }[];
  assert.deepEqual(wireMessages[1]!.content, [
    { type: "thinking", thinking: "inspect first", signature: "authentic-signature" },
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "call_one", name: "inspect", input: { path: "a.ts" } },
  ]);
  assert.deepEqual(wireMessages[2]!.content, [
    { type: "tool_result", tool_use_id: "call_one", content: "file contents" },
  ]);
  assert.equal((wireMessages[0]!.content[0] as { type: string }).type, "image");
  const edited = toAiSdkMessages(
    [{ ...answer, content: "compressed", toolCalls: undefined, reasoning: undefined }],
    "claude",
  );
  assert.deepEqual(edited, [
    { role: "assistant", content: [{ type: "text", text: "compressed" }] },
  ]);
  const badArguments = fromAiSdkContent(
    [
      {
        type: "tool-call",
        toolCallId: "bad",
        toolName: "inspect",
        input: '{"path":',
        invalid: true,
      },
    ],
    "openai",
  );
  assert.equal(badArguments.toolCalls?.[0]?.arguments, '{"path":');
  assert.throws(
    () => toAiSdkMessages([{ role: "user", content: "orphan", toolCallId: "missing" }], "openai"),
    /no preceding call/,
  );

  const responsesRequests: Record<string, unknown>[] = [];
  const openai = createOpenAI({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      responsesRequests.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "resp_test",
        object: "response",
        created_at: 1,
        model: "gpt-5",
        status: "completed",
        output:
          responsesRequests.length === 1
            ? [
                {
                  type: "reasoning",
                  id: "rs_1",
                  summary: [{ type: "summary_text", text: "reasoning summary" }],
                  encrypted_content: "encrypted-state",
                },
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_response",
                  name: "inspect",
                  arguments: '{"path":"b.ts"}',
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: "msg_2",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Done.", annotations: [] }],
                },
              ],
        usage: {
          input_tokens: 5,
          output_tokens: 10,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 4 },
        },
      });
    },
  });
  const response = await generateText({
    model: openai.responses("gpt-5"),
    tools,
    messages: [{ role: "user", content: "Inspect" }],
    providerOptions: { openai: { store: false } },
    maxRetries: 0,
  });
  const responseMessage = fromAiSdkContent(response.content, "responses");
  assert.equal(responseMessage.reasoning, "reasoning summary");
  const savedResponse = toAiSdkMessages([responseMessage], "responses")[0]!;
  assert.ok(Array.isArray(savedResponse.content));
  const savedCall = savedResponse.content.find((part) => part.type === "tool-call");
  assert.equal(savedCall?.providerOptions?.openai?.itemId, "fc_1");
  const executed = fromAiSdkContent(
    [
      { type: "tool-call", toolCallId: "executed", toolName: "inspect", input: {} },
      { type: "tool-result", toolCallId: "executed", toolName: "inspect", output: { found: true } },
    ],
    "responses",
  );
  assert.equal(executed.toolCalls, undefined);
  assert.deepEqual(
    toAiSdkMessages([executed], "responses").map((message) => message.role),
    ["assistant", "tool"],
  );
  await generateText({
    model: openai.responses("gpt-5"),
    tools,
    providerOptions: { openai: { store: false } },
    maxRetries: 0,
    messages: toAiSdkMessages(
      [
        { role: "user", content: "Inspect" },
        JSON.parse(JSON.stringify(responseMessage)),
        { role: "user", toolCallId: "call_response", content: "observed" },
      ],
      "responses",
    ),
  });
  const input = responsesRequests[1]!.input as Record<string, unknown>[];
  assert.ok(
    input.some(
      (part) =>
        part.type === "reasoning" &&
        part.id === "rs_1" &&
        part.encrypted_content === "encrypted-state",
    ),
  );
  assert.ok(
    input.some((part) => part.type === "function_call" && part.call_id === "call_response"),
  );
  assert.ok(
    input.some(
      (part) =>
        part.type === "function_call_output" &&
        part.call_id === "call_response" &&
        part.output === "observed",
    ),
  );
});
