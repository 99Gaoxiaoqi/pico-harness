import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, tool } from "ai";
import { fromAiSdkContent, toAiSdkMessages } from "@pico/pico-host/provider/ai-sdk-messages";
import type { Message } from "@pico/core";
import { projectMediaTextForModel } from "@pico/core/media";
import { estimateMessagesTokens, MATERIALIZED_IMAGE_TOKENS } from "@pico/runtime/context-budget";

test("canonical native replay contributes history tokens once and invalidated replay falls back", () => {
  const query = { query: "查询内容".repeat(300) };
  const nativeResult = "搜索结果".repeat(400);
  const executedResult = { found: "local result".repeat(100) };
  const text = "Answer";
  const reasoning = "Thinking";
  const localInput = { path: "a.ts" };
  const image: Message = {
    role: "user",
    content: "",
    images: [{ type: "image_base64", mimeType: "image/png", data: "a".repeat(100000) }],
  };
  const chars =
    text.length +
    reasoning.length +
    "inspect".length +
    JSON.stringify(localInput).length +
    "web_search".length * 2 +
    JSON.stringify(query).length +
    nativeResult.length +
    "execute".length * 2 +
    2 +
    JSON.stringify(executedResult).length;
  const message = fromAiSdkContent(
    [
      { type: "text", text, providerMetadata: { signature: "opaque".repeat(10000) } },
      { type: "reasoning", text: reasoning },
      { type: "tool-call", toolCallId: "local", toolName: "inspect", input: localInput },
      {
        type: "tool-call",
        toolCallId: "native",
        toolName: "web_search",
        input: query,
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "native",
        toolName: "web_search",
        output: nativeResult,
        providerExecuted: true,
      },
      { type: "tool-call", toolCallId: "executed", toolName: "execute", input: {} },
      { type: "tool-result", toolCallId: "executed", toolName: "execute", output: executedResult },
    ],
    "claude",
  );
  const replay = toAiSdkMessages([image, message], "claude");
  assert.deepEqual(
    replay.map((item) => item.role),
    ["user", "assistant", "tool"],
  );
  assert.ok(JSON.stringify(replay).includes(nativeResult));
  assert.equal(
    estimateMessagesTokens([image, message], "claude"),
    Math.ceil(chars / 4) + MATERIALIZED_IMAGE_TOKENS,
  );
  const nativeOnly = fromAiSdkContent(
    [
      { type: "text", text },
      {
        type: "tool-call",
        toolCallId: "search",
        toolName: "web_search",
        input: query,
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "search",
        toolName: "web_search",
        output: nativeResult.repeat(100),
        providerExecuted: true,
      },
    ],
    "claude",
  );
  for (const protocol of ["openai", "responses"] as const) {
    assert.ok(!JSON.stringify(toAiSdkMessages([nativeOnly], protocol)).includes(nativeResult));
    assert.equal(estimateMessagesTokens([nativeOnly], protocol), Math.ceil(text.length / 4));
  }
  assert.equal(estimateMessagesTokens([nativeOnly]), Math.ceil(text.length / 4));
  message.content = "Edited";
  assert.ok(!JSON.stringify(toAiSdkMessages([message], "claude")).includes(nativeResult));
  assert.equal(
    estimateMessagesTokens([message], "claude"),
    Math.ceil((message.content.length + "inspect".length + JSON.stringify(localInput).length) / 4),
  );
  const action = { type: "search", query: query.query };
  const responses = fromAiSdkContent(
    [
      {
        type: "tool-call",
        toolCallId: "search",
        toolName: "web_search",
        input: {},
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "search",
        toolName: "web_search",
        output: nativeResult,
        providerExecuted: true,
      },
    ],
    "responses",
    [{ type: "web_search_call", id: "search", status: "completed", action }],
  );
  const anchored = toAiSdkMessages([responses], "responses", { responsesWebSearchAnchors: true });
  assert.ok(!JSON.stringify(anchored).includes(nativeResult));
  assert.equal(
    estimateMessagesTokens([responses], "responses"),
    Math.ceil(("web_search".length + JSON.stringify(action).length) / 4),
  );
});

