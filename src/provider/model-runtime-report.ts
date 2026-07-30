import {
  DEFAULT_SAFETY_MARGIN_TOKENS,
  estimateModelInputTokens,
  type ContextBudget,
} from "../context/context-budget.js";
import type {
  SessionRuntimeStateSnapshot,
  SessionUsageSnapshot,
} from "../engine/session-runtime.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { ModelRoute } from "./model-router.js";

export type MeasurementStatus = "reported" | "partial" | "unknown";

export interface ModelRuntimeSource {
  getRuntimeStateSnapshot(): SessionRuntimeStateSnapshot;
  getHistory(): Message[];
}

export interface UsageFieldReport {
  value: number | null;
  status: MeasurementStatus;
  reportedCalls: number;
  totalCalls: number;
}

export interface ModelUsageReport {
  routeId: string;
  providerCalls: number;
  usageReports: number;
  fields: {
    promptTokens: UsageFieldReport;
    completionTokens: UsageFieldReport;
    inputTokens: UsageFieldReport;
    cacheReadTokens: UsageFieldReport;
    cacheWriteTokens: UsageFieldReport;
    reasoningTokens: UsageFieldReport;
  };
  cache: {
    requestHitRate: number | null;
    promptTokenReuseRate: number | null;
    cacheReadToWriteRatio: number | null;
    uncachedInputTokens: UsageFieldReport;
  };
  cost: {
    cny: number | null;
    status: "estimated" | "included" | "partial" | "unknown";
    priceSource: "config" | "unknown";
  };
}

export interface ModelContextReport {
  routeId: string;
  estimatedInputTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
  remainingTokens: number;
  usedPercent: number;
  estimation: "estimated";
  contextLimitSource: "config" | "profile_default";
  outputLimitSource: "config" | "profile_default";
  capabilities: {
    vision: boolean | "unknown";
    reasoning: boolean | "unknown";
    toolCall: boolean | "unknown";
    cache: boolean | "unknown";
  };
}

export class ModelRuntimeCommandService {
  constructor(
    private readonly route: ModelRoute,
    private readonly runtime: ModelRuntimeSource,
    private readonly tools: readonly ToolDefinition[] = [],
    private readonly budget?: ContextBudget,
  ) {}

  usage(): ModelUsageReport {
    return createModelUsageReport(this.route, this.runtime.getRuntimeStateSnapshot().usage);
  }

  context(): ModelContextReport {
    return createModelContextReport(this.route, this.runtime.getHistory(), this.tools, this.budget);
  }

  execute(command: "usage" | "context"): {
    message: string;
    data: ModelUsageReport | ModelContextReport;
  } {
    if (command === "usage") {
      const data = this.usage();
      return { message: formatModelUsageReport(data), data };
    }
    const data = this.context();
    return { message: formatModelContextReport(data), data };
  }
}

export function createModelUsageReport(
  route: ModelRoute,
  usage: SessionUsageSnapshot,
): ModelUsageReport {
  const totalCalls = usage.totalProviderCalls;
  const usageReports = usage.totalUsageReports;
  const inputTokens = usageField(usage.totalInputTokens, usage.totalInputReports, totalCalls);
  const cacheReadTokens = usageField(
    usage.totalCacheReadTokens,
    usage.totalCacheReadReports,
    totalCalls,
  );
  const cacheWriteTokens = usageField(
    usage.totalCacheWriteTokens,
    usage.totalCacheWriteReports,
    totalCalls,
  );
  const promptTokens = usageField(usage.totalPromptTokens, usageReports, totalCalls);
  const cacheReadCoverageComplete =
    totalCalls > 0 &&
    usage.totalCacheReadReports === totalCalls &&
    usage.totalCacheHitCalls !== null;
  return {
    routeId: route.id,
    providerCalls: totalCalls,
    usageReports,
    fields: {
      promptTokens,
      completionTokens: usageField(usage.totalCompletionTokens, usageReports, totalCalls),
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: usageField(
        usage.totalReasoningTokens,
        usage.totalReasoningReports,
        totalCalls,
      ),
    },
    cache: {
      requestHitRate: cacheReadCoverageComplete
        ? (usage.totalCacheHitCalls ?? 0) / usage.totalCacheReadReports
        : null,
      promptTokenReuseRate:
        promptTokens.status !== "reported" ||
        cacheReadTokens.status !== "reported" ||
        promptTokens.value === null ||
        cacheReadTokens.value === null ||
        promptTokens.value === 0
          ? null
          : cacheReadTokens.value / promptTokens.value,
      cacheReadToWriteRatio:
        cacheReadTokens.status !== "reported" ||
        cacheWriteTokens.status !== "reported" ||
        cacheReadTokens.value === null ||
        cacheWriteTokens.value === null ||
        cacheWriteTokens.value === 0
          ? null
          : cacheReadTokens.value / cacheWriteTokens.value,
      uncachedInputTokens: inputTokens,
    },
    cost: costReport(route, usage),
  };
}

