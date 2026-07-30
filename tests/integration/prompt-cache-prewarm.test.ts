import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider } from "../../src/provider/claude.js";
import type { ProviderConfig } from "../../src/provider/config.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import {
  PromptCachePrewarmCoordinator,
  withPromptCachePrewarm,
} from "../../src/provider/prompt-cache-prewarm.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const config = (): ProviderConfig => ({
  baseURL: "https://api.anthropic.com/v1",
  apiKey: "test-key",
  model: "claude-sonnet-4-6",
  capabilities: resolveModelRouteCapabilities("claude", "claude-sonnet-4-6", {
    cache: true,
    promptCache: { mode: "explicit", ttl: "5m", prewarm: true },
  }),
});

const messages = (question: string): Message[] => [
  { role: "system", content: "stable system" },
  { role: "user", content: question },
];

const tools = (description = "stable tool"): ToolDefinition[] => [
  {
    name: "lookup",
    description,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
];

test("Claude prewarm sends only stable prefix once per route revision", async () => {
  const calls: Array<{
    messages: Message[];
    tools: ToolDefinition[];
    options?: LLMProviderRequestOptions;
  }> = [];
  const provider: LLMProvider = {
    modelName: "claude-sonnet-4-6",
    requestCapabilities: { toolChoiceNoneWithTools: true },
    generate: async (requestMessages, requestTools, options) => {
      calls.push({ messages: requestMessages, tools: requestTools, options });
      return { role: "assistant", content: "ok" };
    },
  };
  const wrapped = withPromptCachePrewarm(
    "claude",
    provider,
    config(),
    new PromptCachePrewarmCoordinator(),
  );

  await wrapped.generate(messages("private first question"), tools());
  await wrapped.generate(messages("private second question"), tools());
  await wrapped.generate(messages("private third question"), tools("changed tool"));

  assert.equal(calls.length, 5);
  const firstPrewarm = calls[0];
  assert.deepEqual(firstPrewarm?.messages, [
    { role: "system", content: "stable system" },
    { role: "user", content: "." },
  ]);
  assert.equal(firstPrewarm?.options?.purpose, "prewarm");
  assert.equal(firstPrewarm?.options?.promptCachePrewarm, true);
  assert.equal(firstPrewarm?.options?.toolChoice, "none");
  assert.doesNotMatch(JSON.stringify(firstPrewarm), /private/u);
  assert.equal(calls[1]?.options?.promptCachePrewarm, undefined);
  assert.equal(calls[2]?.options?.promptCachePrewarm, undefined);
  assert.equal(calls[3]?.options?.promptCachePrewarm, true, "tool revision must prewarm again");
});

test("Claude prewarm failure is fail-open and is not retried for the same revision", async () => {
  let prewarmAttempts = 0;
  let actualCalls = 0;
  const provider: LLMProvider = {
    modelName: "claude-sonnet-4-6",
    requestCapabilities: { toolChoiceNoneWithTools: true },
    generate: async (_requestMessages, _requestTools, options) => {
      if (options?.promptCachePrewarm) {
        prewarmAttempts++;
        throw new Error("prewarm unavailable");
      }
      actualCalls++;
      return { role: "assistant", content: "ok" };
    },
  };
  const wrapped = withPromptCachePrewarm(
    "claude",
    provider,
    config(),
    new PromptCachePrewarmCoordinator(),
  );

  assert.equal((await wrapped.generate(messages("one"), tools())).content, "ok");
  assert.equal((await wrapped.generate(messages("two"), tools())).content, "ok");
  assert.equal(prewarmAttempts, 1);
  assert.equal(actualCalls, 2);
});

test("Claude prewarm wire body uses max_tokens zero and keeps cache breakpoints", async (context) => {
  const originalFetch = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      content: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 120,
        cache_read_input_tokens: 0,
      },
    });
  };
  const provider = new ClaudeProvider(config());
  const response = await provider.generate(
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "." },
    ],
    tools(),
    { promptCachePrewarm: true, purpose: "prewarm", toolChoice: "none" },
  );

  assert.equal(captured["max_tokens"], 0);
  assert.deepEqual(captured["tool_choice"], { type: "none" });
  assert.match(JSON.stringify(captured["system"]), /cache_control/u);
  assert.match(JSON.stringify(captured["tools"]), /cache_control/u);
  assert.doesNotMatch(JSON.stringify(captured["messages"]), /cache_control/u);
  assert.equal(response.usage?.cacheWriteTokens, 120);
});
