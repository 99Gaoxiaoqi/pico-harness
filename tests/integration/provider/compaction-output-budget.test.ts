import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createProvider } from "@pico/pico-host/provider/factory";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { FullCompactor } from "@pico/runtime/full-compactor";

test("bounded summary requests preserve route ceilings and report truncation on all protocol transports", async (context) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const wire = req.url!.split("/")[1];
    const output = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text: "partial", annotations: [] }],
      },
    ];
    const response = {
      id: "resp_1",
      object: "response",
      created_at: 1,
      model: "test",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output,
      usage: { input_tokens: 20, output_tokens: 10 },
    };
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          wire === "openai"
            ? {
                choices: [
                  { finish_reason: "length", message: { role: "assistant", content: "partial" } },
                ],
                usage: { prompt_tokens: 20, completion_tokens: 10 },
              }
            : wire === "claude"
              ? {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "test",
                  stop_reason: "max_tokens",
                  stop_sequence: null,
                  content: [{ type: "text", text: "partial" }],
                  usage: { input_tokens: 20, output_tokens: 10 },
                }
              : response,
        ),
      );
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const events =
      wire === "openai"
        ? [
            {
              choices: [
                { index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null },
              ],
            },
            {
              choices: [{ index: 0, delta: {}, finish_reason: "length" }],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            },
          ]
        : wire === "claude"
          ? [
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "test",
                  content: [],
                  usage: { input_tokens: 20, output_tokens: 0 },
                },
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "partial" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "max_tokens" },
                usage: { output_tokens: 10 },
              },
              { type: "message_stop" },
            ]
          : [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...output[0], content: [], status: "in_progress" },
              },
              {
                type: "response.output_text.delta",
                output_index: 0,
                content_index: 0,
                item_id: "msg_1",
                delta: "partial",
              },
              { type: "response.output_item.done", output_index: 0, item: output[0] },
              { type: "response.incomplete", response },
            ];
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  for (const wire of ["openai", "claude", "responses"] as const) {
    const provider = createProvider(wire, {
      model: wire === "claude" ? "glm-5.2" : "test",
      apiKey: "fixture",
      baseURL: `http://127.0.0.1:${address.port}/${wire}`,
      capabilities: resolveModelRouteCapabilities(wire, wire === "claude" ? "glm-5.2" : "test", {
        output: 64,
        streamUsage: true,
        outputTokenField: "max_completion_tokens",
      }),
    });
    for (const streaming of [false, true]) {
      for (const requested of [32, 128]) {
        const messages = [{ role: "user" as const, content: "Summarize" }];
        const result = streaming
          ? await provider.generateStream!(messages, [], () => {}, { maxOutputTokens: requested })
          : await provider.generate(messages, [], { maxOutputTokens: requested });
        assert.equal(result.content, "partial");
        assert.equal(result.providerData?.finishReason, "length");
        const body = requests.at(-1)!;
        const field =
          wire === "responses"
            ? "max_output_tokens"
            : wire === "openai"
              ? "max_completion_tokens"
              : "max_tokens";
        assert.equal(body[field], Math.min(requested, 64));
        if (wire !== "openai") assert.equal(body.max_completion_tokens, undefined);
        if (wire === "openai") assert.equal(body.max_tokens, undefined);
        if (wire === "claude") assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(body[wire === "responses" ? "max_tokens" : "max_output_tokens"], undefined);
      }
    }
    const count = requests.length;
    await assert.rejects(
      provider.generate([{ role: "user", content: "invalid" }], [], { maxOutputTokens: 0 }),
      /positive integer/,
    );
    assert.equal(requests.length, count);

    // The summary fits with its own 8k ceiling, but not the route's 16k default.
    const bounded = createProvider(wire, {
      model: wire === "claude" ? "glm-5.2" : "test",
      apiKey: "fixture",
      baseURL: `http://127.0.0.1:${address.port}/${wire}`,
      capabilities: resolveModelRouteCapabilities(wire, wire === "claude" ? "glm-5.2" : "test", {
        context: 20000,
        output: 16000,
        streamUsage: true,
        outputTokenField: "max_completion_tokens",
      }),
    });
    const source = [{ role: "user" as const, content: "word ".repeat(5000) }];
    const field =
      wire === "responses"
        ? "max_output_tokens"
        : wire === "claude"
          ? "max_tokens"
          : "max_completion_tokens";
    for (const streaming of [false, true]) {
      const generate = (messages = source, maxOutputTokens?: number) => {
        const options = maxOutputTokens === undefined ? undefined : { maxOutputTokens };
        return streaming
          ? bounded.generateStream!(messages, [], () => {}, options)
          : bounded.generate(messages, [], options);
      };
      const before = requests.length;
      await assert.rejects(generate(), /context/);
      await assert.rejects(generate(source, 32000), /context/);
      await assert.rejects(
        generate([{ role: "user", content: "word ".repeat(16000) }], 8000),
        /context/,
      );
      assert.equal(requests.length, before, "genuine overflow must stay local");
      assert.equal((await generate(source, 8000)).content, "partial");
      assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1)![field], 8000);
    }
    const beforeCompaction = requests.length;
    await new FullCompactor({ provider: bounded, maxAttempts: 1 }).preview(
      { id: `bounded-summary-${wire}` },
      [...source, { role: "assistant", content: "prior answer" }],
      { trigger: "manual", inputBudgetTokens: 2976, phase: "standalone" },
    );
    // The fixture deliberately returns length, so the compactor tries its bounded repair.
    assert.equal(requests.length, beforeCompaction + 2);
    for (const request of requests.slice(beforeCompaction)) assert.equal(request[field], 8000);
  }
});
