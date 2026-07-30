import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeProvider } from "../../src/provider/claude.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import {
  openAIPromptCacheKey,
  promptCacheRevisions,
  promptCacheRouteIdentity,
  snapshotToolDefinitions,
} from "../../src/provider/prompt-cache.js";
import { normalizePromptCacheEndpoint } from "../../src/provider/provider-endpoint.js";
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
    promptCache: {
      mode: "explicit",
      ttl: "30m",
      explicitBreakpoints: true,
      keyShards: 4,
    },
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
  assert.deepEqual(bodies[0]?.["prompt_cache_options"], { mode: "explicit", ttl: "30m" });
  assert.equal(Object.hasOwn(bodies[0] ?? {}, "prompt_cache_retention"), false);
  const firstSystem = (bodies[0]?.["messages"] as Array<Record<string, unknown>>)[0];
  assert.deepEqual(
    (firstSystem?.["content"] as Array<Record<string, unknown>>)[0]?.["prompt_cache_breakpoint"],
    { mode: "explicit" },
  );
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

test("prompt-cache route identity includes safe routing query parameters", () => {
  const route = (baseURL: string) =>
    promptCacheRouteIdentity({
      provider: "openai",
      model: "gpt-deployment-test",
      baseURL,
      policy: { mode: "explicit" },
    });
  const deploymentA = route("https://gateway.invalid/v1?deployment=a&api-version=2026-01-01");
  const deploymentAReordered = route(
    "https://gateway.invalid/v1?api-version=2026-01-01&deployment=a",
  );
  const deploymentB = route("https://gateway.invalid/v1?deployment=b&api-version=2026-01-01");
  assert.equal(deploymentA, deploymentAReordered);
  assert.notEqual(deploymentA, deploymentB);

  const revisions = promptCacheRevisions(messages("question"), tools);
  assert.notEqual(
    openAIPromptCacheKey("gpt-deployment-test", revisions, 1, {
      routeIdentity: deploymentA,
    }),
    openAIPromptCacheKey("gpt-deployment-test", revisions, 1, {
      routeIdentity: deploymentB,
    }),
  );
  assert.equal(
    route("https://gateway.invalid/v1?deployment=a&api_key=first-secret"),
    route("https://gateway.invalid/v1?api_key=rotated-secret&deployment=a"),
  );
  const safeEndpoint = normalizePromptCacheEndpoint(
    "https://gateway.invalid/v1?deployment=a&api_key=must-not-be-persisted",
  );
  assert.equal(safeEndpoint, "https://gateway.invalid/v1?deployment=a");
  assert.doesNotMatch(safeEndpoint, /api_key|must-not-be-persisted/u);
});

test("OpenAI appends the API path before preserving routing query parameters", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 2 },
    });
  };

  await new OpenAIProvider({
    baseURL:
      "https://gateway.invalid/v1?deployment=cache-a&api-version=2026-01-01&api_key=transport-only",
    apiKey: "test-key",
    model: "gpt-query-route",
  }).generate(messages("query route"), tools);

  const parsed = new URL(requestUrl);
  assert.equal(parsed.pathname, "/v1/chat/completions");
  assert.equal(parsed.searchParams.get("deployment"), "cache-a");
  assert.equal(parsed.searchParams.get("api-version"), "2026-01-01");
  assert.equal(parsed.searchParams.get("api_key"), "transport-only");
});

test("OpenAI compatible route rejects cache key without disabling breakpoints", async (context) => {
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
    promptCache: { mode: "explicit", ttl: "30m", explicitBreakpoints: true },
  });
  const provider = new OpenAIProvider({
    baseURL: "https://gateway.invalid/v1",
    apiKey: "test-key",
    model: "gpt-test",
    capabilities,
  });
  await provider.generate(messages("first"), tools);
  await provider.generate(messages("second"), tools);
  await new OpenAIProvider({
    baseURL: "https://gateway.invalid/v1",
    apiKey: "rotated-test-key",
    model: "gpt-test",
    capabilities,
  }).generate(messages("third runtime execution"), tools);

  assert.equal(bodies.length, 4);
  assert.equal(Object.hasOwn(bodies[0] ?? {}, "prompt_cache_key"), true);
  assert.equal(Object.hasOwn(bodies[1] ?? {}, "prompt_cache_key"), false);
  assert.equal(Object.hasOwn(bodies[2] ?? {}, "prompt_cache_key"), false);
  assert.equal(Object.hasOwn(bodies[3] ?? {}, "prompt_cache_key"), false);
  assert.deepEqual(bodies[1]?.["prompt_cache_options"], { mode: "explicit", ttl: "30m" });
  assert.match(JSON.stringify(bodies[1]?.["messages"]), /prompt_cache_breakpoint/u);
  assert.match(JSON.stringify(bodies[3]?.["messages"]), /prompt_cache_breakpoint/u);
});

