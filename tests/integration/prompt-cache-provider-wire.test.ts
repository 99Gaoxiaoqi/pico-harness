import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider } from "../../src/provider/claude.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { promptCacheRevisions, snapshotToolDefinitions } from "../../src/provider/prompt-cache.js";
import { generateWithRetry } from "../../src/provider/retry.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const messages = (question: string): Message[] => [
  { role: "system", content: "stable system rule" },
  { role: "user", content: question },
];

const tools: ToolDefinition[] = [
  {
    name: "zeta",
    description: "zeta tool",
    inputSchema: {
      required: ["alpha"],
      properties: { zulu: { type: "string" }, alpha: { type: "string" } },
      type: "object",
    },
  },
  {
    name: "alpha",
    description: "alpha tool",
    inputSchema: { properties: { value: { type: "string" } }, type: "object" },
  },
];

test("OpenAI explicit cache key is stable, private, and route-scoped", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 30 },
      },
    });
  };

  const explicit = resolveModelRouteCapabilities("openai", "gpt-test", {
    cache: true,
    promptCache: { mode: "explicit", ttl: "30m", keyShards: 4 },
  });
  const provider = new OpenAIProvider({
    baseURL: "https://api.openai.com/v1",
    apiKey: "never-in-cache-key",
    model: "gpt-test",
    capabilities: explicit,
  });
  const first = await provider.generate(messages("private first question"), tools);
  await provider.generate(messages("private second question"), tools);

  assert.equal(first.usage?.cacheWriteTokens, 30);
  assert.deepEqual(first.usage?.reportedFields, [
    "prompt",
    "completion",
    "cacheRead",
    "cacheWrite",
  ]);
  assert.equal(bodies.length, 2);
  const firstKey = bodies[0]?.["prompt_cache_key"];
  assert.equal(typeof firstKey, "string");
  assert.equal(bodies[1]?.["prompt_cache_key"], firstKey, "user text must not perturb the key");
  assert.equal(bodies[0]?.["prompt_cache_retention"], "30m");
  assert.doesNotMatch(firstKey as string, /private|never-in-cache-key/u);
  assert.deepEqual(
    (bodies[0]?.["tools"] as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    ),
    ["alpha", "zeta"],
  );

  const compatible = new OpenAIProvider({
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    model: "gpt-test",
    capabilities: explicit,
  });
  await compatible.generate(messages("same stable prefix"), tools);
  const compatibleBody = bodies.at(-1) ?? {};
  assert.equal(typeof compatibleBody["prompt_cache_key"], "string");
  assert.notEqual(
    compatibleBody["prompt_cache_key"],
    firstKey,
    "switching base URL must create a new route cache identity",
  );
});

test("OpenAI compatible route rejects active fields once and then stays implicit", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (Object.hasOwn(body, "prompt_cache_key")) {
      return Response.json(
        { error: { message: "unknown parameter prompt_cache_key" } },
        { status: 400 },
      );
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 2 },
    });
  };

  const capabilities = resolveModelRouteCapabilities("openai", "gpt-test", {
    cache: true,
    promptCache: { mode: "explicit", ttl: "30m" },
  });
  const provider = new OpenAIProvider({
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    model: "gpt-test",
    capabilities,
  });
  await provider.generate(messages("first"), tools);
  await provider.generate(messages("second"), tools);

  assert.equal(bodies.length, 3);
  assert.equal(Object.hasOwn(bodies[0] ?? {}, "prompt_cache_key"), true);
  assert.equal(Object.hasOwn(bodies[1] ?? {}, "prompt_cache_key"), false);
  assert.equal(Object.hasOwn(bodies[2] ?? {}, "prompt_cache_key"), false);
  assert.equal(Object.hasOwn(bodies[1] ?? {}, "prompt_cache_retention"), false);
});

