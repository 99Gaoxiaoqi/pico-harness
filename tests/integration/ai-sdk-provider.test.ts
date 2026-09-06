import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProvider, type ProviderKind } from "../../src/provider/factory.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { ContextOverflowError, LLMStatusError } from "../../src/provider/errors.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import type { Message } from "../../src/schema/message.js";

const usage = {
  input_tokens: 8,
  output_tokens: 4,
  total_tokens: 12,
  input_tokens_details: { cached_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 1 },
};
function response(call: boolean, plaintext = false) {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-5",
    status: "completed",
    usage,
    output: call
      ? [
          {
            type: "reasoning",
            id: "rs_1",
            summary: plaintext ? [] : [{ type: "summary_text", text: "inspect" }],
            ...(plaintext
              ? { content: [{ type: "reasoning_text", text: "inspect" }] }
              : { encrypted_content: "opaque" }),
          },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "inspect",
            arguments: '{"path":"a.ts"}',
            status: "completed",
          },
        ]
      : [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          },
        ],
  };
}

// Exercise the real SDK transport and Pico's tool owner together. No external calls or keys.
test("SDK protocols run one tool through Pico's engine, preserve history and stream Responses", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-sdk-engine-"));
  const requests: { wire: string; body: Record<string, unknown>; auth?: string }[] = [];
  const server = createServer(async (req, res) => {
    let json = "";
    for await (const chunk of req) json += chunk;
    const body = JSON.parse(json);
    const wire = req.url!.split("/")[1]!;
    requests.push({ wire, body, auth: req.headers.authorization });
    const call = !JSON.stringify(body).includes("observed file");
    let payload: unknown;
    if (wire === "openai")
      payload = {
        choices: [
          {
            finish_reason: call ? "tool_calls" : "stop",
            message: {
              role: "assistant",
              content: call ? "" : "Done",
              ...(call
                ? {
                    reasoning_content: "inspect",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "inspect", arguments: '{"path":"a.ts"}' },
                      },
                    ],
                  }
                : {}),
            },
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      };
    else if (wire === "claude")
      payload = {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        stop_reason: call ? "tool_use" : "end_turn",
        stop_sequence: null,
        content: call
          ? [
              { type: "thinking", thinking: "inspect", signature: "signature" },
              { type: "tool_use", id: "call_1", name: "inspect", input: { path: "a.ts" } },
            ]
          : [{ type: "text", text: "Done" }],
        usage: {
          input_tokens: 5,
          output_tokens: 4,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
        },
      };
    else payload = response(call, wire === "deepseek");
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg_1",
          delta: "Done",
        },
        { type: "response.output_item.done", output_index: 0, item: response(false).output[0] },
        { type: "response.completed", response: response(false) },
      ];
      res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const fetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    fetch(
      String(url).startsWith("https://api.deepseek.com") ? `${base}/deepseek/responses` : url,
      init,
    );
  context.after(async () => {
    globalThis.fetch = fetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  for (const variant of ["openai", "claude", "responses", "deepseek"] as const) {
    const wire: ProviderKind = variant === "deepseek" ? "responses" : variant;
    const model = variant === "deepseek" ? "deepseek-v4-flash" : "test-model";
    const provider = createProvider(wire, {
      model,
      baseURL: variant === "deepseek" ? "https://api.deepseek.com" : `${base}/${wire}`,
      apiKey: "test-key",
      capabilities: resolveModelRouteCapabilities(wire, model, {
        output: 100,
        toolCall: true,
        streamUsage: true,
        cache: false,
      }),
    });
    const session = new Session(`sdk-${variant}`, root, { persistence: false });
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: () => "inspect",
      readOnly: true,
      definition: () => ({
        name: "inspect",
        description: "inspect file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }),
      execute: async () => {
        executions++;
        return "observed file";
      },
    });
    await session.commitMessages({ role: "user", content: "inspect" });
    const engine = new AgentEngine({
      provider: { generate: provider.generate.bind(provider) },
      registry,
      workDir: root,
      maxTurns: 3,
    });
    const history = await engine.run(session);
    assert.equal(executions, 1);
    assert.equal(history.at(-1)?.content, "Done");
    const sent = requests.filter((r) => r.wire === variant);
    assert.equal(sent.length, 2, "SDK must not own another model/tool step");
    assert.match(JSON.stringify(sent[1]!.body), /observed file/);
    if (wire === "claude") assert.match(JSON.stringify(sent[1]!.body), /signature/);
    else if (wire === "responses") {
      assert.equal(sent[0]!.body.store, false);
      assert.equal(sent[0]!.body.max_output_tokens, 100);
      assert.equal(sent[0]!.body.previous_response_id, undefined);
      assert.match(
        JSON.stringify(sent[1]!.body),
        variant === "deepseek" ? /reasoning_text/ : /opaque/,
      );
      if (variant === "deepseek") assert.deepEqual(sent[0]!.body.reasoning, { effort: "max" });
    }
    if (variant === "openai") {
      const answer = history.find((m) => m.role === "assistant" && m.toolCalls);
      assert.equal(answer?.usage?.cacheWriteTokens, 0);
      assert.ok(answer?.usage?.reportedFields?.includes("cacheWrite"));
    }
    if (variant === "responses") {
      const deltas: string[] = [];
      const streamed = await provider.generateStream!(
        [{ role: "user", content: "observed file" }],
        [],
        (text) => deltas.push(text),
      );
      assert.deepEqual(deltas, ["Done"]);
      assert.equal(streamed.usage?.cacheReadTokens, 2);
      assert.equal(streamed.usage?.reasoningTokens, 1);
    }
    await session.close();
  }
});

test("SDK failures preserve Pico retries, cancellation and invalid-tool ownership without exposing bodies", async (context) => {
  const fetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = fetch;
  });
  const provider = createProvider("openai", {
    baseURL: "https://fixture.invalid/v1",
    model: "fixture",
    apiKey: "secret",
  });
  const messages: Message[] = [{ role: "user", content: "synthetic" }];
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: { message: "secret echoed" } }, { status: 429 });
  };
  await assert.rejects(
    provider.generate(messages, []),
    (e) => e instanceof LLMStatusError && e.statusCode === 429 && !e.message.includes("secret"),
  );
  assert.equal(calls, 1);
  globalThis.fetch = async () =>
    Response.json(
      { error: { message: "maximum context length exceeded secret" } },
      { status: 400 },
    );
  await assert.rejects(provider.generate(messages, []), ContextOverflowError);
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "invalid", type: "function", function: { name: "unknown", arguments: "{bad" } },
            ],
          },
        },
      ],
    });
  const invalid = await provider.generate(messages, []);
  assert.deepEqual(invalid.toolCalls, [{ id: "invalid", name: "unknown", arguments: "{bad" }]);
  globalThis.fetch = async () =>
    new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  await assert.rejects(provider.generateStream!(messages, [], () => {}));
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed secret");
  };
  await assert.rejects(
    provider.generate(messages, []),
    (e) => e instanceof TypeError && !e.message.includes("secret"),
  );
  const abort = new AbortController();
  globalThis.fetch = async (_url, init) => {
    abort.abort();
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  };
  await assert.rejects(provider.generate(messages, [], { signal: abort.signal }), {
    name: "AbortError",
  });
});