test("OpenAI compatible route rejects breakpoints without disabling cache key", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (Object.hasOwn(body, "prompt_cache_options")) {
      return Response.json(
        { error: { message: "unknown parameter prompt_cache_options" } },
        { status: 422 },
      );
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 2 },
    });
  };

  const capabilities = resolveModelRouteCapabilities("openai", "gpt-breakpoint-test", {
    cache: true,
    promptCache: { mode: "explicit", ttl: "30m", explicitBreakpoints: true },
  });
  const config = {
    baseURL: "https://breakpoint-gateway.invalid/v1",
    apiKey: "test-key",
    model: "gpt-breakpoint-test",
    capabilities,
  };
  const schemaCollisionTools: ToolDefinition[] = [
    {
      name: "schema_collision",
      description: "keep legal schema properties",
      inputSchema: {
        type: "object",
        properties: {
          prompt_cache_breakpoint: { type: "string" },
          safe: { type: "string" },
        },
      },
    },
  ];
  await new OpenAIProvider(config).generate(messages("first"), schemaCollisionTools);
  await new OpenAIProvider({ ...config, apiKey: "rotated-key" }).generate(
    messages("second"),
    schemaCollisionTools,
  );

  assert.equal(bodies.length, 3);
  assert.equal(typeof bodies[0]?.["prompt_cache_key"], "string");
  assert.equal(typeof bodies[1]?.["prompt_cache_key"], "string");
  assert.equal(typeof bodies[2]?.["prompt_cache_key"], "string");
  assert.equal(Object.hasOwn(bodies[1] ?? {}, "prompt_cache_options"), false);
  assert.doesNotMatch(JSON.stringify(bodies[1]?.["messages"]), /prompt_cache_breakpoint/u);
  assert.doesNotMatch(JSON.stringify(bodies[2]?.["messages"]), /prompt_cache_breakpoint/u);
  for (const body of bodies) {
    const parameters = (
      body["tools"] as Array<{ function: { parameters: { properties: object } } }>
    )[0]?.function.parameters.properties;
    assert.deepEqual(Object.keys(parameters ?? {}).sort(), ["prompt_cache_breakpoint", "safe"]);
  }
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
      promptCache: { mode: "explicit", keyShards: 64 },
    }),
  });
  await provider.generate(messages("same question"), tools, {
    promptCacheShardSeed: "opaque-seed-a",
    promptCacheShardActive: true,
  });
  await provider.generate(messages("same question"), tools, {
    promptCacheShardSeed: "opaque-seed-b",
    promptCacheShardActive: true,
  });
  await provider.generate(messages("same question"), tools, {
    promptCacheShardSeed: "opaque-seed-a",
    promptCacheShardActive: true,
  });

  const keys = bodies.map((body) => String(body["prompt_cache_key"]));
  assert.equal(keys[0], keys[2], "the same conversation must not drift between shards");
  assert.notEqual(keys[0], keys[1], "different conversations should distribute when sharding");
  assert.ok(keys.every((key) => key.length <= 64));
  assert.ok(keys.every((key) => !key.includes("opaque-seed")));
});

test("OpenAI sharding activates after the route RPM threshold and stays active next minute", (context) => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  context.after(() => {
    Date.now = originalNow;
  });
  const provider = new OpenAIProvider({
    baseURL: "https://route-threshold.invalid/v1",
    apiKey: "test-key",
    model: "gpt-route-threshold-test",
    capabilities: resolveModelRouteCapabilities("openai", "gpt-route-threshold-test", {
      cache: true,
      promptCache: { mode: "explicit", keyShards: 4, shardThresholdRpm: 1 },
    }),
  });
  const prepare = provider.requestCapabilities?.preparePromptCacheSharding;
  assert.equal(typeof prepare, "function");
  assert.equal(prepare?.(), false);
  assert.equal(prepare?.(), true);
  now = 61_000;
  assert.equal(prepare?.(), true);
});

test("cache shard identity and threshold decision survive retry and credential rotation", async () => {
  const seen: Array<{ seed?: string; active?: boolean }> = [];
  const succeeding: LLMProvider = {
    modelName: "gpt-test",
    generate: async (_messages, _tools, options?: LLMProviderRequestOptions) => {
      seen.push({
        ...(options?.promptCacheShardSeed ? { seed: options.promptCacheShardSeed } : {}),
        ...(options?.promptCacheShardActive !== undefined
          ? { active: options.promptCacheShardActive }
          : {}),
      });
      return { role: "assistant", content: "ok" };
    },
  };
  const limited: LLMProvider = {
    modelName: "gpt-test",
    generate: async (_messages, _tools, options?: LLMProviderRequestOptions) => {
      seen.push({
        ...(options?.promptCacheShardSeed ? { seed: options.promptCacheShardSeed } : {}),
        ...(options?.promptCacheShardActive !== undefined
          ? { active: options.promptCacheShardActive }
          : {}),
      });
      throw new LLMStatusError(429, "rate limited");
    },
  };

  await generateWithRetry(limited, messages("question"), tools, {
    maxAttempts: 2,
    promptCacheShardSeed: "opaque-stable-seed",
    promptCacheShardActive: true,
    onRateLimited: () => succeeding,
  });

  assert.deepEqual(seen, [
    { seed: "opaque-stable-seed", active: true },
    { seed: "opaque-stable-seed", active: true },
  ]);
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

test("OpenAI stream preserves tools while sending tool_choice none on supported routes", async (context) => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      ['data: {"choices":[{"delta":{"content":"ok"}}]}', "", "data: [DONE]", ""].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const provider = new OpenAIProvider({
    baseURL: "https://api.openai.com/v1",
    apiKey: "test-key",
    model: "gpt-tool-choice-test",
    capabilities: resolveModelRouteCapabilities(
      "openai",
      "gpt-tool-choice-test",
      { toolCall: true },
      { baseURL: "https://api.openai.com/v1" },
    ),
  });

  await provider.generateStream(messages("question"), tools, () => undefined, {
    toolChoice: "none",
  });

  assert.equal(provider.requestCapabilities?.toolChoiceNoneWithTools, true);
  assert.equal(body?.["tool_choice"], "none");
  assert.equal(Array.isArray(body?.["tools"]), true);
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