test("history estimation matches SDK replay for media inside text, reasoning and tool JSON", async () => {
  const data = `data:image/png;base64,${"A".repeat(40000)}`;
  const input = { path: "image.html", content: `<img src="${data}">` };
  const text = `Answer ![image](${data})`;
  const reasoning = `Remember ${data}`;
  const output = { html: data };
  const message = fromAiSdkContent(
    [
      { type: "text", text },
      { type: "tool-call", toolCallId: "write", toolName: "write_file", input },
      { type: "tool-call", toolCallId: "executed", toolName: "inspect", input: {} },
      { type: "tool-result", toolCallId: "executed", toolName: "inspect", output },
    ],
    "responses",
  );
  const chars =
    projectMediaTextForModel(text).length +
    "write_file".length +
    JSON.stringify(input).length +
    "inspect".length * 2 +
    JSON.stringify({}).length +
    JSON.stringify(output).length;
  assert.equal(estimateMessagesTokens([message], "responses"), Math.ceil(chars / 4));
  const signed = fromAiSdkContent(
    [
      {
        type: "reasoning",
        text: reasoning,
        providerMetadata: { anthropic: { signature: "signed" } },
      },
    ],
    "claude",
  );
  assert.equal(estimateMessagesTokens([signed], "claude"), Math.ceil(reasoning.length / 4));
  assert.ok(JSON.stringify(toAiSdkMessages([signed], "claude")).includes(data));
  assert.equal(
    estimateMessagesTokens([{ ...signed, content: "Edited" }], "claude"),
    2,
    "Claude drops unsigned fallback reasoning",
  );
  let claudeRequest: Record<string, unknown> | undefined;
  const anthropic = createAnthropic({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      claudeRequest = JSON.parse(String(init?.body));
      return Response.json({
        id: "msg_media",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  await generateText({
    model: anthropic("claude-sonnet-4-5"),
    messages: toAiSdkMessages([{ role: "user", content: "Continue" }, signed], "claude"),
    maxRetries: 0,
  });
  const claudeMessages = claudeRequest!.messages as { content: Record<string, unknown>[] }[];
  assert.equal(
    claudeMessages[1]!.content[0]!.thinking,
    reasoning,
    "SDK sends signed reasoning without media projection",
  );
  let request: Record<string, unknown> | undefined;
  const openai = createOpenAI({
    apiKey: "test-key",
    fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return Response.json({
        id: "resp_media",
        object: "response",
        created_at: 1,
        model: "gpt-5",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done.", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    },
  });
  await generateText({
    model: openai.responses("gpt-5"),
    messages: toAiSdkMessages(
      [message, { role: "user", toolCallId: "write", content: "written" }],
      "responses",
    ),
    providerOptions: { openai: { store: false } },
    maxRetries: 0,
  });
  const wire = request!.input as Record<string, unknown>[];
  const call = wire.find((part) => part.type === "function_call" && part.name === "write_file")!;
  assert.equal(
    call.arguments,
    JSON.stringify(input),
    "SDK sends tool JSON without media projection",
  );
  assert.ok(JSON.stringify(wire).includes(data));
});

test("AI SDK clients round-trip signed thinking, Responses metadata, images and Pico tool chronology", async () => {
  const mediaReply =
    "Checking. ![图](data:image/png;base64,aGVsbG8=) [视频](data:video/mp4;base64,aGVsbG8=)";
  const projectedReply =
    "Checking. ![图]([image data omitted: image/png]) [视频]([video data omitted: video/mp4])";
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
                { type: "text", text: mediaReply },
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
  assert.equal(answer.content, mediaReply);
  const originalAnswer = structuredClone(answer);
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
    { type: "text", text: projectedReply },
    { type: "tool_use", id: "call_one", name: "inspect", input: { path: "a.ts" } },
  ]);
  assert.deepEqual(wireMessages[2]!.content, [
    { type: "tool_result", tool_use_id: "call_one", content: "file contents" },
  ]);
  assert.equal((wireMessages[0]!.content[0] as { type: string }).type, "image");
  assert.deepEqual(answer, originalAnswer, "signed replay is preserved in the source message");
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
