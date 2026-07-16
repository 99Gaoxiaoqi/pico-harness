import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPicoProjectConfig } from "../../src/input/pico-config.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { OpenAIProvider } from "../../src/provider/openai.js";

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
  assert.equal(response.content, "OK");
  assert.equal(response.usage?.promptTokens, 3);
  assert.equal(response.usage?.completionTokens, 1);
});

test("streamUsage route capability is parsed and rejects non-boolean values", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-stream-usage-config-"));
  const configPath = join(workDir, ".pico", "config.json");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  context.after(() => rm(workDir, { recursive: true, force: true }));

  const config = (streamUsage: unknown): string =>
    JSON.stringify({
      version: 1,
      model: "test/coder",
      providers: {
        test: {
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "PICO_TEST_TOKEN",
          discoverModels: false,
          models: { coder: { streamUsage } },
        },
      },
    });

  await writeFile(configPath, config(true), "utf8");
  const parsed = await loadPicoProjectConfig(workDir);
  assert.equal(parsed.providers.test?.modelCapabilities?.coder?.streamUsage, true);

  await writeFile(configPath, config("yes"), "utf8");
  await assert.rejects(loadPicoProjectConfig(workDir), /streamUsage.*must be a boolean/u);
});