export function createModelContextReport(
  route: ModelRoute,
  messages: readonly Message[],
  tools: readonly ToolDefinition[] = [],
  suppliedBudget?: ContextBudget,
): ModelContextReport {
  const estimatedInputTokens = estimateContextTokens(messages, tools);
  const contextWindowTokens =
    suppliedBudget?.contextWindowTokens ?? route.capabilities.contextWindowTokens;
  const reservedOutputTokens =
    suppliedBudget?.reservedOutputTokens ?? route.capabilities.maxOutputTokens;
  const safetyMarginTokens = suppliedBudget?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  const inputBudgetTokens =
    suppliedBudget?.inputBudgetTokens ??
    Math.max(0, contextWindowTokens - reservedOutputTokens - safetyMarginTokens);
  const remainingTokens = Math.max(0, inputBudgetTokens - estimatedInputTokens);
  return {
    routeId: route.id,
    estimatedInputTokens,
    contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    remainingTokens,
    usedPercent:
      inputBudgetTokens === 0
        ? 100
        : Math.min(100, (estimatedInputTokens / inputBudgetTokens) * 100),
    estimation: "estimated",
    contextLimitSource: route.capabilities.contextSource,
    outputLimitSource: route.capabilities.outputSource,
    capabilities: {
      vision: route.capabilities.vision,
      reasoning: route.capabilities.reasoning,
      toolCall: route.capabilities.toolCall,
      cache: route.capabilities.cache,
    },
  };
}

export function formatModelUsageReport(report: ModelUsageReport): string {
  const field = (label: string, item: UsageFieldReport): string =>
    `${label}: ${item.value === null ? "unknown" : item.value.toLocaleString("en-US")} (${item.status})`;
  const cost =
    report.cost.cny === null
      ? `Cost: unknown (price ${report.cost.priceSource})`
      : `Cost: ¥${report.cost.cny.toFixed(4)} (${report.cost.status}, price ${report.cost.priceSource})`;
  const ratio = (value: number | null): string =>
    value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
  const multiple = (value: number | null): string =>
    value === null ? "unknown" : `${value.toFixed(2)}x`;
  return [
    `Route: ${report.routeId}`,
    `Provider calls: ${report.providerCalls}; usage reports: ${report.usageReports}`,
    field("Prompt tokens", report.fields.promptTokens),
    field("Completion tokens", report.fields.completionTokens),
    field("Input tokens", report.fields.inputTokens),
    field("Cache read tokens", report.fields.cacheReadTokens),
    field("Cache write tokens", report.fields.cacheWriteTokens),
    `Cache request hit rate: ${ratio(report.cache.requestHitRate)}`,
    `Cache prompt-token reuse: ${ratio(report.cache.promptTokenReuseRate)}`,
    `Cache read/write ratio: ${multiple(report.cache.cacheReadToWriteRatio)}`,
    field("Uncached input tokens", report.cache.uncachedInputTokens),
    field("Reasoning tokens", report.fields.reasoningTokens),
    cost,
  ].join("\n");
}

export function formatModelContextReport(report: ModelContextReport): string {
  const support = (value: boolean | "unknown"): string =>
    value === "unknown" ? "unknown" : value ? "yes" : "no";
  return [
    `Route: ${report.routeId}`,
    `Context: ~${report.estimatedInputTokens.toLocaleString("en-US")} / ${report.inputBudgetTokens.toLocaleString("en-US")} input tokens (${report.usedPercent.toFixed(1)}%, estimated)`,
    `Window: ${report.contextWindowTokens.toLocaleString("en-US")}; reserved output: ${report.reservedOutputTokens.toLocaleString("en-US")}; safety margin: ${report.safetyMarginTokens.toLocaleString("en-US")}; remaining: ~${report.remainingTokens.toLocaleString("en-US")}`,
    `Limits: context=${report.contextLimitSource}, output=${report.outputLimitSource}`,
    `Capabilities: vision=${support(report.capabilities.vision)}, reasoning=${support(report.capabilities.reasoning)}, tool-call=${support(report.capabilities.toolCall)}, cache=${support(report.capabilities.cache)}`,
  ].join("\n");
}

function usageField(value: number, reports: number, totalCalls: number): UsageFieldReport {
  const status: MeasurementStatus =
    totalCalls === 0 || reports === 0 ? "unknown" : reports >= totalCalls ? "reported" : "partial";
  return {
    value: status === "unknown" ? null : value,
    status,
    reportedCalls: reports,
    totalCalls,
  };
}

function costReport(route: ModelRoute, usage: SessionUsageSnapshot): ModelUsageReport["cost"] {
  const total = usage.totalUsageReports;
  const estimated = usage.totalEstimatedCostReports;
  const included = usage.totalIncludedCostReports;
  const unknown = usage.totalUnknownCostReports + Math.max(0, total - estimated - included);
  if (total === 0 || unknown >= total) {
    return { cny: null, status: "unknown", priceSource: route.capabilities.price.source };
  }
  const status =
    unknown > 0 || (estimated > 0 && included > 0)
      ? "partial"
      : included === total
        ? "included"
        : "estimated";
  return {
    cny: usage.totalCostCNY,
    status,
    priceSource: route.capabilities.price.source,
  };
}

function estimateContextTokens(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
): number {
  return estimateModelInputTokens(messages, tools);
}
