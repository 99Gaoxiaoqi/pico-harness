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

export type CacheColdStartReason =
  | "initial_cold_request"
  | "tool_disclosure_or_schema_revision"
  | "prompt_revision"
  | "full_compaction_or_history_rewrite"
  | "model_switch"
  | "ttl_or_route_expiry_suspected";

export type CacheOperationalAlertKind =
  | "cache_write_dominates"
  | "prefix_stability_declining"
  | "route_zero_hits";

export interface CacheOperationalAlert {
  kind: CacheOperationalAlertKind;
  message: string;
  evidence: Readonly<Record<string, number | string>>;
}

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
  coldStarts: {
    total: number;
    byReason: Record<CacheColdStartReason, number>;
  };
  /** Advisory only. No alert mutates routing or cache policy. */
  operationalAlerts: CacheOperationalAlert[];
}

const LAYERS: readonly PreparedRequestCacheBreakpointLayer[] = ["tools", "tools+system", "history"];

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
  const coldStartByReason = Object.fromEntries(
    (
      [
        "initial_cold_request",
        "tool_disclosure_or_schema_revision",
        "prompt_revision",
        "full_compaction_or_history_rewrite",
        "model_switch",
        "ttl_or_route_expiry_suspected",
      ] as const
    ).map((reason) => [reason, 0]),
  ) as Record<CacheColdStartReason, number>;
  countModelSwitches(records, coldStartByReason);

  let usageReportedCallCount = 0;
  let cacheReadReportedCallCount = 0;
  let cacheWriteReportedCallCount = 0;
  let hitCallCount = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let uncachedInputTokens = 0;
  let uncachedInputReportedCallCount = 0;

  for (const record of records) {
    const reported = reportedFields(record);
    const usageReported = record.reported?.["usageMetadata"] === "reported";
    if (usageReported) {
      usageReportedCallCount++;
      if (reported.has("input") || (reported.has("prompt") && reported.has("cacheRead"))) {
        uncachedInputReportedCallCount++;
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
    }

    const cacheClassification = cacheDiagnosticClassification(record, reported);
    if (cacheClassification) diagnostics[cacheClassification]++;
    const requestDiagnostic = record.reported?.["requestDiagnostic"];
    if (
      cacheClassification === "ttl_or_route_suspected" &&
      (!isRecord(requestDiagnostic) || requestDiagnostic["changeReason"] !== "first_request")
    ) {
      coldStartByReason.ttl_or_route_expiry_suspected++;
    }
    if (!parsePreparedRequestCapture(requestDiagnostic) || !isRecord(requestDiagnostic)) continue;
    if (requestDiagnostic["changeReason"] === "first_request") {
      coldStartByReason.initial_cold_request++;
    }
    const rawComparisons = requestDiagnostic["cacheBreakpointComparisons"];
    if (!Array.isArray(rawComparisons)) continue;
    const structuralReason = structuralColdStartReason(rawComparisons, requestDiagnostic);
    if (structuralReason) coldStartByReason[structuralReason]++;

    const semanticFirstChangedLayer = firstChangedLayerFromDiagnostic(requestDiagnostic);
    if (semanticFirstChangedLayer) firstChangedLayer[semanticFirstChangedLayer]++;
    let firstChangeRecorded = semanticFirstChangedLayer !== undefined;
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

  const allCallsReportedUsage = records.length > 0 && usageReportedCallCount === records.length;
  const cacheReadKnown = allCallsReportedUsage && cacheReadReportedCallCount === records.length;
  const cacheWriteKnown = allCallsReportedUsage && cacheWriteReportedCallCount === records.length;
  const uncachedInputKnown =
    allCallsReportedUsage && uncachedInputReportedCallCount === records.length;
  const promptTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const coldStartTotal = Object.values(coldStartByReason).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    source: "provider_calls_only",
    providerCallCount: records.length,
    usageReportedCallCount,
    cacheReadReportedCallCount,
    cacheWriteReportedCallCount,
    hitCallCount,
    requestHitRate: cacheReadKnown ? hitCallCount / records.length : null,
    promptTokenReuseRate:
      cacheReadKnown && uncachedInputKnown && promptTokens > 0
        ? cacheReadTokens / promptTokens
        : null,
    cacheReadToWriteRatio:
      cacheReadKnown && cacheWriteKnown && cacheWriteTokens > 0
        ? cacheReadTokens / cacheWriteTokens
        : null,
    cacheReadTokens: cacheReadKnown ? cacheReadTokens : null,
    cacheWriteTokens: cacheWriteKnown ? cacheWriteTokens : null,
    uncachedInputTokens: uncachedInputKnown ? uncachedInputTokens : null,
    prefixStability,
    firstChangedLayer,
    diagnostics,
    coldStarts: { total: coldStartTotal, byReason: coldStartByReason },
    operationalAlerts: operationalAlerts(records, prefixStability),
  };
}

