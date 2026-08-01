import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { Session } from "../../src/engine/session.js";
import { logger } from "../../src/observability/logger.js";
import type { BillingRoute, PricingEntry } from "../../src/observability/pricing.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import { createProvider, type ProviderKind } from "../../src/provider/factory.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import {
  resolveModelRouteCapabilities,
  type ModelCapabilityConfig,
  type ModelRouteCapabilities,
} from "../../src/provider/model-capabilities.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import {
  comparePromptCacheBenchmarkToCold,
  measurePromptCacheBenchmarkRequest,
  runPromptCacheBenchmarkGroup,
  serializePromptCacheBenchmarkSample,
  type PromptCacheBenchmarkSample,
} from "./prompt-cache-benchmark-support.js";

const TEST_TIMEOUT_MS = 30 * 60_000;
// This benchmark is intentionally excluded from the generic real-model suite. It only reads
// credentials after the explicit opt-in flag is set.
const RUN_REAL_BENCHMARK = process.env.RUN_PROMPT_CACHE_BENCHMARK === "1";
const realBenchmarkTest = RUN_REAL_BENCHMARK ? test : test.skip;

realBenchmarkTest(
  "real prompt-cache benchmark compares cold/warm requests across tools, Sessions, and compaction",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const previousLogLevel = logger.level;
    logger.level = "silent";
    context.after(() => {
      logger.level = previousLogLevel;
    });

    const config = realBenchmarkConfig();
    const rawProvider = createProvider(config.protocol, {
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      capabilities: config.capabilities,
      routeId: `prompt-cache-benchmark/${config.model}`,
      thinkingEffort: "off",
    });
    const suiteNonce = randomUUID();
    const group = await runPromptCacheBenchmarkGroup((groupAttempt) =>
      runRealBenchmarkGroup(config, rawProvider, suiteNonce, groupAttempt),
    );
    const report = comparePromptCacheBenchmarkToCold(group.value);

    for (const sample of report) {
      console.log(serializePromptCacheBenchmarkSample(sample));
    }
    assertBenchmarkShape(report, group.groupAttempt);
  },
);

interface RealBenchmarkConfig {
  readonly protocol: ProviderKind;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly capabilities: ModelRouteCapabilities;
  readonly billingRoute: BillingRoute;
}

interface BenchmarkFixture {
  readonly system: Message;
  readonly tools: ToolDefinition[];
  readonly coldMessages: Message[];
  readonly firstToolRoundMessages: Message[];
  readonly secondToolRoundMessages: Message[];
  readonly compactionHistory: Message[];
  readonly postCompactionUser: Message;
}

