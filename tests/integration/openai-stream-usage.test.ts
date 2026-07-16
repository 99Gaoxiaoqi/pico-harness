import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPicoProjectConfig } from "../../src/input/pico-config.js";
import { createProvider } from "../../src/provider/factory.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { loadModelRouter } from "../../src/provider/model-router.js";
import { OpenAIProvider } from "../../src/provider/openai.js";

function streamResponse(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("OpenAI requests enforce the configured output-token limit", async (context) => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if (body["stream"] === true) {
      return streamResponse([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'),
        new TextEncoder().encode("data: [DONE]\n\n"),
      ]);
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
  };

  const capabilities = resolveModelRouteCapabilities("openai", "capped-model", {
    output: 1234,
  });
  const provider = createProvider("openai", {
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "capped-model",
    routeId: "test/capped-model",
    capabilities,
  });

  await provider.generate([{ role: "user", content: "test" }], []);
  assert.ok(provider.generateStream);
  await provider.generateStream([{ role: "user", content: "test" }], [], () => undefined);

  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.equal(body["max_tokens"], 1234);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  }
});

test("OpenAI routes can select max_completion_tokens explicitly", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
  };

  const provider = createProvider("openai", {
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "reasoning-model",
    routeId: "test/reasoning-model",
    capabilities: resolveModelRouteCapabilities("openai", "reasoning-model", {
      output: 2048,
      outputTokenField: "max_completion_tokens",
    }),
  });

  await provider.generate([{ role: "user", content: "test" }], []);

  assert.equal(requestBody?.["max_completion_tokens"], 2048);
  assert.equal(Object.hasOwn(requestBody ?? {}, "max_tokens"), false);
});

test("official OpenAI configured and discovered routes use max_completion_tokens", async () => {
  const configured = await loadModelRouter({
    config: {
      providers: {
        official: {
          protocol: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_TEST_KEY",
          models: ["o3"],
          discoverModels: false,
        },
      },
    },
    env: { OPENAI_TEST_KEY: "test-key" },
    legacyProvider: "openai",
    legacyModel: "unused",
  });
  assert.equal(
    configured.require("official/o3").capabilities.outputTokenField,
    "max_completion_tokens",
  );

  const discovered = await loadModelRouter({
    config: {
      providers: {
        official: {
          protocol: "openai",
          baseURL: "https://api.openai.com/v1",
          apiKeyEnv: "OPENAI_TEST_KEY",
          models: [],
          discoverModels: true,
        },
      },
    },
    env: { OPENAI_TEST_KEY: "test-key" },
    legacyProvider: "openai",
    legacyModel: "unused",
    fetch: async () => Response.json({ data: [{ id: "o4-mini" }] }),
  });
  assert.equal(
    discovered.require("official/o4-mini").capabilities.outputTokenField,
    "max_completion_tokens",
  );

  const compatible = await loadModelRouter({
    config: {
      providers: {
        compatible: {
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "COMPATIBLE_TEST_KEY",
          models: ["o3"],
          discoverModels: false,
        },
      },
    },
    env: { COMPATIBLE_TEST_KEY: "test-key" },
    legacyProvider: "openai",
    legacyModel: "unused",
  });
  assert.equal(compatible.require("compatible/o3").capabilities.outputTokenField, "max_tokens");
});

test("legacy OpenAI-compatible calls do not guess an output-token field", async (context) => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestBodies.push(body);
    if (body["stream"] === true) {
      return streamResponse([
        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'),
        new TextEncoder().encode("data: [DONE]\n\n"),
      ]);
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
  };

  const provider = new OpenAIProvider({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "legacy-compatible-model",
  });
  await provider.generate([{ role: "user", content: "test" }], []);
  await provider.generateStream([{ role: "user", content: "test" }], [], () => undefined);

  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.equal(Object.hasOwn(body, "max_tokens"), false);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
  }
});

test("OpenAI reasoning patches cannot unset the configured output-token limit", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
  };

  const provider = createProvider(
    "openai",
    {
      baseURL: "https://provider.invalid/v1",
      apiKey: "test-key",
      model: "reasoning-model",
      routeId: "test/reasoning-model",
      capabilities: resolveModelRouteCapabilities("openai", "reasoning-model", {
        output: 1024,
        reasoning: {
          enabled: true,
          levels: ["strict"],
          defaultLevel: "strict",
          providerOptionsByLevel: {
            strict: {
              openai: {
                unset: [["max_tokens"]],
                set: [{ path: ["max_completion_tokens"], value: 999_999 }],
              },
            },
          },
        },
      }),
    },
    "strict",
  );

  await provider.generate([{ role: "user", content: "test" }], []);

  assert.equal(requestBody?.["max_tokens"], 1024);
  assert.equal(Object.hasOwn(requestBody ?? {}, "max_completion_tokens"), false);
});

test("OpenAI reasoning patches cannot raise or double-write the output-token limit", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponse([
      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'),
      new TextEncoder().encode("data: [DONE]\n\n"),
    ]);
  };

  const provider = createProvider(
    "openai",
    {
      baseURL: "https://provider.invalid/v1",
      apiKey: "test-key",
      model: "reasoning-model",
      routeId: "test/reasoning-model",
      capabilities: resolveModelRouteCapabilities("openai", "reasoning-model", {
        output: 2048,
        outputTokenField: "max_completion_tokens",
        reasoning: {
          enabled: true,
          levels: ["strict"],
          defaultLevel: "strict",
          providerOptionsByLevel: {
            strict: {
              openai: {
                set: [
                  { path: ["max_completion_tokens"], value: 999_999 },
                  { path: ["max_tokens"], value: 999_999 },
                ],
              },
            },
          },
        },
      }),
    },
    "strict",
  );

  assert.ok(provider.generateStream);
  await provider.generateStream([{ role: "user", content: "test" }], [], () => undefined);

  assert.equal(requestBody?.["max_completion_tokens"], 2048);
  assert.equal(Object.hasOwn(requestBody ?? {}, "max_tokens"), false);
});

