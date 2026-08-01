import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiProvider } from "../../src/provider/gemini.js";
import { toCanonicalUsage, type Usage } from "../../src/schema/message.js";

const usageMetadata = {
  promptTokenCount: 27,
  candidatesTokenCount: 45,
  toolUsePromptTokenCount: 31,
  thoughtsTokenCount: 10_309,
  totalTokenCount: 10_412,
};

const expectedUsage: Usage = {
  promptTokens: 58,
  completionTokens: 10_354,
  cacheReadTokens: 0,
  reasoningTokens: 10_309,
  reportedFields: ["prompt", "completion", "reasoning"],
};

test("Gemini runtime totals include tool-use prompts and thoughts", async (context) => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (String(input).includes(":streamGenerateContent")) {
      return new Response(
        [
          'data: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}',
          "",
          `data: ${JSON.stringify({ usageMetadata })}`,
          "",
          "",
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: "OK" }] } }],
      usageMetadata,
    });
  };

  const provider = new GeminiProvider({
    baseURL: "https://provider.invalid",
    apiKey: "test-key",
    model: "gemini-test",
  });

  const response = await provider.generate([{ role: "user", content: "test" }], []);
  assert.deepEqual(response.usage, expectedUsage);
  assert.deepEqual(toCanonicalUsage(response.usage!), {
    inputTokens: 58,
    outputTokens: 45,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 10_309,
    totalPromptTokens: 58,
    totalCompletionTokens: 10_354,
  });

  const deltas: string[] = [];
  const streamResponse = await provider.generateStream(
    [{ role: "user", content: "test" }],
    [],
    (delta) => deltas.push(delta),
  );
  assert.deepEqual(deltas, ["OK"]);
  assert.deepEqual(streamResponse.usage, expectedUsage);
  assert.equal(requestBodies.length, 2);
  assert.equal(
    requestBodies.some((body) => Object.hasOwn(body, "cachedContent")),
    false,
  );
});
