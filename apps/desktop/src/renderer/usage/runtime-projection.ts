import { parseUsageDashboard } from "@pico/protocol";
import type { UsageView } from "../model.js";
import {
  isRecord,
  optionalNumberValue,
  recordArray,
  stringValue,
} from "../runtime-projections/values.js";

export function parseUsage(value: unknown): UsageView {
  const result = isRecord(value) ? value : {};
  const usage = isRecord(result.usage) ? result.usage : result;
  const total = isRecord(usage.total) ? usage.total : usage;
  const cache = isRecord(usage.cache) ? usage.cache : {};
  const unavailableWorkspaces = recordArray(usage.unavailableWorkspaces);
  // Cache metrics are provider_calls-only. Baselines lack per-call coverage and must not be mixed
  // into the cache token cards or ratios.
  const cacheReadTokens = optionalNumberValue(cache.cacheReadTokens ?? cache.cache_read_tokens);
  const cacheWriteTokens = optionalNumberValue(cache.cacheWriteTokens ?? cache.cache_write_tokens);
  const cacheAlerts = recordArray(cache.operationalAlerts)
    .map((alert) => stringValue(alert.message))
    .filter((message) => message.length > 0);
  return {
    ...(usage.details === undefined ? {} : { details: parseUsageDashboard(usage.details) }),
    totalTokens: optionalNumberValue(total.totalTokens),
    inputTokens: optionalNumberValue(total.inputTokens ?? total.input_tokens),
    outputTokens: optionalNumberValue(total.outputTokens ?? total.output_tokens),
    reasoningTokens: optionalNumberValue(total.reasoningTokens),
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens: optionalNumberValue(cache.uncachedInputTokens),
    // cachedTokens is a backwards-compatible view; the canonical daemon field is cacheReadTokens.
    cachedTokens: cacheReadTokens,
    cacheRequestHitRate: optionalNumberValue(cache.requestHitRate),
    cachePromptTokenReuseRate: optionalNumberValue(cache.promptTokenReuseRate),
    cacheReadToWriteRatio: optionalNumberValue(cache.cacheReadToWriteRatio),
    ...(cacheAlerts.length > 0 ? { cacheAlerts } : {}),
    costCNY: optionalNumberValue(total.costCNY ?? total.cost),
    costStatus:
      usage.costStatus === "none" ||
      usage.costStatus === "estimated" ||
      usage.costStatus === "included" ||
      usage.costStatus === "unknown" ||
      usage.costStatus === "partial"
        ? usage.costStatus
        : undefined,
    providerCallCount: optionalNumberValue(usage.providerCallCount),
    usageReportCount: optionalNumberValue(usage.usageReportCount),
    baselineCount: optionalNumberValue(usage.baselineCount),
    scope:
      usage.scope === "all" || usage.scope === "workspace" || usage.scope === "session"
        ? usage.scope
        : undefined,
    workspacePath: stringValue(usage.workspacePath) || undefined,
    unavailableWorkspaceCount: unavailableWorkspaces.length || undefined,
    period: stringValue(usage.period || usage.rangeAccuracy),
  };
}