async function runRealBenchmarkGroup(
  config: RealBenchmarkConfig,
  rawProvider: LLMProvider,
  suiteNonce: string,
  groupAttempt: number,
): Promise<PromptCacheBenchmarkSample[]> {
  const root = await mkdtemp(join(tmpdir(), "pico-prompt-cache-benchmark-"));
  const sessionA = new Session(`cache-benchmark-a-${suiteNonce}-${groupAttempt}`, root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  const sessionB = new Session(`cache-benchmark-b-${suiteNonce}-${groupAttempt}`, root, {
    persistence: false,
    picoHome: join(root, "pico-home"),
  });
  const providerA = new CostTracker(rawProvider, config.billingRoute, sessionA, {
    context: { purpose: "main", sessionId: sessionA.id },
  });
  const providerB = new CostTracker(rawProvider, config.billingRoute, sessionB, {
    context: { purpose: "main", sessionId: sessionB.id },
  });
  const fixture = benchmarkFixture(`${suiteNonce}:attempt-${groupAttempt}`);
  const samples: PromptCacheBenchmarkSample[] = [];

  try {
    samples.push(
      await measuredRequest(config, providerA, fixture, {
        scenario: "cold-request",
        phase: "request",
        groupAttempt,
        messages: fixture.coldMessages,
      }),
    );
    samples.push(
      await measuredRequest(config, providerA, fixture, {
        scenario: "consecutive-tool-rounds",
        phase: "round-1",
        groupAttempt,
        messages: fixture.firstToolRoundMessages,
      }),
    );
    samples.push(
      await measuredRequest(config, providerA, fixture, {
        scenario: "consecutive-tool-rounds",
        phase: "round-2",
        groupAttempt,
        messages: fixture.secondToolRoundMessages,
      }),
    );
    samples.push(
      await measuredRequest(config, providerB, fixture, {
        scenario: "cross-session",
        phase: "request",
        groupAttempt,
        messages: fixture.coldMessages,
      }),
    );

    await sessionA.commitMessages(...fixture.compactionHistory);
    const capturedProvider = new SanitizedCompactionProvider(providerA);
    const compacted = await new FullCompactor({
      provider: capturedProvider,
      maxAttempts: 1,
    }).compactInMemorySession(sessionA, {
      inputBudgetTokens: 8_000,
      targetRetainedTokens: 120,
      trigger: "manual",
    });
    if (!compacted) {
      const capturedFailure = capturedProvider.capturedFailure();
      if (capturedFailure !== undefined) throw capturedFailure;
      throw new LLMStatusError(
        422,
        "prompt-cache benchmark full compaction produced no summary; detail omitted",
      );
    }

    samples.push(
      await measuredRequest(config, providerA, fixture, {
        scenario: "post-full-compaction-first-request",
        phase: "request",
        groupAttempt,
        messages: [fixture.system, ...sessionA.getHistory(), fixture.postCompactionUser],
      }),
    );
    return samples;
  } finally {
    await Promise.allSettled([sessionA.close(), sessionB.close()]);
    await rm(root, { recursive: true, force: true });
  }
}

async function measuredRequest(
  config: RealBenchmarkConfig,
  provider: LLMProvider,
  fixture: BenchmarkFixture,
  input: Pick<
    Parameters<typeof measurePromptCacheBenchmarkRequest>[0],
    "scenario" | "phase" | "groupAttempt" | "messages"
  >,
): Promise<PromptCacheBenchmarkSample> {
  return await measurePromptCacheBenchmarkRequest({
    provider,
    billingRoute: config.billingRoute,
    model: config.model,
    protocol: config.protocol,
    tools: fixture.tools,
    requestOptions:
      provider.requestCapabilities?.toolChoiceNoneWithTools === true
        ? { toolChoice: "none" }
        : undefined,
    ...input,
  });
}

class SanitizedCompactionProvider implements LLMProvider {
  private failureCaptured = false;
  private failure: unknown;

  constructor(private readonly next: LLMProvider) {}

  get modelName(): string | undefined {
    return this.next.modelName;
  }

  get requestCapabilities() {
    return this.next.requestCapabilities;
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    try {
      return await this.next.generate(messages, availableTools, options);
    } catch (error) {
      this.failureCaptured = true;
      this.failure = error;
      // The raw failure is retained out-of-band for classification. Attaching it as `cause`
      // would let a test-runner stack dump provider response text or credentials.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("prompt-cache benchmark compaction request failed; detail omitted");
    }
  }

  capturedFailure(): unknown {
    return this.failureCaptured ? this.failure : undefined;
  }
}

function benchmarkFixture(marker: string): BenchmarkFixture {
  const stableCorpus = Array.from(
    { length: 520 },
    () => "alpha beta gamma delta epsilon zeta eta theta cache invariant",
  ).join(" ");
  const system: Message = {
    role: "system",
    content: [
      "This is inert prompt-cache benchmark context. Never repeat it.",
      `Benchmark run marker: ${marker}`,
      stableCorpus,
    ].join("\n"),
  };
  const tools: ToolDefinition[] = [
    {
      name: "cache_probe",
      description: "A deterministic no-op used to exercise consecutive tool protocol rounds.",
      inputSchema: {
        type: "object",
        properties: { round: { type: "integer" } },
        required: ["round"],
      },
    },
  ];
  const coldHistory: Message[] = [
    {
      role: "user",
      content: "Reply with exactly CACHE_BENCHMARK_COLD_READY. Do not call tools.",
    },
  ];
  const firstToolRoundHistory: Message[] = [
    ...coldHistory,
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "cache-benchmark-tool-round-1",
          name: "cache_probe",
          arguments: '{"round":1}',
        },
      ],
    },
    {
      role: "user",
      content: "CACHE_PROBE_ROUND_1_OK. Reply exactly CACHE_BENCHMARK_TOOL_1_READY.",
      toolCallId: "cache-benchmark-tool-round-1",
    },
  ];
  const secondToolRoundHistory: Message[] = [
    ...firstToolRoundHistory,
    { role: "assistant", content: "CACHE_BENCHMARK_TOOL_1_COMPLETE" },
    { role: "user", content: "Proceed through the second cache probe round." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "cache-benchmark-tool-round-2",
          name: "cache_probe",
          arguments: '{"round":2}',
        },
      ],
    },
    {
      role: "user",
      content: "CACHE_PROBE_ROUND_2_OK. Reply exactly CACHE_BENCHMARK_TOOL_2_READY.",
      toolCallId: "cache-benchmark-tool-round-2",
    },
  ];
  const historicalText = "bounded historical benchmark context ".repeat(120);
  const compactionHistory: Message[] = [
    { role: "user", content: `Old request A. ${historicalText}` },
    { role: "assistant", content: `Old response A. ${historicalText}` },
    { role: "user", content: `Old request B. ${historicalText}` },
    { role: "assistant", content: `Old response B. ${historicalText}` },
    ...secondToolRoundHistory,
    { role: "assistant", content: "CACHE_BENCHMARK_TOOL_2_COMPLETE" },
  ];

  return {
    system,
    tools,
    coldMessages: [system, ...coldHistory],
    firstToolRoundMessages: [system, ...firstToolRoundHistory],
    secondToolRoundMessages: [system, ...secondToolRoundHistory],
    compactionHistory,
    postCompactionUser: {
      role: "user",
      content: "Reply exactly CACHE_BENCHMARK_POST_COMPACTION_READY. Do not call tools.",
    },
  };
}

