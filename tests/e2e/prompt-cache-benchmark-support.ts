import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  estimateCost,
  type BillingRoute,
  type CostStatus,
} from "../../src/observability/pricing.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import type { ProviderKind } from "../../src/provider/factory.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { toCanonicalUsage, type Message, type ToolDefinition } from "../../src/schema/message.js";

export type PromptCacheBenchmarkScenario =
  | "cold-request"
  | "consecutive-tool-rounds"
  | "cross-session"
  | "post-full-compaction-first-request";

export type PromptCacheBenchmarkPhase = "request" | "round-1" | "round-2";

export interface PromptCacheBenchmarkSample {
  readonly model: string;
  readonly protocol: ProviderKind;
  readonly status: {
    readonly scenario: PromptCacheBenchmarkScenario;
    readonly phase: PromptCacheBenchmarkPhase;
    readonly cacheExpectation: "cold" | "warm" | "boundary";
    readonly cacheObservation: "read" | "write" | "read-write" | "none" | "unreported";
    readonly outcome: "succeeded";
    readonly groupAttempt: number;
  };
  readonly usage: {
    readonly reported: boolean;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
    readonly cacheReadRatio: number | null;
    readonly cost: {
      readonly status: CostStatus;
      readonly usd: number;
    };
    readonly versusCold: {
      readonly cacheReadTokensDelta: number;
      readonly cacheReadRatioDelta: number | null;
      readonly costUsdDelta: number;
      readonly costRatio: number | null;
    } | null;
  };
  readonly latency: {
    readonly totalMs: number;
    readonly ttftMs: number | null;
    readonly versusCold: {
      readonly totalMsDelta: number;
      readonly ttftMsDelta: number | null;
      readonly totalRatio: number | null;
      readonly ttftRatio: number | null;
    } | null;
  };
  readonly hash: {
    readonly requestSha256: string;
    readonly responseSha256: string;
  };
}

export interface MeasurePromptCacheBenchmarkRequest {
  readonly provider: LLMProvider;
  readonly billingRoute: BillingRoute;
  readonly model: string;
  readonly protocol: ProviderKind;
  readonly scenario: PromptCacheBenchmarkScenario;
  readonly phase: PromptCacheBenchmarkPhase;
  readonly groupAttempt: number;
  readonly messages: Message[];
  readonly tools: ToolDefinition[];
  readonly requestOptions?: LLMProviderRequestOptions;
  readonly now?: () => number;
}

export type PromptCacheBenchmarkFailureKind = "credential" | "quota" | "protocol" | "transport";

export interface PromptCacheBenchmarkFailureDescriptor {
  readonly kind: PromptCacheBenchmarkFailureKind;
  readonly statusCode?: number;
}

export class SafePromptCacheBenchmarkFailure extends Error {
  constructor(
    readonly failure: PromptCacheBenchmarkFailureDescriptor,
    readonly groupAttempt: number,
  ) {
    super(
      [
        "prompt-cache benchmark group failed",
        `kind=${failure.kind}`,
        `attempt=${groupAttempt}`,
        ...(failure.statusCode === undefined ? [] : [`status=${failure.statusCode}`]),
        "detail=omitted",
      ].join("; "),
    );
    this.name = "SafePromptCacheBenchmarkFailure";
  }
}