function countModelSwitches(
  records: readonly ProviderCallRecord[],
  reasons: Record<CacheColdStartReason, number>,
): void {
  const sequences = new Map<string, ProviderCallRecord[]>();
  for (const record of records) {
    // Never infer a model switch by interleaving unrelated sessions in a workspace-wide report.
    const sessionScope = record.sessionId ?? record.conversationId ?? "__unscoped__";
    const sequenceId = [
      sessionScope,
      record.purpose,
      record.jobId ?? "",
      record.attemptId ?? "",
    ].join("\0");
    const sequence = sequences.get(sequenceId) ?? [];
    sequence.push(record);
    sequences.set(sequenceId, sequence);
  }
  for (const sequence of sequences.values()) {
    const ordered = sequence.sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        (left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0),
    );
    let previous: string | undefined;
    for (const record of ordered) {
      const current = `${record.provider}\0${record.model}\0${record.route ?? ""}`;
      if (previous !== undefined && current !== previous) reasons.model_switch++;
      previous = current;
    }
  }
}

function structuralColdStartReason(
  comparisons: readonly unknown[],
  diagnostic: Readonly<Record<string, unknown>>,
):
  | Exclude<
      CacheColdStartReason,
      "initial_cold_request" | "model_switch" | "ttl_or_route_expiry_suspected"
    >
  | undefined {
  if (diagnostic["structuralChangeReason"] === "full_compaction_summary_added_or_revised") {
    return "full_compaction_or_history_rewrite";
  }
  const firstChangedSegment = diagnostic["firstChangedCacheableSegment"];
  if (isRecord(firstChangedSegment)) {
    if (firstChangedSegment["kind"] === "tool_schema") {
      return "tool_disclosure_or_schema_revision";
    }
    if (firstChangedSegment["kind"] === "system_prompt") return "prompt_revision";
  }
  for (const layer of LAYERS) {
    const comparison = comparisons.find(
      (candidate) => isRecord(candidate) && candidate["layer"] === layer,
    );
    if (!isRecord(comparison)) continue;
    const reason = comparison["changeReason"];
    if (reason !== "changed" && reason !== "added" && reason !== "removed") continue;
    if (layer === "tools") return "tool_disclosure_or_schema_revision";
    if (layer === "tools+system") return "prompt_revision";
    const prior = isRecord(comparison["prior"]) ? comparison["prior"] : undefined;
    const current = isRecord(comparison["current"]) ? comparison["current"] : undefined;
    const priorBytes = prior?.["bytes"];
    const currentBytes = current?.["bytes"];
    if (
      reason === "removed" ||
      (reason === "changed" &&
        typeof priorBytes === "number" &&
        typeof currentBytes === "number" &&
        currentBytes < priorBytes * 0.8)
    ) {
      return "full_compaction_or_history_rewrite";
    }
  }
  return undefined;
}

function firstChangedLayerFromDiagnostic(
  diagnostic: Readonly<Record<string, unknown>>,
): PreparedRequestCacheBreakpointLayer | undefined {
  const segment = diagnostic["firstChangedCacheableSegment"];
  if (!isRecord(segment)) return undefined;
  if (segment["kind"] === "tool_schema") return "tools";
  if (segment["kind"] === "system_prompt") return "tools+system";
  if (segment["kind"] === "message") return "history";
  return undefined;
}