function realBenchmarkConfig(): RealBenchmarkConfig {
  const protocol = requiredProtocol();
  const baseURL = requiredEnvironment("PROMPT_CACHE_BENCHMARK_BASE_URL").replace(/\/+$/u, "");
  const apiKey = requiredEnvironment("PROMPT_CACHE_BENCHMARK_API_KEY");
  const model = requiredEnvironment("PROMPT_CACHE_BENCHMARK_MODEL");
  const pricing: PricingEntry = {
    inputPerMillion: requiredNonNegativeNumber("PROMPT_CACHE_BENCHMARK_INPUT_USD_PER_MILLION"),
    outputPerMillion: requiredNonNegativeNumber("PROMPT_CACHE_BENCHMARK_OUTPUT_USD_PER_MILLION"),
    cacheReadPerMillion: requiredNonNegativeNumber(
      "PROMPT_CACHE_BENCHMARK_CACHE_READ_USD_PER_MILLION",
    ),
    cacheWritePerMillion: requiredNonNegativeNumber(
      "PROMPT_CACHE_BENCHMARK_CACHE_WRITE_USD_PER_MILLION",
    ),
    source: "configured",
  };
  const capabilityPrice: NonNullable<ModelCapabilityConfig["price"]> = {
    inputPerMillion: pricing.inputPerMillion,
    outputPerMillion: pricing.outputPerMillion,
    cacheReadPerMillion: pricing.cacheReadPerMillion,
    cacheWritePerMillion: pricing.cacheWritePerMillion,
  };
  const promptCache: NonNullable<ModelCapabilityConfig["promptCache"]> =
    protocol === "claude"
      ? { mode: "explicit", ttl: "5m" }
      : protocol === "openai"
        ? {
            mode: "explicit",
            ttl: "30m",
            explicitBreakpoints: true,
            keyShards: 1,
          }
        : { mode: "implicit" };
  const capabilities = resolveModelRouteCapabilities(
    protocol,
    model,
    {
      output: 768,
      reasoning: false,
      toolCall: true,
      cache: true,
      promptCache,
      streamUsage: true,
      price: capabilityPrice,
    },
    { baseURL },
  );

  return {
    protocol,
    baseURL,
    apiKey,
    model,
    capabilities,
    billingRoute: {
      provider: protocol,
      model,
      pricing,
    },
  };
}

function assertBenchmarkShape(
  samples: readonly PromptCacheBenchmarkSample[],
  groupAttempt: number,
): void {
  assert.equal(samples.length, 5);
  assert.deepEqual(
    new Set(samples.map((sample) => sample.status.scenario)),
    new Set([
      "cold-request",
      "consecutive-tool-rounds",
      "cross-session",
      "post-full-compaction-first-request",
    ]),
  );
  for (const sample of samples) {
    assert.equal(sample.status.groupAttempt, groupAttempt);
    if (sample.latency.ttftMs !== null) {
      assert.ok(sample.latency.totalMs >= sample.latency.ttftMs);
    }
    assert.ok(sample.usage.versusCold);
    assert.ok(sample.latency.versusCold);
    assert.match(sample.hash.requestSha256, /^[a-f0-9]{64}$/u);
    assert.match(sample.hash.responseSha256, /^[a-f0-9]{64}$/u);
  }
  const cold = requiredScenario(samples, "cold-request");
  const crossSession = requiredScenario(samples, "cross-session");
  assert.equal(
    cold.hash.requestSha256,
    crossSession.hash.requestSha256,
    "cross-Session request must preserve the exact cacheable input",
  );
}

function requiredScenario(
  samples: readonly PromptCacheBenchmarkSample[],
  scenario: PromptCacheBenchmarkSample["status"]["scenario"],
): PromptCacheBenchmarkSample {
  const sample = samples.find((candidate) => candidate.status.scenario === scenario);
  assert.ok(sample);
  return sample;
}

function requiredProtocol(): ProviderKind {
  const value = requiredEnvironment("PROMPT_CACHE_BENCHMARK_PROTOCOL");
  if (value === "claude" || value === "openai") return value;
  throw new Error("PROMPT_CACHE_BENCHMARK_PROTOCOL must be claude or openai");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`real prompt-cache benchmark requires environment variable ${name}`);
  return value;
}

function requiredNonNegativeNumber(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`real prompt-cache benchmark requires ${name} to be a non-negative number`);
  }
  return value;
}
