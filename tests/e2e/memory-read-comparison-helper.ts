import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { PreparedProviderRequest, ProviderPhysicalAttempt } from "@pico/core";
import { countTokens } from "@pico/runtime";

export const MEMORY_READ_GOLD_SHA =
  "9aec13d063bf017a87a38563f38bd52dbabf083a592fe3475c9a70097f32508f";
export const MEMORY_READ_CAPS = Object.freeze({
  runs: 24,
  physical: 120,
  perRunPhysical: 5,
  tools: 4,
  inputPerCall: 20_000,
  outputPerCall: 1024,
  inputTotal: 500_000,
  outputTotal: 24_576,
  deadlineMs: 600_000,
  runMs: 60_000,
});
export interface ComparisonCase {
  id: string;
  group: "short" | "long" | "multi" | "no-hit";
  topic: string;
  question: string;
  items: string[];
  answer: Record<string, unknown>;
  requiredEvidence: string[];
}
export async function readComparisonCases(): Promise<ComparisonCase[]> {
  const raw = await readFile(new URL("./memory-read-comparison-cases.json", import.meta.url));
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    MEMORY_READ_GOLD_SHA,
    "frozen input/gold changed",
  );
  return (JSON.parse(raw.toString()) as { cases: ComparisonCase[] }).cases;
}
export function comparisonPrompt(c: ComparisonCase): string {
  return `${c.question}\n只依据已保存记忆回答；信息不足时可按需要检索，不要猜测，也不要修改或保存记忆。只输出JSON对象 {"answer":{题目指定字段},"quotes":["支持答案的保存原文连续引文"]}。quotes必须是逐字连续原文，保留条件、否定和时间；无信息时quotes为空数组。`;
}
export function scoreComparison(c: ComparisonCase, answer: string) {
  try {
    const parsed: unknown = JSON.parse(answer);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { passed: false, reason: "invalid_object" };
    const value = parsed as { answer?: unknown; quotes?: unknown };
    const quotes =
      Array.isArray(value.quotes) && value.quotes.every((q) => typeof q === "string")
        ? (value.quotes as string[])
        : undefined;
    const answerExact = isDeepStrictEqual(value.answer, c.answer);
    const quotesOriginal =
      !!quotes && quotes.every((q) => q.length > 0 && c.items.some((item) => item.includes(q)));
    const quotesSupport =
      !!quotes && c.requiredEvidence.every((e) => quotes.some((q) => q.includes(e)));
    const noHit = c.group !== "no-hit" || quotes?.length === 0;
    return {
      passed: answerExact && quotesOriginal && quotesSupport && noHit,
      answerExact,
      quotesOriginal,
      quotesSupport,
      noHit,
      parsed,
    };
  } catch {
    return { passed: false, reason: "invalid_json" };
  }
}
export class ComparisonBudgetStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ComparisonBudgetStop";
  }
}
/** Full wire JSON is locally tokenized, not a substitute for vendor-reported usage. */
export class ComparisonBudget {
  physical = 0;
  inputTokens = 0;
  chargedInputTokens = 0;
  reportedInputTokens = 0;
  unknownInputAttempts = 0;
  outputTokens = 0;
  reservedOutput = 0;
  stopped?: string;
  private readonly reservations = new Map<string, { input: number; output: number }>();
  private readonly settled = new Set<string>();
  private readonly startedAt = Date.now();
  assertLive() {
    if (this.stopped) throw new ComparisonBudgetStop(this.stopped);
    if (Date.now() - this.startedAt >= MEMORY_READ_CAPS.deadlineMs) this.stop("suite_deadline");
  }
  stop(reason: string): never {
    this.stopped ??= reason;
    throw new ComparisonBudgetStop(this.stopped);
  }
  reserve(attemptId: string, runCount: number, prepared: PreparedProviderRequest | undefined) {
    this.assertLive();
    if (!prepared) this.stop("missing_actual_prepared_request");
    const tokens = countTokens(JSON.stringify(prepared.body));
    if (tokens > MEMORY_READ_CAPS.inputPerCall) this.stop("input_per_call");
    if (runCount >= MEMORY_READ_CAPS.perRunPhysical || this.physical >= MEMORY_READ_CAPS.physical)
      this.stop("physical_cap");
    if (this.chargedInputTokens + tokens > MEMORY_READ_CAPS.inputTotal)
      this.stop("suite_input_cap");
    if (
      this.outputTokens + this.reservedOutput + MEMORY_READ_CAPS.outputPerCall >
      MEMORY_READ_CAPS.outputTotal
    )
      this.stop("suite_output_cap");
    if (this.reservations.has(attemptId) || this.settled.has(attemptId))
      this.stop("duplicate_attempt");
    this.physical++;
    this.inputTokens += tokens;
    this.chargedInputTokens += tokens;
    this.reservedOutput += MEMORY_READ_CAPS.outputPerCall;
    this.reservations.set(attemptId, { input: tokens, output: MEMORY_READ_CAPS.outputPerCall });
    return tokens;
  }
  settle(attempt: ProviderPhysicalAttempt) {
    if (this.settled.has(attempt.attemptId)) return;
    const reserved = this.reservations.get(attempt.attemptId);
    if (reserved === undefined) {
      this.stopped ??= "unreserved_dispatch";
      return;
    }
    const usage = attempt.usage;
    const inputReported =
      usage &&
      (usage.reportedFields?.includes("prompt") ||
        (!usage.reportedFields && attempt.usageBasis === "reported"));
    const prompt =
      inputReported && Number.isFinite(usage.promptTokens) && usage.promptTokens >= 0
        ? usage.promptTokens
        : undefined;
    if (prompt === undefined) this.unknownInputAttempts++;
    else {
      this.reportedInputTokens += prompt;
      this.chargedInputTokens += Math.max(0, prompt - reserved.input);
      if (
        prompt > MEMORY_READ_CAPS.inputPerCall ||
        this.chargedInputTokens > MEMORY_READ_CAPS.inputTotal
      )
        this.stopped ??= "provider_input_cap_violation_already_spent";
    }
    const outputReported =
      usage &&
      (usage.reportedFields?.includes("completion") ||
        (!usage.reportedFields && attempt.usageBasis === "reported"));
    const completion = outputReported ? usage.completionTokens : undefined;
    const used =
      typeof completion === "number" && Number.isFinite(completion) && completion >= 0
        ? completion
        : reserved.output;
    this.reservedOutput -= reserved.output;
    this.outputTokens += used;
    this.reservations.delete(attempt.attemptId);
    this.settled.add(attempt.attemptId);
    if (
      used > MEMORY_READ_CAPS.outputPerCall ||
      this.outputTokens + this.reservedOutput > MEMORY_READ_CAPS.outputTotal
    )
      this.stopped ??= "provider_output_cap_violation";
  }
  snapshot() {
    return {
      physical: this.physical,
      localPreparedInputTokens: this.inputTokens,
      conservativeChargedInputTokens: this.chargedInputTokens,
      providerReportedInputTokens: this.reportedInputTokens,
      unknownInputAttempts: this.unknownInputAttempts,
      chargedOutputTokens: this.outputTokens,
      unsettledOutputReservation: this.reservedOutput,
      stopped: this.stopped ?? null,
    };
  }
}