export async function measurePromptCacheBenchmarkRequest(
  input: MeasurePromptCacheBenchmarkRequest,
): Promise<PromptCacheBenchmarkSample> {
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  let firstTokenAt: number | undefined;
  const onDelta = (delta: string): void => {
    if (delta.length > 0 && firstTokenAt === undefined) firstTokenAt = now();
  };
  const response = input.provider.generateStream
    ? await input.provider.generateStream(
        input.messages,
        input.tools,
        onDelta,
        input.requestOptions,
      )
    : await input.provider.generate(input.messages, input.tools, input.requestOptions);
  const completedAt = now();
  const canonical = response.usage ? toCanonicalUsage(response.usage) : undefined;
  const cost = response.usage
    ? estimateCost(input.billingRoute, response.usage)
    : {
        status: "unknown" as const,
        costUSD: 0,
      };
  const totalPromptTokens = canonical?.totalPromptTokens ?? 0;

  return {
    model: input.model,
    protocol: input.protocol,
    status: {
      scenario: input.scenario,
      phase: input.phase,
      cacheExpectation: cacheExpectation(input.scenario),
      cacheObservation: cacheObservation(response.usage),
      outcome: "succeeded",
      groupAttempt: input.groupAttempt,
    },
    usage: {
      reported: response.usage !== undefined,
      inputTokens: canonical?.inputTokens ?? 0,
      outputTokens: canonical?.outputTokens ?? 0,
      cacheReadTokens: canonical?.cacheReadTokens ?? 0,
      cacheWriteTokens: canonical?.cacheWriteTokens ?? 0,
      reasoningTokens: canonical?.reasoningTokens ?? 0,
      cacheReadRatio:
        canonical && totalPromptTokens > 0
          ? round(canonical.cacheReadTokens / totalPromptTokens)
          : null,
      cost: {
        status: cost.status,
        usd: round(cost.costUSD, 9),
      },
      versusCold: null,
    },
    latency: {
      totalMs: round(completedAt - startedAt, 3),
      ttftMs: firstTokenAt === undefined ? null : round(firstTokenAt - startedAt, 3),
      versusCold: null,
    },
    hash: {
      requestSha256: sha256({
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.requestOptions?.toolChoice,
      }),
      responseSha256: sha256({
        role: response.role,
        content: response.content,
        toolCalls: response.toolCalls,
      }),
    },
  };
}

export function comparePromptCacheBenchmarkToCold(
  samples: readonly PromptCacheBenchmarkSample[],
): PromptCacheBenchmarkSample[] {
  const cold = samples.find(
    (sample) => sample.status.scenario === "cold-request" && sample.status.phase === "request",
  );
  if (!cold) {
    throw new Error("prompt-cache benchmark requires one cold-request baseline");
  }

  return samples.map((sample) => ({
    ...sample,
    usage: {
      ...sample.usage,
      versusCold: {
        cacheReadTokensDelta: sample.usage.cacheReadTokens - cold.usage.cacheReadTokens,
        cacheReadRatioDelta: nullableDifference(
          sample.usage.cacheReadRatio,
          cold.usage.cacheReadRatio,
        ),
        costUsdDelta: round(sample.usage.cost.usd - cold.usage.cost.usd, 9),
        costRatio: nullableRatio(sample.usage.cost.usd, cold.usage.cost.usd),
      },
    },
    latency: {
      ...sample.latency,
      versusCold: {
        totalMsDelta: round(sample.latency.totalMs - cold.latency.totalMs, 3),
        ttftMsDelta: nullableDifference(sample.latency.ttftMs, cold.latency.ttftMs, 3),
        totalRatio: nullableRatio(sample.latency.totalMs, cold.latency.totalMs),
        ttftRatio: nullableRatio(sample.latency.ttftMs, cold.latency.ttftMs),
      },
    },
  }));
}

/**
 * Rebuild the JSON shape field by field. Callers cannot smuggle prompts, responses,
 * headers, credentials, or arbitrary diagnostic fields into benchmark output.
 */
