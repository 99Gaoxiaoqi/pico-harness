import type { Job, MemoryReviewMode } from "./domain.js";

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface MemoryReviewBudget {
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostUsd: number;
}

export interface MemoryReviewUsageEntry {
  readonly terminalAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface MemoryReviewUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface MemoryReviewBudgetDecision {
  readonly allowed: boolean;
  readonly mode: MemoryReviewMode;
  readonly budget: MemoryReviewBudget;
  readonly usage: MemoryReviewUsage;
  readonly nextRecoveryAt?: string;
  readonly reason?: "eco-mode" | "budget-exhausted";
}

export const MEMORY_REVIEW_BUDGETS: Readonly<Record<MemoryReviewMode, MemoryReviewBudget>> = {
  eco: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 },
  balanced: {
    maxCalls: 8,
    maxInputTokens: 16_000,
    maxOutputTokens: 2_000,
    maxCostUsd: 0.1,
  },
  quality: {
    maxCalls: 16,
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
    maxCostUsd: 0.25,
  },
};

export function evaluateMemoryReviewBudget(
  mode: MemoryReviewMode,
  entries: readonly MemoryReviewUsageEntry[],
  now = new Date(),
): MemoryReviewBudgetDecision {
  const budget = MEMORY_REVIEW_BUDGETS[mode];
  const windowStart = now.getTime() - ROLLING_WINDOW_MS;
  const active = entries
    .map((entry) => ({ ...entry, terminalTime: Date.parse(entry.terminalAt) }))
    .filter(
      (entry) =>
        Number.isFinite(entry.terminalTime) &&
        entry.terminalTime > windowStart &&
        entry.terminalTime <= now.getTime(),
    )
    .sort((left, right) => left.terminalTime - right.terminalTime);
  const usage = summarize(active);
  if (mode === "eco") {
    return { allowed: false, mode, budget, usage, reason: "eco-mode" };
  }
  if (withinBudget(usage, budget)) return { allowed: true, mode, budget, usage };

  let nextRecoveryAt: string | undefined;
  for (let index = 0; index < active.length; index += 1) {
    const remaining = active.slice(index + 1);
    if (withinBudget(summarize(remaining), budget)) {
      nextRecoveryAt = new Date(active[index]!.terminalTime + ROLLING_WINDOW_MS).toISOString();
      break;
    }
  }
  return {
    allowed: false,
    mode,
    budget,
    usage,
    reason: "budget-exhausted",
    ...(nextRecoveryAt ? { nextRecoveryAt } : {}),
  };
}

/** Builds the rolling budget only from completed terminal extraction metadata. */
export function evaluateMemoryReviewBudgetForJobs(
  mode: MemoryReviewMode,
  jobs: readonly Job[],
  now = new Date(),
): MemoryReviewBudgetDecision {
  return evaluateMemoryReviewBudget(
    mode,
    jobs.flatMap((job) =>
      job.type === "terminal-extraction" &&
      (job.status === "succeeded" || job.status === "failed") &&
      job.terminalAt
        ? [
            {
              terminalAt: job.terminalAt,
              inputTokens: job.inputTokens,
              outputTokens: job.outputTokens,
              costUsd: job.costUsd,
            },
          ]
        : [],
    ),
    now,
  );
}

function summarize(
  entries: readonly (MemoryReviewUsageEntry & { readonly terminalTime: number })[],
): MemoryReviewUsage {
  return entries.reduce<MemoryReviewUsage>(
    (usage, entry) => ({
      calls: usage.calls + 1,
      inputTokens: usage.inputTokens + entry.inputTokens,
      outputTokens: usage.outputTokens + entry.outputTokens,
      costUsd: usage.costUsd + entry.costUsd,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

function withinBudget(usage: MemoryReviewUsage, budget: MemoryReviewBudget): boolean {
  return (
    usage.calls < budget.maxCalls &&
    usage.inputTokens < budget.maxInputTokens &&
    usage.outputTokens < budget.maxOutputTokens &&
    usage.costUsd < budget.maxCostUsd
  );
}
