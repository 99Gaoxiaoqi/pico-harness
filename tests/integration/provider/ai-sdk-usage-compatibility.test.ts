import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderAttemptLifecycleSnapshot, Usage } from "@pico/core";
import { AiSdkProvider } from "../../../packages/pico-host/src/provider/ai-sdk-provider.js";

const messages = [{ role: "user" as const, content: "usage fixture" }];
const config = {
  baseURL: "https://provider.invalid/v1",
  apiKey: "fixture-key",
  model: "fixture-model",
};
const totals: Usage = {
  promptTokens: 13,
  completionTokens: 2,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  reportedFields: ["prompt", "completion"],
};
const detailed: Usage = {
  ...totals,
  inputTokens: 8,
  cacheReadTokens: 5,
  cacheWriteTokens: 0,
  reasoningTokens: 1,
  reportedFields: ["prompt", "completion", "cacheRead", "cacheWrite", "reasoning", "input"],
};

// Real SDK parsing and the Provider's accounting projection, with no external model call.
test("Provider normalizes usage versions, preserves missing fields and rejects intermediate output", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const fixtures: { name: string; raw: unknown; expected: Usage | undefined }[] = [
    {
      name: "SDK numeric totals and details",
      raw: {
        inputTokens: 13,
        outputTokens: 2,
        inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 5, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 1 },
      },
      expected: detailed,
    },
    {
      name: "complete SDK buckets recover absent totals",
      raw: {
        inputTokens: { noCache: 8, cacheRead: 5, cacheWrite: 0 },
        outputTokens: { text: 1, reasoning: 1 },
      },
      expected: detailed,
    },
    {
      name: "legacy camelCase cache and reasoning",
      raw: {
        promptTokens: 13,
        completionTokens: 2,
        cacheMissInputTokens: 8,
        cacheHitInputTokens: 5,
        cacheCreationInputTokens: 0,
        reasoningTokens: 1,
      },
      expected: detailed,
    },
    {
      name: "snake_case cache buckets recover input",
      raw: {
        completion_tokens: 2,
        prompt_cache_miss_tokens: 8,
        prompt_cache_hit_tokens: 5,
        cache_write_input_tokens: 0,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
      expected: detailed,
    },
    {
      name: "nested raw survives SDK normalization",
      raw: {
        raw: {
          prompt_tokens: 13,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
      expected: {
        ...detailed,
        inputTokens: undefined,
        reportedFields: ["prompt", "completion", "cacheRead", "cacheWrite", "reasoning"],
      },
    },
    {
      name: "total minus output",
      raw: { total_tokens: 15, completion_tokens: 2 },
      expected: totals,
    },
    { name: "total minus input", raw: { totalTokens: 15, promptTokens: 13 }, expected: totals },
    {
      name: "incomplete buckets never become totals",
      raw: {
        inputTokens: { noCache: 8, cacheRead: 5 },
        outputTokens: { text: 1 },
      },
      expected: {
        promptTokens: 0,
        completionTokens: 0,
        inputTokens: 8,
        cacheReadTokens: 5,
        reasoningTokens: 0,
        reportedFields: ["cacheRead", "input"],
      },
    },
    {
      name: "SDK synthetic zero does not report missing output or cache",
      raw: { prompt_tokens: 13 },
      expected: { ...totals, completionTokens: 0, reportedFields: ["prompt"] },
    },
    {
      name: "inconsistent total cannot recover negative output",
      raw: { prompt_tokens: 13, total_tokens: 1 },
      expected: { ...totals, completionTokens: 0, reportedFields: ["prompt"] },
    },
    {
      name: "explicit zero stays reported",
      raw: {
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
      expected: {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        reportedFields: ["prompt", "completion", "cacheRead", "reasoning"],
      },
    },
    {
      name: "negative, fractional, non-finite and unsafe counts are missing",
      raw: {
        promptTokens: -1,
        completionTokens: 1.5,
        totalTokens: 1,
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        cacheReadInputTokens: Infinity,
        cacheWriteInputTokens: -2,
      },
      expected: undefined,
    },
  ];
  for (const fixture of fixtures) {
    globalThis.fetch = async () =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }],
        usage: fixture.raw,
      });
    const response = await new AiSdkProvider("openai", config).generate(messages, []);
    // Omit optional undefined properties while comparing the public JSON shape.
    const expected = fixture.expected ? JSON.parse(JSON.stringify(fixture.expected)) : undefined;
    assert.deepEqual(response.usage, expected, fixture.name);
  }

  const claudeFixtures: {
    sdkTotal?: number;
    thinking?: number;
    iterations?: { type: string; input_tokens: number; output_tokens: number }[];
    input: number;
    output: number;
  }[] = [
    { input: 40, output: 5 },
    { sdkTotal: 100, input: 40, output: 5 },
    { thinking: 2, input: 40, output: 5 },
    {
      iterations: [
        { type: "compaction", input_tokens: 10, output_tokens: 2 },
        { type: "message", input_tokens: 40, output_tokens: 5 },
      ],
      input: 50,
      output: 7,
    },
    {
      iterations: [
        { type: "compaction", input_tokens: 10, output_tokens: 2 },
        { type: "fallback_message", input_tokens: 40, output_tokens: 5 },
      ],
      input: 40,
      output: 5,
    },
  ];
  for (const fixture of claudeFixtures) {
    globalThis.fetch = async () =>
      Response.json({
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "claude-fixture",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 40,
          inputTokens: fixture.sdkTotal,
          output_tokens: 5,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
          ...(fixture.thinking !== undefined
            ? { output_tokens_details: { thinking_tokens: fixture.thinking } }
            : {}),
          ...(fixture.iterations ? { iterations: fixture.iterations } : {}),
        },
      });
    const response = await new AiSdkProvider("claude", config).generate(messages, []);
    assert.deepEqual(response.usage, {
      promptTokens: fixture.input + 60,
      completionTokens: fixture.output,
      inputTokens: fixture.input,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      ...(fixture.thinking !== undefined ? { reasoningTokens: fixture.thinking } : {}),
      reportedFields: [
        "prompt",
        "completion",
        "cacheRead",
        "cacheWrite",
        ...(fixture.thinking !== undefined ? ["reasoning"] : []),
        "input",
      ],
    });
  }

  for (const finalUsage of [{ prompt_tokens: 13 }, { completion_tokens: 3 }]) {
    const facts: ProviderAttemptLifecycleSnapshot[] = [];
    globalThis.fetch = async () =>
      new Response(
        [
          {
            choices: [],
            usage: {
              prompt_tokens: 13,
              cacheMissInputTokens: 8,
              cacheHitInputTokens: 5,
              cacheWriteInputTokens: 0,
              completion_tokens: 2,
              total_tokens: 15,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
          },
          { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "error" }], usage: finalUsage },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    await assert.rejects(
      new AiSdkProvider("openai", config).generateStream(messages, [], () => {}, {
        onProviderAttemptUpdate: async (fact) => {
          facts.push(fact);
        },
      }),
    );
    for (let i = 0; i < 20 && !facts.at(-1)?.usage; i++) await delay(5);
    const final = facts.at(-1)!.usage!;
    assert.equal(final.promptTokens, 13);
    assert.equal(final.inputTokens, 8);
    assert.equal(final.cacheReadTokens, 5);
    assert.equal(final.completionTokens, "completion_tokens" in finalUsage ? 3 : 0);
    assert.deepEqual(
      final.reportedFields,
      "completion_tokens" in finalUsage
        ? ["prompt", "completion", "cacheRead", "cacheWrite", "input"]
        : ["prompt", "cacheRead", "cacheWrite", "input"],
    );
    assert.equal(final.reasoningTokens, 0, "terminal usage cannot inherit intermediate reasoning");
  }

  for (const cancel of [false, true]) {
    const facts: ProviderAttemptLifecycleSnapshot[] = [];
    const controller = new AbortController();
    globalThis.fetch = async () =>
      new Response(
        [
          {
            choices: [],
            usage: { inputTokens: 13, outputTokens: 2, totalTokens: 15, reasoningTokens: 1 },
          },
          { choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    await assert.rejects(
      new AiSdkProvider("openai", config).generateStream(
        messages,
        [],
        () => {
          if (cancel) controller.abort();
        },
        {
          signal: controller.signal,
          onProviderAttemptUpdate: async (fact) => {
            facts.push(fact);
          },
        },
      ),
    );
    for (let i = 0; i < 20 && !facts.at(-1)?.usage; i++) await delay(5);
    const terminal = facts.at(-1)!;
    assert.equal(terminal.status, cancel ? "cancelled" : "interrupted");
    assert.equal(terminal.usageBasis, "partial");
    assert.deepEqual(terminal.usage, {
      ...totals,
      completionTokens: 0,
      reportedFields: ["prompt"],
    });
  }
});
