import {
  parsePreparedRequestCapture,
  type PreparedRequestCacheBreakpointChangeReason,
  type PreparedRequestCacheBreakpointLayer,
} from "./provider-request-diagnostics.js";
import type { ProviderCallRecord } from "../tasks/runtime-types.js";

export type CacheDiagnosticClassification =
  | "prompt_below_minimum_threshold"
  | "provider_not_reported"
  | "stable_prefix_changed"
  | "ttl_or_route_suspected"
  | "protocol_unsupported";

export interface CacheEffectivenessLayer {
  observedComparisons: number;
  stable: number;
  changed: number;
  added: number;
  removed: number;
  firstRequest: number;
  priorUnavailable: number;
  stabilityRate: number | null;
}

export interface CacheEffectiveness {
  source: "provider_calls_only";
  providerCallCount: number;
  usageReportedCallCount: number;
  cacheReadReportedCallCount: number;
  cacheWriteReportedCallCount: number;
  hitCallCount: number;
  requestHitRate: number | null;
  promptTokenReuseRate: number | null;
  cacheReadToWriteRatio: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  uncachedInputTokens: number | null;
  prefixStability: Record<PreparedRequestCacheBreakpointLayer, CacheEffectivenessLayer>;
  firstChangedLayer: Record<PreparedRequestCacheBreakpointLayer, number>;
  diagnostics: Record<CacheDiagnosticClassification, number>;
}

const LAYERS: readonly PreparedRequestCacheBreakpointLayer[] = ["tools", "tools+system", "history"];

const MINIMUM_CACHE_TOKENS: Record<string, number> = {
  gemini: 2048,
  openai: 1024,
  claude: 1024,
};

/**
 * 仅基于可逐条核验的 provider_calls 聚合缓存效果。Usage baseline 没有逐调用
 * 指纹和字段覆盖信息，因此调用方不得把 baseline 混入本结果的分母或比率。
 */
export function summarizeCacheEffectiveness(
  records: readonly ProviderCallRecord[],
): CacheEffectiveness {
  const prefixStability = Object.fromEntries(
    LAYERS.map((layer) => [layer, emptyLayer()]),
  ) as Record<PreparedRequestCacheBreakpointLayer, CacheEffectivenessLayer>;
  const firstChangedLayer = Object.fromEntries(LAYERS.map((layer) => [layer, 0])) as Record<
    PreparedRequestCacheBreakpointLayer,
    number
  >;
  const diagnostics = Object.fromEntries(
    (
      [
        "prompt_below_minimum_threshold",
        "provider_not_reported",
        "stable_prefix_changed",
        "ttl_or_route_suspected",
        "protocol_unsupported",
      ] as const
    ).map((classification) => [classification, 0]),
  ) as Record<CacheDiagnosticClassification, number>;

  let usageReportedCallCount = 0;
  let cacheReadReportedCallCount = 0;
  let cacheWriteReportedCallCount = 0;
  let hitCallCount = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let uncachedInputTokens = 0;

  for (const record of records) {
    const reported = reportedFields(record);
    const usageReported = record.reported?.["usageMetadata"] === "reported";
    if (usageReported) {
      usageReportedCallCount++;
      uncachedInputTokens += record.inputTokens;
    }
    if (reported.has("cacheRead")) {
      cacheReadReportedCallCount++;
      cacheReadTokens += record.cacheReadTokens;
      if (record.cacheReadTokens > 0) hitCallCount++;
    }
    if (reported.has("cacheWrite")) {
      cacheWriteReportedCallCount++;
      cacheWriteTokens += record.cacheWriteTokens;
    }

    const cacheClassification = cacheDiagnosticClassification(record, reported);
    if (cacheClassification) diagnostics[cacheClassification]++;
    if (!parsePreparedRequestCapture(record.reported?.["requestDiagnostic"])) continue;
    const rawComparisons = isRecord(record.reported?.["requestDiagnostic"])
      ? record.reported["requestDiagnostic"]["cacheBreakpointComparisons"]
      : undefined;
    if (!Array.isArray(rawComparisons)) continue;

    let firstChangeRecorded = false;
    for (const rawComparison of rawComparisons) {
      if (!isRecord(rawComparison) || !isLayer(rawComparison["layer"])) continue;
      const reason = rawComparison["changeReason"];
      if (!isComparisonReason(reason)) continue;
      const layer = prefixStability[rawComparison["layer"]];
      layer.observedComparisons++;
      incrementLayerReason(layer, reason);
      if (
        !firstChangeRecorded &&
        (reason === "changed" || reason === "added" || reason === "removed")
      ) {
        firstChangedLayer[rawComparison["layer"]]++;
        firstChangeRecorded = true;
      }
    }
  }

  for (const layer of LAYERS) {
    const value = prefixStability[layer];
    const comparable = value.stable + value.changed + value.added + value.removed;
    value.stabilityRate = comparable === 0 ? null : value.stable / comparable;
  }

  const cacheReadKnown =
    usageReportedCallCount > 0 && cacheReadReportedCallCount === usageReportedCallCount;
  const cacheWriteKnown =
    usageReportedCallCount > 0 && cacheWriteReportedCallCount === usageReportedCallCount;
  const promptTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    source: "provider_calls_only",
    providerCallCount: records.length,
    usageReportedCallCount,
    cacheReadReportedCallCount,
    cacheWriteReportedCallCount,
    hitCallCount,
    requestHitRate: cacheReadKnown ? hitCallCount / cacheReadReportedCallCount : null,
    promptTokenReuseRate:
      cacheReadKnown && cacheWriteKnown && promptTokens > 0 ? cacheReadTokens / promptTokens : null,
    cacheReadToWriteRatio:
      cacheReadKnown && cacheWriteKnown && cacheWriteTokens > 0
        ? cacheReadTokens / cacheWriteTokens
        : null,
    cacheReadTokens: cacheReadKnown ? cacheReadTokens : null,
    cacheWriteTokens: cacheWriteKnown ? cacheWriteTokens : null,
    uncachedInputTokens: usageReportedCallCount > 0 ? uncachedInputTokens : null,
    prefixStability,
    firstChangedLayer,
    diagnostics,
  };
}

