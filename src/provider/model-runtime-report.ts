import { countTokens } from "../context/token-counter.js";
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
  ) {}

  usage(): ModelUsageReport {
    return createModelUsageReport(this.route, this.runtime.getRuntimeStateSnapshot().usage);
  }

  context(): ModelContextReport {
    return createModelContextReport(this.route, this.runtime.getHistory(), this.tools);
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
  return {
    routeId: route.id,
    providerCalls: totalCalls,
    usageReports,
    fields: {
      promptTokens: usageField(usage.totalPromptTokens, usageReports, totalCalls),
      completionTokens: usageField(usage.totalCompletionTokens, usageReports, totalCalls),
      inputTokens: usageField(usage.totalInputTokens, usage.totalInputReports, totalCalls),
      cacheReadTokens: usageField(
        usage.totalCacheReadTokens,
        usage.totalCacheReadReports,
        totalCalls,
      ),
      cacheWriteTokens: usageField(
        usage.totalCacheWriteTokens,
        usage.totalCacheWriteReports,
        totalCalls,
      ),
      reasoningTokens: usageField(
        usage.totalReasoningTokens,
        usage.totalReasoningReports,
        totalCalls,
      ),
    },
    cost: costReport(route, usage),
  };
}

export function createModelContextReport(
  route: ModelRoute,
  messages: readonly Message[],
  tools: readonly ToolDefinition[] = [],
): ModelContextReport {
  const estimatedInputTokens = estimateContextTokens(messages, tools);
  const contextWindowTokens = route.capabilities.contextWindowTokens;
  const reservedOutputTokens = route.capabilities.maxOutputTokens;
  const remainingTokens = Math.max(
    0,
    contextWindowTokens - reservedOutputTokens - estimatedInputTokens,
  );
  return {
    routeId: route.id,
    estimatedInputTokens,
    contextWindowTokens,
    reservedOutputTokens,
    remainingTokens,
    usedPercent:
      contextWindowTokens === 0
        ? 100
        : Math.min(100, (estimatedInputTokens / contextWindowTokens) * 100),
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
  return [
    `Route: ${report.routeId}`,
    `Provider calls: ${report.providerCalls}; usage reports: ${report.usageReports}`,
    field("Prompt tokens", report.fields.promptTokens),
    field("Completion tokens", report.fields.completionTokens),
    field("Input tokens", report.fields.inputTokens),
    field("Cache read tokens", report.fields.cacheReadTokens),
    field("Cache write tokens", report.fields.cacheWriteTokens),
    field("Reasoning tokens", report.fields.reasoningTokens),
    cost,
  ].join("\n");
}

export function formatModelContextReport(report: ModelContextReport): string {
  const support = (value: boolean | "unknown"): string =>
    value === "unknown" ? "unknown" : value ? "yes" : "no";
  return [
    `Route: ${report.routeId}`,
    `Context: ~${report.estimatedInputTokens.toLocaleString("en-US")} / ${report.contextWindowTokens.toLocaleString("en-US")} tokens (${report.usedPercent.toFixed(1)}%, estimated)`,
    `Reserved output: ${report.reservedOutputTokens.toLocaleString("en-US")}; remaining: ~${report.remainingTokens.toLocaleString("en-US")}`,
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
  let total = 0;
  for (const message of messages) {
    total += countTokens(message.content);
    for (const call of message.toolCalls ?? []) {
      total += countTokens(call.name) + countTokens(call.arguments);
    }
  }
  if (tools.length > 0) total += countTokens(JSON.stringify(tools));
  return total;
}
