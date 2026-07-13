import type { Session } from "../engine/session.js";
import type {
  UsageBaselineRecord,
  UsageLedgerFilter,
  UsageLedgerSummary,
  UsageLedgerTotals,
} from "../tasks/runtime-types.js";

const USAGE_BASELINE_VERSION = 1;

/**
 * 首次启用逐调用账本时，把 Session 里已有累计值导入一次。
 * 若崩溃窗口内已经落过 provider_calls，则只导入累计值与明细的差额，避免双计。
 */
export function ensureSessionUsageBaseline(
  jobs: UsageBaselineStore,
  session: Session,
): { record: UsageBaselineRecord; inserted: boolean } {
  const runtime = session.getRuntimeStateSnapshot().usage;
  const existingSummary = jobs.getUsageSummary({ sessionId: session.id });
  const detailed = existingSummary.providerCalls;
  const sessionTotals: UsageLedgerTotals = {
    inputTokens: runtime.totalInputTokens,
    outputTokens: runtime.totalCompletionTokens,
    cacheReadTokens: runtime.totalCacheReadTokens,
    cacheWriteTokens: runtime.totalCacheWriteTokens,
    cost: runtime.totalCostCNY,
  };
  const baseline: UsageBaselineRecord = {
    baselineId: `session-usage-v${USAGE_BASELINE_VERSION}:${session.id}`,
    sessionId: session.id,
    inputTokens: difference(sessionTotals.inputTokens, detailed.inputTokens),
    outputTokens: difference(sessionTotals.outputTokens, detailed.outputTokens),
    cacheReadTokens: difference(sessionTotals.cacheReadTokens, detailed.cacheReadTokens),
    cacheWriteTokens: difference(sessionTotals.cacheWriteTokens, detailed.cacheWriteTokens),
    cost: difference(sessionTotals.cost, detailed.cost),
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

export interface UsageBaselineStore {
  getUsageSummary(filter?: UsageLedgerFilter): UsageLedgerSummary;
  putUsageBaseline(record: UsageBaselineRecord): {
    record: UsageBaselineRecord;
    inserted: boolean;
  };
}

function difference(total: number, detailed: number): number {
  return Math.max(0, total - detailed);
}