test("OpenAI stream requests and consumes the terminal Usage-only chunk", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"OK"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":5},"completion_tokens_details":{"reasoning_tokens":1}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  const deltas: string[] = [];
  const response = await new OpenAIProvider({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
    capabilities: resolveModelRouteCapabilities("openai", "test-model", {
      streamUsage: true,
    }),
  }).generateStream([{ role: "user", content: "test" }], [], (delta) => deltas.push(delta));

  assert.deepEqual(requestBody?.["stream_options"], { include_usage: true });
  assert.equal(deltas.join(""), "OK");
  assert.equal(response.content, "OK");
  assert.deepEqual(response.usage, {
    promptTokens: 13,
    completionTokens: 2,
    cacheReadTokens: 5,
    reasoningTokens: 1,
    reportedFields: ["prompt", "completion", "cacheRead", "reasoning"],
  });
});

test("OpenAI-compatible routes omit stream_options unless explicitly enabled", async (context) => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"OK"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  const response = await new OpenAIProvider({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "legacy-compatible-model",
  }).generateStream([{ role: "user", content: "test" }], [], () => undefined);

  assert.equal(Object.hasOwn(requestBody ?? {}, "stream_options"), false);
  assert.equal(Object.hasOwn(requestBody ?? {}, "max_tokens"), false);
  assert.equal(Object.hasOwn(requestBody ?? {}, "max_completion_tokens"), false);
  assert.equal(response.content, "OK");
  assert.equal(response.usage?.promptTokens, 3);
  assert.equal(response.usage?.completionTokens, 1);
});

test("OpenAI stream accepts CRLF, bare CR, and SSE fields across chunk boundaries", async (context) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const splitCharacter = encoder.encode("你");
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    streamResponse([
      encoder.encode(": heartbeat\r"),
      encoder.encode("\nevent: message\r"),
      encoder.encode('\ndata:{"choices":[{"delta":\r'),
      encoder.encode('\ndata:{"content":"'),
      splitCharacter.slice(0, 1),
      splitCharacter.slice(1),
      encoder.encode('"}}]}\r'),
      encoder.encode("\n\r"),
      encoder.encode("\n"),
      encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\r'),
      encoder.encode("\rdata: [DONE]\r"),
      encoder.encode("\n\r"),
      encoder.encode("\n"),
    ]);

  const deltas: string[] = [];
  const response = await new OpenAIProvider({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
  }).generateStream([{ role: "user", content: "test" }], [], (delta) => deltas.push(delta));

  assert.deepEqual(deltas, ["你", "好"]);
  assert.equal(response.content, "你好");
});

test("OpenAI stream consumes the final event at EOF without a trailing blank line", async (context) => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const emoji = encoder.encode("🙂");
  const firstChunk = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "lookup", arguments: '{"q":' },
            },
          ],
        },
      },
    ],
  };
  const finalChunk = {
    choices: [
      {
        delta: {
          content: "🙂",
          tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 2 },
  };
  const finalJson = JSON.stringify(finalChunk);
  const emojiIndex = finalJson.indexOf("🙂");
  assert.notEqual(emojiIndex, -1);

  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    streamResponse([
      encoder.encode(`data:${JSON.stringify(firstChunk)}\n\n`),
      encoder.encode(`data: ${finalJson.slice(0, emojiIndex)}`),
      emoji.slice(0, 2),
      emoji.slice(2),
      encoder.encode(finalJson.slice(emojiIndex + 2)),
    ]);

  const deltas: string[] = [];
  const response = await new OpenAIProvider({
    baseURL: "https://provider.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
  }).generateStream([{ role: "user", content: "test" }], [], (delta) => deltas.push(delta));

  assert.deepEqual(deltas, ["🙂"]);
  assert.equal(response.content, "🙂");
  assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "lookup", arguments: '{"q":"x"}' }]);
  assert.deepEqual(response.usage, {
    promptTokens: 8,
    completionTokens: 2,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    reportedFields: ["prompt", "completion"],
  });
});

test("OpenAI wire capabilities are parsed and reject invalid values", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-stream-usage-config-"));
  const configPath = join(workDir, ".pico", "config.json");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  context.after(() => rm(workDir, { recursive: true, force: true }));

  const config = (capabilities: Record<string, unknown>): string =>
    JSON.stringify({
      version: 1,
      model: "test/coder",
      providers: {
        test: {
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "PICO_TEST_TOKEN",
          discoverModels: false,
          models: { coder: capabilities },
        },
      },
    });

  await writeFile(
    configPath,
    config({ streamUsage: true, outputTokenField: "max_completion_tokens" }),
    "utf8",
  );
  const parsed = await loadPicoProjectConfig(workDir);
  assert.equal(parsed.providers.test?.modelCapabilities?.coder?.streamUsage, true);
  assert.equal(
    parsed.providers.test?.modelCapabilities?.coder?.outputTokenField,
    "max_completion_tokens",
  );

  await writeFile(configPath, config({ streamUsage: "yes" }), "utf8");
  await assert.rejects(loadPicoProjectConfig(workDir), /streamUsage.*must be a boolean/u);

  await writeFile(configPath, config({ outputTokenField: "automatic" }), "utf8");
  await assert.rejects(
    loadPicoProjectConfig(workDir),
    /outputTokenField.*must be max_tokens or max_completion_tokens/u,
  );
});
