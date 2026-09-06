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
  readonly unavailableWorkspaces: readonly {
    readonly workspacePath: string;
    readonly error: string;
  }[];
  /** Known totals remain useful when only some calls reported cache usage. */
  readonly knownCacheReadTokens: number;
  readonly knownCacheWriteTokens: number;
  readonly cacheReadReportedCallCount: number;
  readonly cacheWriteReportedCallCount: number;
  readonly warnings: readonly string[];
}

/** Validate the JSON boundary before renderer components consume usage records. */
export function parseUsageDashboard(value: unknown): UsageDashboardDetails {
  const data = object(value);
  return {
    activities: array(data.activities).map((item): UsageActivity => {
      const row = object(item);
      const kind = choice(row.kind, ["model", "tool"] as const);
      return {
        id: text(row.id),
        kind,
        name: text(row.name),
        workspacePath: text(row.workspacePath),
        ...optionalText(row, "provider"),
        ...optionalText(row, "model"),
        ...optionalText(row, "sessionId"),
        ...optionalText(row, "sessionTitle"),
        at: number(row.at),
        status: choice(row.status, ["success", "error", "aborted", "running"] as const),
        ...tokens(row),
        costStatus: costStatus(row.costStatus),
        ...optionalNumber(row, "costCNY"),
        ...optionalNumber(row, "durationMs"),
      };
    }),
    activityCount: number(data.activityCount),
    activitiesTruncated: boolean(data.activitiesTruncated),
    providers: array(data.providers).map(breakdown),
    models: array(data.models).map(breakdown),
    tools: array(data.tools).map(breakdown),
    pricing: array(data.pricing).map((item): UsagePrice => {
      const row = object(item);
      return {
        provider: text(row.provider),
        model: text(row.model),
        source: choice(row.source, ["configured", "official_docs_snapshot", "included"] as const),
        inputPerMillion: nullableNumber(row.inputPerMillion),
        outputPerMillion: nullableNumber(row.outputPerMillion),
        cacheReadPerMillion: nullableNumber(row.cacheReadPerMillion),
        cacheWritePerMillion: nullableNumber(row.cacheWritePerMillion),
      };
    }),
    unavailableWorkspaces: array(data.unavailableWorkspaces).map((item) => {
      const row = object(item);
      return { workspacePath: text(row.workspacePath), error: text(row.error) };
    }),
    knownCacheReadTokens: number(data.knownCacheReadTokens),
    knownCacheWriteTokens: number(data.knownCacheWriteTokens),
    cacheReadReportedCallCount: number(data.cacheReadReportedCallCount),
    cacheWriteReportedCallCount: number(data.cacheWriteReportedCallCount),
    warnings: array(data.warnings).map(text),
  };
}
function breakdown(value: unknown): UsageBreakdown {
  const row = object(value);
  return {
    id: text(row.id),
    name: text(row.name),
    ...optionalText(row, "provider"),
    count: number(row.count),
    successCount: number(row.successCount),
    errorCount: number(row.errorCount),
    abortedCount: number(row.abortedCount),
    ...tokens(row),
    costStatus: costStatus(row.costStatus),
    ...optionalNumber(row, "costCNY"),
    ...optionalNumber(row, "averageDurationMs"),
  };
}
function tokens(row: Record<string, unknown>) {
  return {
    inputTokens: number(row.inputTokens),
    outputTokens: number(row.outputTokens),
    cacheReadTokens: number(row.cacheReadTokens),
    cacheWriteTokens: number(row.cacheWriteTokens),
    totalTokens: number(row.totalTokens),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid usage object");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid usage list");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid usage text");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("Invalid usage number");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid usage flag");
  return value;
}
function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.some((item) => item === value))
    throw new Error("Invalid usage state");
  return value as T;
}
function costStatus(value: unknown): UsageCostStatus {
  return choice(value, ["none", "estimated", "included", "unknown", "partial"] as const);
}
function optionalText<K extends string>(
  row: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  return row[key] === undefined ? {} : ({ [key]: text(row[key]) } as Record<K, string>);
}
function optionalNumber<K extends string>(
  row: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  return row[key] === undefined ? {} : ({ [key]: number(row[key]) } as Record<K, number>);
}