test("OpenAI key shards use an opaque stable conversation seed", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 2 },
    });
  };

  const provider = new OpenAIProvider({
    baseURL: "https://api.openai.com/v1",
    apiKey: "test-key",
    model: "gpt-test",
    capabilities: resolveModelRouteCapabilities("openai", "gpt-test", {
      cache: true,
      promptCache: { mode: "explicit", keyShards: 1024 },
    }),
  });
  await provider.generate(messages("same question"), tools, {
    promptCacheShardSeed: "opaque-seed-a",
  });
  await provider.generate(messages("same question"), tools, {
    promptCacheShardSeed: "opaque-seed-b",
  });
  await provider.generate(messages("same question"), tools, {
    promptCacheShardSeed: "opaque-seed-a",
  });

  const keys = bodies.map((body) => String(body["prompt_cache_key"]));
  assert.equal(keys[0], keys[2], "the same conversation must not drift between shards");
  assert.notEqual(keys[0], keys[1], "different conversations should distribute when sharding");
  assert.ok(keys.every((key) => key.length <= 64));
  assert.ok(keys.every((key) => !key.includes("opaque-seed")));
});

test("cache shard identity survives ordinary retry and credential rotation", async () => {
  const seen: Array<string | undefined> = [];
  const succeeding: LLMProvider = {
    modelName: "gpt-test",
    generate: async (_messages, _tools, options?: LLMProviderRequestOptions) => {
      seen.push(options?.promptCacheShardSeed);
      return { role: "assistant", content: "ok" };
    },
  };
  const limited: LLMProvider = {
    modelName: "gpt-test",
    generate: async (_messages, _tools, options?: LLMProviderRequestOptions) => {
      seen.push(options?.promptCacheShardSeed);
      throw new LLMStatusError(429, "rate limited");
    },
  };

  await generateWithRetry(limited, messages("question"), tools, {
    maxAttempts: 2,
    promptCacheShardSeed: "opaque-stable-seed",
    onRateLimited: () => succeeding,
  });

  assert.deepEqual(seen, ["opaque-stable-seed", "opaque-stable-seed"]);
});

test("OpenAI stream reports cache writes only when the provider sends the field", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      [
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":70,"cache_write_tokens":40}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const response = await new OpenAIProvider({
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
  }).generateStream([{ role: "user", content: "question" }], [], () => undefined);

  assert.equal(response.usage?.cacheReadTokens, 70);
  assert.equal(response.usage?.cacheWriteTokens, 40);
  assert.deepEqual(response.usage?.reportedFields, [
    "prompt",
    "completion",
    "cacheRead",
    "cacheWrite",
  ]);
});

test("Claude applies 1h only to stable prefix and omits cache controls on unknown gateways", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  };
  const cached = new ClaudeProvider({
    baseURL: "https://compatible.invalid/v1",
    apiKey: "test-key",
    model: "claude-test",
    capabilities: resolveModelRouteCapabilities("claude", "claude-test", {
      cache: true,
      promptCache: { mode: "explicit", ttl: "1h" },
    }),
  });
  await cached.generate(
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest question" },
    ],
    tools,
  );
  const cachedBody = bodies[0] ?? {};
  const system = cachedBody["system"] as Array<{ cache_control?: { ttl?: string } }>;
  const cacheTools = cachedBody["tools"] as Array<{ cache_control?: { ttl?: string } }>;
  const history = (
    cachedBody["messages"] as Array<{ content: Array<{ cache_control?: { ttl?: string } }> }>
  )[1];
  assert.equal(system.at(-1)?.cache_control?.ttl, "1h");
  assert.equal(cacheTools.at(-1)?.cache_control?.ttl, "1h");
  assert.equal(history?.content.at(-1)?.cache_control?.ttl, undefined);

  const unknownGateway = new ClaudeProvider({
    baseURL: "https://compatible.invalid/v1",
    apiKey: "test-key",
    model: "claude-test",
    capabilities: resolveModelRouteCapabilities("claude", "claude-test", undefined),
  });
  await unknownGateway.generate(messages("question"), tools);
  assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /cache_control/u);
});

test("tool schema revisions are order-insensitive without mutating array order", () => {
  const first = snapshotToolDefinitions(tools);
  const reordered = snapshotToolDefinitions([...tools].reverse());
  assert.deepEqual(first, reordered);
  assert.deepEqual(first[1]?.inputSchema["required"], ["alpha"]);
  assert.equal(
    promptCacheRevisions(messages("one"), tools).prefix,
    promptCacheRevisions(messages("two"), [...tools].reverse()).prefix,
  );
});
