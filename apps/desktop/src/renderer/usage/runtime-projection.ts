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
  const usage = isRecord(result.usage) ? result.usage : {};
  const total = isRecord(usage.total) ? usage.total : {};
  const cache = isRecord(usage.cache) ? usage.cache : {};
  const unavailableWorkspaces = recordArray(usage.unavailableWorkspaces);
  // Cache metrics are provider_calls-only. Baselines lack per-call coverage and must not be mixed
  // into the cache token cards or ratios.
  const cacheReadTokens = optionalNumberValue(cache.cacheReadTokens);
  const cacheWriteTokens = optionalNumberValue(cache.cacheWriteTokens);
  const cacheAlerts = recordArray(cache.operationalAlerts)
    .map((alert) => stringValue(alert.message))
    .filter((message) => message.length > 0);
  return {
    ...(usage.details === undefined ? {} : { details: parseUsageDashboard(usage.details) }),
    totalTokens: optionalNumberValue(total.totalTokens),
    inputTokens: optionalNumberValue(total.inputTokens),
    outputTokens: optionalNumberValue(total.outputTokens),
    reasoningTokens: optionalNumberValue(total.reasoningTokens),
    cacheReadTokens,
    cacheWriteTokens,
    uncachedInputTokens: optionalNumberValue(cache.uncachedInputTokens),
    cacheRequestHitRate: optionalNumberValue(cache.requestHitRate),
    cachePromptTokenReuseRate: optionalNumberValue(cache.promptTokenReuseRate),
    cacheReadToWriteRatio: optionalNumberValue(cache.cacheReadToWriteRatio),
    ...(cacheAlerts.length > 0 ? { cacheAlerts } : {}),
    costCNY: optionalNumberValue(total.costCNY),
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
    period: stringValue(usage.rangeAccuracy),
  };
}