export function serializePromptCacheBenchmarkSample(sample: PromptCacheBenchmarkSample): string {
  return JSON.stringify({
    model: sample.model,
    protocol: sample.protocol,
    status: {
      scenario: sample.status.scenario,
      phase: sample.status.phase,
      cacheExpectation: sample.status.cacheExpectation,
      cacheObservation: sample.status.cacheObservation,
      outcome: sample.status.outcome,
      groupAttempt: sample.status.groupAttempt,
    },
    usage: {
      reported: sample.usage.reported,
      inputTokens: sample.usage.inputTokens,
      outputTokens: sample.usage.outputTokens,
      cacheReadTokens: sample.usage.cacheReadTokens,
      cacheWriteTokens: sample.usage.cacheWriteTokens,
      reasoningTokens: sample.usage.reasoningTokens,
      cacheReadRatio: sample.usage.cacheReadRatio,
      cost: {
        status: sample.usage.cost.status,
        usd: sample.usage.cost.usd,
      },
      versusCold: sample.usage.versusCold
        ? {
            cacheReadTokensDelta: sample.usage.versusCold.cacheReadTokensDelta,
            cacheReadRatioDelta: sample.usage.versusCold.cacheReadRatioDelta,
            costUsdDelta: sample.usage.versusCold.costUsdDelta,
            costRatio: sample.usage.versusCold.costRatio,
          }
        : null,
    },
    latency: {
      totalMs: sample.latency.totalMs,
      ttftMs: sample.latency.ttftMs,
      versusCold: sample.latency.versusCold
        ? {
            totalMsDelta: sample.latency.versusCold.totalMsDelta,
            ttftMsDelta: sample.latency.versusCold.ttftMsDelta,
            totalRatio: sample.latency.versusCold.totalRatio,
            ttftRatio: sample.latency.versusCold.ttftRatio,
          }
        : null,
    },
    hash: {
      requestSha256: sample.hash.requestSha256,
      responseSha256: sample.hash.responseSha256,
    },
  });
}

export async function runPromptCacheBenchmarkGroup<T>(
  runGroup: (groupAttempt: number) => Promise<T>,
): Promise<{ readonly groupAttempt: number; readonly value: T }> {
  for (let groupAttempt = 1; groupAttempt <= 2; groupAttempt++) {
    try {
      return { groupAttempt, value: await runGroup(groupAttempt) };
    } catch (error) {
      const failure = classifyPromptCacheBenchmarkFailure(error);
      if (failure.kind === "transport" && groupAttempt === 1) continue;
      throw new SafePromptCacheBenchmarkFailure(failure, groupAttempt);
    }
  }
  throw new Error("unreachable prompt-cache benchmark retry state");
}

export function classifyPromptCacheBenchmarkFailure(
  error: unknown,
): PromptCacheBenchmarkFailureDescriptor {
  if (error instanceof LLMStatusError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return { kind: "credential", statusCode: error.statusCode };
    }
    if (error.statusCode === 402 || error.statusCode === 429) {
      return { kind: "quota", statusCode: error.statusCode };
    }
    return { kind: "protocol", statusCode: error.statusCode };
  }
  if (isTransportFailure(error)) return { kind: "transport" };
  return { kind: "protocol" };
}

function cacheExpectation(
  scenario: PromptCacheBenchmarkScenario,
): PromptCacheBenchmarkSample["status"]["cacheExpectation"] {
  if (scenario === "cold-request") return "cold";
  if (scenario === "post-full-compaction-first-request") return "boundary";
  return "warm";
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  const directCode = objectStringField(error, "code");
  const cause = objectField(error, "cause");
  const causeCode = objectStringField(cause, "code");
  return [directCode, causeCode].some((code) => code !== undefined && TRANSPORT_CODES.has(code));
}

function cacheObservation(
  usage: Message["usage"],
): PromptCacheBenchmarkSample["status"]["cacheObservation"] {
  const read = (usage?.cacheReadTokens ?? 0) > 0;
  const write = (usage?.cacheWriteTokens ?? 0) > 0;
  if (read && write) return "read-write";
  if (read) return "read";
  if (write) return "write";
  const reported = new Set(usage?.reportedFields ?? []);
  return reported.has("cacheRead") || reported.has("cacheWrite") ? "none" : "unreported";
}

const TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function objectStringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nullableDifference(
  value: number | null,
  baseline: number | null,
  digits = 6,
): number | null {
  return value === null || baseline === null ? null : round(value - baseline, digits);
}

function nullableRatio(value: number | null, baseline: number | null): number | null {
  if (value === null || baseline === null || baseline === 0) return null;
  return round(value / baseline);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
