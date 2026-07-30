import assert from "node:assert/strict";
import { test } from "node:test";
import type { BillingRoute } from "../../src/observability/pricing.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition, Usage } from "../../src/schema/message.js";
import {
  comparePromptCacheBenchmarkToCold,
  measurePromptCacheBenchmarkRequest,
  runPromptCacheBenchmarkGroup,
  SafePromptCacheBenchmarkFailure,
  serializePromptCacheBenchmarkSample,
  type PromptCacheBenchmarkSample,
} from "../e2e/prompt-cache-benchmark-support.js";

const PROMPT_SECRET = "PROMPT_SENTINEL_MUST_NOT_LEAK";
const ANSWER_SECRET = "ANSWER_SENTINEL_MUST_NOT_LEAK";
const HEADER_SECRET = "HEADER_SENTINEL_MUST_NOT_LEAK";
const API_KEY_SECRET = "API_KEY_SENTINEL_MUST_NOT_LEAK";

const billingRoute: BillingRoute = {
  provider: "claude",
  model: "benchmark-test-model",
  pricing: {
    inputPerMillion: 2,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
    source: "configured",
  },
};

const messages: Message[] = [
  { role: "system", content: `${PROMPT_SECRET}:${HEADER_SECRET}:${API_KEY_SECRET}` },
  { role: "user", content: "safe request" },
];
const tools: ToolDefinition[] = [
  {
    name: "cache_probe",
    description: PROMPT_SECRET,
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
];

test("prompt-cache benchmark compares usage/cost/TTFT through a fixed safe output schema", async () => {
  const usages: Usage[] = [
    {
      promptTokens: 100,
      completionTokens: 20,
      inputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 70,
      reasoningTokens: 5,
    },
    {
      promptTokens: 100,
      completionTokens: 12,
      inputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      reasoningTokens: 2,
    },
  ];
  let requestCount = 0;
  const provider: LLMProvider = {
    async generate() {
      throw new Error("streaming path expected");
    },
    async generateStream(_requestMessages, _availableTools, onDelta) {
      onDelta(ANSWER_SECRET);
      const usage = usages[requestCount++];
      assert.ok(usage);
      return {
        role: "assistant",
        content: ANSWER_SECRET,
        usage,
        providerData: { header: HEADER_SECRET, apiKey: API_KEY_SECRET },
      };
    },
  };
  const clock = [100, 112, 140, 200, 206, 224];
  const now = (): number => {
    const value = clock.shift();
    if (value === undefined) throw new Error("deterministic benchmark clock exhausted");
    return value;
  };
  const cold = await measurePromptCacheBenchmarkRequest({
    provider,
    billingRoute,
    model: "benchmark-test-model",
    protocol: "claude",
    scenario: "cold-request",
    phase: "request",
    groupAttempt: 1,
    messages,
    tools,
    now,
  });
  const warm = await measurePromptCacheBenchmarkRequest({
    provider,
    billingRoute,
    model: "benchmark-test-model",
    protocol: "claude",
    scenario: "consecutive-tool-rounds",
    phase: "round-1",
    groupAttempt: 1,
    messages,
    tools,
    now,
  });
  const compared = comparePromptCacheBenchmarkToCold([cold, warm]);

  assert.equal(requestCount, 2, "each measured request is dispatched exactly once");
  assert.equal(compared[0]?.latency.ttftMs, 12);
  assert.equal(compared[0]?.latency.totalMs, 40);
  assert.equal(compared[1]?.latency.ttftMs, 6);
  assert.equal(compared[1]?.usage.cacheReadTokens, 80);
  assert.equal(compared[0]?.status.cacheObservation, "write");
  assert.equal(compared[1]?.status.cacheObservation, "read");
  assert.equal(compared[1]?.usage.versusCold?.cacheReadTokensDelta, 80);
  assert.equal(compared[1]?.latency.versusCold?.ttftRatio, 0.5);
  assert.ok((compared[1]?.usage.versusCold?.costRatio ?? 1) < 1);

  const polluted = {
    ...compared[1],
    prompt: PROMPT_SECRET,
    answer: ANSWER_SECRET,
    status: { ...compared[1]!.status, header: HEADER_SECRET },
    usage: { ...compared[1]!.usage, apiKey: API_KEY_SECRET },
    hash: { ...compared[1]!.hash, response: ANSWER_SECRET },
  } as unknown as PromptCacheBenchmarkSample;
  const line = serializePromptCacheBenchmarkSample(polluted);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "model",
    "protocol",
    "status",
    "usage",
    "latency",
    "hash",
  ]);
  assert.doesNotMatch(
    line,
    new RegExp([PROMPT_SECRET, ANSWER_SECRET, HEADER_SECRET, API_KEY_SECRET].join("|"), "u"),
  );
  assert.match(compared[1]!.hash.requestSha256, /^[a-f0-9]{64}$/u);
  assert.match(compared[1]!.hash.responseSha256, /^[a-f0-9]{64}$/u);
});