function emptyLayer(): CacheEffectivenessLayer {
  return {
    observedComparisons: 0,
    stable: 0,
    changed: 0,
    added: 0,
    removed: 0,
    firstRequest: 0,
    priorUnavailable: 0,
    stabilityRate: null,
  };
}

function incrementLayerReason(
  layer: CacheEffectivenessLayer,
  reason: PreparedRequestCacheBreakpointChangeReason,
): void {
  if (reason === "first_request") layer.firstRequest++;
  else if (reason === "prior_unavailable") layer.priorUnavailable++;
  else layer[reason]++;
}

function reportedFields(record: ProviderCallRecord): Set<string> {
  const fields = record.reported?.["reportedFields"];
  return new Set(
    Array.isArray(fields)
      ? fields.filter((field): field is string => typeof field === "string")
      : [],
  );
}

function cacheDiagnosticClassification(
  record: ProviderCallRecord,
  fields: ReadonlySet<string>,
): CacheDiagnosticClassification | undefined {
  if (record.reported?.["cacheSupport"] === "unsupported") return "protocol_unsupported";
  if (!fields.has("cacheRead")) return "provider_not_reported";
  if (record.cacheReadTokens > 0) return undefined;
  const minimum = MINIMUM_CACHE_TOKENS[record.provider] ?? 1024;
  const promptTokens = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens;
  if (promptTokens < minimum) return "prompt_below_minimum_threshold";
  const diagnostic = record.reported?.["requestDiagnostic"];
  if (isRecord(diagnostic) && diagnostic["changeReason"] === "cacheable_prefix_changed") {
    return "stable_prefix_changed";
  }
  return "ttl_or_route_suspected";
}

function isLayer(value: unknown): value is PreparedRequestCacheBreakpointLayer {
  return value === "tools" || value === "tools+system" || value === "history";
}

function isComparisonReason(value: unknown): value is PreparedRequestCacheBreakpointChangeReason {
  return (
    value === "first_request" ||
    value === "prior_unavailable" ||
    value === "stable" ||
    value === "changed" ||
    value === "added" ||
    value === "removed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
