export interface UsageLedgerTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
}

export interface UsageBaselineRecord extends UsageLedgerTotals {
  readonly baselineId: string;
  readonly sessionId?: string | undefined;
  readonly importedAt: number;
  readonly source?: Readonly<Record<string, unknown>> | undefined;
}

export interface UsageBaselineSessionPort {
  readonly id: string;
  getRuntimeStateSnapshot(): {
    readonly usage: {
      readonly totalInputTokens: number;
      readonly totalCompletionTokens: number;
      readonly totalCacheReadTokens: number;
      readonly totalCacheWriteTokens: number;
      readonly totalCostCNY: number;
      readonly totalProviderCalls: number;
    };
  };
}

export interface UsageBaselineStorePort {
  getUsageSummary(filter?: { readonly sessionId?: string }): {
    readonly providerCalls: UsageLedgerTotals;
    readonly providerCallCount: number;
  };
  putUsageBaseline(record: UsageBaselineRecord): {
    readonly record: UsageBaselineRecord;
    readonly inserted: boolean;
  };
}

const USAGE_BASELINE_VERSION = 1;

/**
 * Import a Session's pre-ledger totals exactly once, subtracting detailed calls in a crash window.
 */
export function ensureSessionUsageBaseline(
  jobs: UsageBaselineStorePort,
  session: UsageBaselineSessionPort,
): { readonly record: UsageBaselineRecord; readonly inserted: boolean } {
  const runtime = session.getRuntimeStateSnapshot().usage;
  const existingSummary = jobs.getUsageSummary({ sessionId: session.id });
  const detailed = existingSummary.providerCalls;
  const baseline: UsageBaselineRecord = {
    baselineId: `session-usage-v${USAGE_BASELINE_VERSION}:${session.id}`,
    sessionId: session.id,
    inputTokens: difference(runtime.totalInputTokens, detailed.inputTokens),
    outputTokens: difference(runtime.totalCompletionTokens, detailed.outputTokens),
    cacheReadTokens: difference(runtime.totalCacheReadTokens, detailed.cacheReadTokens),
    cacheWriteTokens: difference(runtime.totalCacheWriteTokens, detailed.cacheWriteTokens),
    cost: difference(runtime.totalCostCNY, detailed.cost),
    importedAt: Date.now(),
    source: {
      kind: "session_runtime_usage",
      version: USAGE_BASELINE_VERSION,
      totalProviderCalls: runtime.totalProviderCalls,
      providerCallsAlreadyDetailed: existingSummary.providerCallCount,
    },
  };
  return jobs.putUsageBaseline(baseline);
}

function difference(total: number, detailed: number): number {
  return Math.max(0, total - detailed);
}