test("prompt-cache benchmark retries one whole group only for transport failure", async () => {
  const trace: string[] = [];
  const recovered = await runPromptCacheBenchmarkGroup(async (attempt) => {
    trace.push(`${attempt}:cold`, `${attempt}:tool`);
    if (attempt === 1) {
      throw new TypeError(`${API_KEY_SECRET}: transport failed`, {
        cause: { code: "UND_ERR_SOCKET" },
      });
    }
    trace.push(`${attempt}:cross-session`, `${attempt}:post-compaction`);
    return "complete";
  });

  assert.deepEqual(trace, [
    "1:cold",
    "1:tool",
    "2:cold",
    "2:tool",
    "2:cross-session",
    "2:post-compaction",
  ]);
  assert.deepEqual(recovered, { groupAttempt: 2, value: "complete" });

  let transportAttempts = 0;
  await assert.rejects(
    runPromptCacheBenchmarkGroup(async () => {
      transportAttempts++;
      throw new TypeError(`${API_KEY_SECRET}: still unavailable`, {
        cause: { code: "UND_ERR_SOCKET" },
      });
    }),
    (error: unknown) => {
      assert.ok(error instanceof SafePromptCacheBenchmarkFailure);
      assert.equal(error.failure.kind, "transport");
      assert.equal(error.groupAttempt, 2);
      assert.doesNotMatch(error.message, new RegExp(API_KEY_SECRET, "u"));
      return true;
    },
  );
  assert.equal(transportAttempts, 2);

  let programmingAttempts = 0;
  await assert.rejects(
    runPromptCacheBenchmarkGroup(async () => {
      programmingAttempts++;
      throw new TypeError(`${API_KEY_SECRET}: malformed benchmark value`);
    }),
    (error: unknown) => {
      assert.ok(error instanceof SafePromptCacheBenchmarkFailure);
      assert.equal(error.failure.kind, "protocol");
      assert.equal(error.groupAttempt, 1);
      assert.doesNotMatch(error.message, new RegExp(API_KEY_SECRET, "u"));
      return true;
    },
  );
  assert.equal(programmingAttempts, 1);

  let abortAttempts = 0;
  await assert.rejects(
    runPromptCacheBenchmarkGroup(async () => {
      abortAttempts++;
      const error = new Error(`${API_KEY_SECRET}: host cancelled`);
      error.name = "AbortError";
      throw error;
    }),
    (error: unknown) => {
      assert.ok(error instanceof SafePromptCacheBenchmarkFailure);
      assert.equal(error.failure.kind, "protocol");
      assert.equal(error.groupAttempt, 1);
      assert.doesNotMatch(error.message, new RegExp(API_KEY_SECRET, "u"));
      return true;
    },
  );
  assert.equal(abortAttempts, 1);

  let protocolAttempts = 0;
  await assert.rejects(
    runPromptCacheBenchmarkGroup(async () => {
      protocolAttempts++;
      throw new LLMStatusError(429, `${API_KEY_SECRET}: quota response`);
    }),
    (error: unknown) => {
      assert.ok(error instanceof SafePromptCacheBenchmarkFailure);
      assert.equal(error.failure.kind, "quota");
      assert.equal(error.groupAttempt, 1);
      assert.doesNotMatch(error.message, new RegExp(API_KEY_SECRET, "u"));
      return true;
    },
  );
  assert.equal(protocolAttempts, 1);
});
