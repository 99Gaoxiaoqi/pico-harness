import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkProvider } from "../../../src/provider/ai-sdk-provider.js";
import type { Message, ToolDefinition } from "../../../src/schema/message.js";

const url = "https://example.com/news";
const local: ToolDefinition = {
  name: "inspect",
  description: "Inspect",
  inputSchema: { type: "object", properties: {} },
};
const messages: Message[] = [{ role: "user", content: "Search today's news and inspect locally" }];
const search = (wire: "responses" | "claude"): ToolDefinition => ({
  name: "web_search",
  description: "Search",
  inputSchema: { type: "object", properties: {} },
  providerTool: { kind: wire === "responses" ? "openai-web-search" : "anthropic-web-search" },
});
const searchItem = {
  type: "web_search_call",
  id: "ws_1",
  status: "completed",
  action: { type: "search", query: "today news", sources: [{ type: "url", url }] },
};
function payload(wire: "responses" | "claude", withSearch = true, error = false) {
  if (wire === "responses")
    return {
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "gpt-5",
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      output: [
        ...(withSearch
          ? [
              { ...searchItem, ...(error ? { status: "failed" } : {}) },
              {
                type: "function_call",
                id: "fc_1",
                call_id: "local_1",
                name: "inspect",
                arguments: "{}",
                status: "completed",
              },
            ]
          : []),
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "News",
              annotations: withSearch
                ? [
                    {
                      type: "url_citation",
                      url,
                      title: "News source",
                      start_index: 0,
                      end_index: 4,
                    },
                  ]
                : [],
            },
          ],
        },
      ],
    };
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      ...(withSearch
        ? [
            {
              type: "server_tool_use",
              id: "ws_1",
              name: "web_search",
              input: { query: "today news" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "ws_1",
              content: error
                ? { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" }
                : [
                    {
                      type: "web_search_result",
                      url,
                      title: "News source",
                      page_age: "today",
                      encrypted_content: "opaque-search-result",
                    },
                  ],
            },
            { type: "tool_use", id: "local_1", name: "inspect", input: {} },
          ]
        : []),
      {
        type: "text",
        text: "News",
        ...(withSearch && !error
          ? {
              citations: [
                {
                  type: "web_search_result_location",
                  url,
                  title: "News source",
                  cited_text: "News",
                  encrypted_index: "opaque-citation",
                },
              ],
            }
          : {}),
      },
    ],
  };
}
function streamResponse(wire: "responses" | "claude") {
  const full = payload(wire);
  const events: Record<string, unknown>[] = [];
  if (wire === "responses" && full.output) {
    for (const [output_index, item] of full.output.entries()) {
      events.push({
        type: "response.output_item.added",
        output_index,
        item: {
          ...item,
          status: "in_progress",
          ...(item.type === "message" ? { content: [] } : {}),
        },
      });
      if (item.type === "message")
        events.push({
          type: "response.output_text.delta",
          output_index,
          content_index: 0,
          item_id: item.id,
          delta: "News",
        });
      events.push({ type: "response.output_item.done", output_index, item });
    }
    events.push({ type: "response.completed", response: full });
  } else if (full.content) {
    events.push({ type: "message_start", message: { ...full, content: [], stop_reason: null } });
    for (const [index, content_block] of full.content.entries()) {
      const toolInput = "input" in content_block ? content_block.input : undefined;
      events.push({
        type: "content_block_start",
        index,
        content_block: { ...content_block, ...(toolInput ? { input: {} } : {}) },
      });
      if (toolInput)
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) },
        });
      events.push({ type: "content_block_stop", index });
    }
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    );
  }
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("native search runs inside both real SDK adapters, preserves mixed local calls, citations and ordered replay", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const wire of ["responses", "claude"] as const) {
    const requests: Record<string, unknown>[] = [];
    let includeSearch = true;
    let searchError = false;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return body.stream
        ? streamResponse(wire)
        : Response.json(payload(wire, includeSearch, searchError));
    };
    const provider = new AiSdkProvider(wire, {
      baseURL: "https://fixture.invalid",
      apiKey: "synthetic",
      model: wire === "responses" ? "gpt-5" : "claude-sonnet-4-5",
    });
    const tools = [local, search(wire)];
    const answer = await provider.generate(messages, tools);
    assert.deepEqual(answer.toolCalls, [{ id: "local_1", name: "inspect", arguments: "{}" }]);
    const data = answer.providerData?.picoWebSearch as {
      calls: { status: string }[];
      sources: { url: string; title?: string }[];
    };
    assert.equal(data.calls[0]?.status, "completed");
    assert.ok(data.sources.some((source) => source.url === url && source.title === "News source"));
    assert.match(
      JSON.stringify(requests[0]!.tools),
      wire === "responses" ? /"type":"web_search"/ : /web_search_20250305/,
    );
    assert.match(JSON.stringify(requests[0]!.tools), /inspect/);
    includeSearch = false;
    await provider.generate(
      [
        ...messages,
        JSON.parse(JSON.stringify(answer)),
        { role: "user", toolCallId: "local_1", content: "inspected" },
      ],
      tools,
    );
    if (wire === "responses") {
      const input = requests[1]!.input as Record<string, unknown>[];
      const index = input.findIndex((item) => item.type === "web_search_call");
      assert.deepEqual(input[index], searchItem);
      assert.equal(input[index + 1]?.type, "function_call");
      assert.equal(requests[1]!.store, false);
    } else {
      assert.match(JSON.stringify(requests[1]!.messages), /opaque-search-result/);
      assert.match(JSON.stringify(requests[1]!.messages), /opaque-citation/);
      assert.match(JSON.stringify(requests[1]!.messages), /server_tool_use/);
    }
    await provider.generate(messages, tools, { toolChoice: "none" });
    const disabled = requests.at(-1)!;
    assert.ok(
      disabled.tool_choice === "none" ||
        !JSON.stringify(disabled.tools ?? []).includes("web_search") ||
        (disabled.tool_choice as { type?: string })?.type === "none",
    );
    await provider.generate(messages, [local]);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)!.tools), /web_search/);
    includeSearch = true;
    const streamed = await provider.generateStream(messages, tools, () => {});
    assert.equal(
      (streamed.providerData?.picoWebSearch as typeof data).calls[0]?.status,
      "completed",
    );
    assert.deepEqual(streamed.toolCalls, answer.toolCalls);
    includeSearch = false;
    await provider.generate(
      [
        ...messages,
        JSON.parse(JSON.stringify(streamed)),
        { role: "user", toolCallId: "local_1", content: "inspected" },
      ],
      tools,
    );
    assert.match(
      JSON.stringify(requests.at(-1)),
      wire === "responses" ? /web_search_call/ : /opaque-search-result/,
    );
    {
      includeSearch = true;
      searchError = true;
      const failed = await provider.generate(messages, tools);
      assert.equal((failed.providerData?.picoWebSearch as typeof data).calls[0]?.status, "error");
      includeSearch = false;
      await provider.generate(
        [...messages, failed, { role: "user", toolCallId: "local_1", content: "inspected" }],
        tools,
      );
      assert.match(
        JSON.stringify(requests.at(-1)),
        wire === "claude" ? /max_uses_exceeded/ : /"status":"failed"/,
      );
    }
  }
});

test("native search descriptor fails clearly before dispatch on wrong protocol and official DeepSeek", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("must not dispatch");
  };
  for (const [wire, baseURL, descriptor] of [
    ["openai", "https://fixture.invalid", search("responses")],
    ["responses", "https://fixture.invalid", search("claude")],
    ["responses", "https://api.deepseek.com", search("responses")],
  ] as const) {
    await assert.rejects(
      new AiSdkProvider(wire, { baseURL, apiKey: "synthetic", model: "fixture" }).generate(
        messages,
        [descriptor],
      ),
      /协议不匹配|DeepSeek.*不支持/,
    );
  }
  assert.equal(requests, 0);
});