function operationalAlerts(
  records: readonly ProviderCallRecord[],
  prefixStability: CacheEffectiveness["prefixStability"],
): CacheOperationalAlert[] {
  const alerts: CacheOperationalAlert[] = [];
  const routes = new Map<string, ProviderCallRecord[]>();
  for (const record of records) {
    const key = `${record.provider}\0${record.model}\0${record.route ?? ""}`;
    const group = routes.get(key) ?? [];
    group.push(record);
    routes.set(key, group);
  }
  for (const group of routes.values()) {
    const reported = group
      .filter((record) => record.reported?.["usageMetadata"] === "reported")
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          (left.callId < right.callId ? -1 : left.callId > right.callId ? 1 : 0),
      );
    if (reported.length < 3) continue;
    const recent = reported.slice(-3);
    const readKnown =
      reported.length === group.length &&
      reported.every((record) => reportedFields(record).has("cacheRead"));
    const writeKnown =
      reported.length === group.length &&
      reported.every((record) => reportedFields(record).has("cacheWrite"));
    const cacheReadTokens = reported.reduce((total, record) => total + record.cacheReadTokens, 0);
    const cacheWriteTokens = reported.reduce((total, record) => total + record.cacheWriteTokens, 0);
    const promptTokens = reported.reduce(
      (total, record) =>
        total + record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens,
      0,
    );
    const first = reported[0];
    if (!first) continue;
    const minimumCacheTokens = cacheMinimumTokens(first);
    const routeLabel = `${first.provider}/${first.model}`;
    if (
      minimumCacheTokens !== undefined &&
      readKnown &&
      writeKnown &&
      recent.every(
        (record) =>
          reportedFields(record).has("cacheRead") &&
          reportedFields(record).has("cacheWrite") &&
          record.cacheWriteTokens > record.cacheReadTokens,
      ) &&
      recent.reduce((total, record) => total + record.cacheWriteTokens, 0) >= minimumCacheTokens
    ) {
      alerts.push({
        kind: "cache_write_dominates",
        message: `路由 ${routeLabel} 的缓存写入持续高于读取，请检查前缀稳定性、TTL 与路由黏性。`,
        evidence: { route: routeLabel, calls: reported.length, cacheReadTokens, cacheWriteTokens },
      });
    }
    const unsupported = reported.every(
      (record) => record.reported?.["cacheSupport"] === "unsupported",
    );
    if (
      minimumCacheTokens !== undefined &&
      readKnown &&
      recent.every(
        (record) =>
          reportedFields(record).has("cacheRead") &&
          record.cacheReadTokens === 0 &&
          record.inputTokens + record.cacheWriteTokens >= minimumCacheTokens,
      ) &&
      !unsupported &&
      cacheReadTokens === 0
    ) {
      alerts.push({
        kind: "route_zero_hits",
        message: `路由 ${routeLabel} 已连续产生足量请求但仍无缓存读取，请核查协议支持与路由身份。`,
        evidence: { route: routeLabel, calls: reported.length, promptTokens },
      });
    }
  }
  for (const layer of LAYERS) {
    const value = prefixStability[layer];
    const comparable = value.stable + value.changed + value.added + value.removed;
    if (comparable >= 3 && value.stabilityRate !== null && value.stabilityRate < 0.8) {
      alerts.push({
        kind: "prefix_stability_declining",
        message: `缓存前缀层 ${layer} 在观测窗口内稳定率偏低，请检查工具披露、Prompt revision 或压缩边界。`,
        evidence: { layer, comparisons: comparable, stabilityRate: value.stabilityRate },
      });
    }
  }
  return alerts;
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
  const minimum = cacheMinimumTokens(record);
  if (minimum === undefined) return undefined;
  const promptTokens = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens;
  if (promptTokens < minimum) return "prompt_below_minimum_threshold";
  const diagnostic = record.reported?.["requestDiagnostic"];
  if (isRecord(diagnostic) && diagnostic["changeReason"] === "first_request") {
    return undefined;
  }
  if (isRecord(diagnostic) && diagnostic["changeReason"] === "cacheable_prefix_changed") {
    return "stable_prefix_changed";
  }
  return "ttl_or_route_suspected";
}

/** Known official minima only; compatible or unknown model names remain unclassified. */
function cacheMinimumTokens(
  record: Pick<ProviderCallRecord, "provider" | "model">,
): number | undefined {
  const provider = record.provider.toLowerCase();
  const model = record.model.toLowerCase();
  const geminiFamily = provider === "gemini" || model.includes("gemini-");
  if (geminiFamily) {
    if (/gemini-(?:3\.5-flash|3\.1-pro)/u.test(model)) return 4_096;
    if (/gemini-2\.5/u.test(model)) return 2_048;
    return undefined;
  }
  const claudeFamily = provider === "claude" || model.includes("claude-");
  if (!claudeFamily) return provider === "openai" ? 1_024 : undefined;
  if (/claude-(?:opus-4[.-](?:5|6)|haiku-4[.-]5)/u.test(model)) return 4_096;
  if (/claude-(?:opus-4[.-]7|haiku-3[.-]5|mythos-preview)/u.test(model)) return 2_048;
  if (/claude-(?:fable-5|mythos-5)/u.test(model)) return 512;
  if (
    /claude-(?:opus-4[.-]8|sonnet-5|sonnet-4[.-][456]|opus-4[.-]1|opus-4(?:$|-)|sonnet-4(?:$|-))/u.test(
      model,
    )
  ) {
    return 1_024;
  }
  return undefined;
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
