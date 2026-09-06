/** Desktop usage views. Amounts are local estimates in CNY, never provider invoices. */
export type UsageCostStatus = "none" | "estimated" | "included" | "unknown" | "partial";

export interface UsageActivity {
  readonly id: string;
  readonly kind: "model" | "tool";
  readonly name: string;
  readonly provider?: string;
  readonly model?: string;
  readonly workspacePath: string;
  readonly sessionId?: string;
  readonly sessionTitle?: string;
  readonly at: number;
  readonly status: "success" | "error" | "aborted" | "running";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costCNY?: number;
  readonly costStatus: UsageCostStatus;
  readonly durationMs?: number;
}

export interface UsageBreakdown {
  readonly id: string;
  readonly name: string;
  readonly provider?: string;
  readonly count: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly abortedCount: number;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costCNY?: number;
  readonly costStatus: UsageCostStatus;
  readonly averageDurationMs?: number;
}

export interface UsagePrice {
  readonly provider: string;
  readonly model: string;
  readonly source: "configured" | "official_docs_snapshot" | "included";
  /** USD per million tokens, matching the billing configuration. */
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly cacheReadPerMillion: number | null;
  readonly cacheWritePerMillion: number | null;
}

export interface UsageDashboardDetails {
  readonly activities: readonly UsageActivity[];
  readonly activityCount: number;
  readonly activitiesTruncated: boolean;
  readonly providers: readonly UsageBreakdown[];
  readonly models: readonly UsageBreakdown[];
  readonly tools: readonly UsageBreakdown[];
  readonly pricing: readonly UsagePrice[];
  readonly unavailableWorkspaces: readonly { readonly workspacePath: string; readonly error: string }[];
  /** Known totals remain useful when only some calls reported cache usage. */
  readonly knownCacheReadTokens: number;
  readonly knownCacheWriteTokens: number;
  readonly cacheReadReportedCallCount: number;
  readonly cacheWriteReportedCallCount: number;
  readonly warnings: readonly string[];
}
