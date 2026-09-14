import { ContextOverflowError, type LLMProviderRequestOptions, type Reporter } from "@pico/core";
import {
  buildRuntimeSubagentEvidenceSnapshot,
  compactRuntimeSubagentContext,
} from "@pico/runtime/subagent-context-policy";
import type { Message, ToolDefinition } from "../schema/message.js";
import { ContextCompactionError, type Compactor, sanitizeToolPairs } from "../context/compactor.js";
import { logger } from "../observability/logger.js";
import { promptCacheConversationShardSeed } from "@pico/runtime/prompt-cache";
import { generateWithRetry, type RetryInfo } from "../provider/retry.js";
import { providerForReporter } from "./provider-reporting.js";
import type { SubagentExecutionRuntime } from "./subagent-runner.js";

const MAX_OVERFLOW_RETRY = 3;
const OVERFLOW_BUDGET_FACTORS = [1.0, 0.6, 0.4, 0.25] as const;

const subagentContextPolicyDependencies = {
  sanitizeToolPairs,
  isContextCompactionError: (error: unknown): error is ContextCompactionError =>
    error instanceof ContextCompactionError,
  logger: {
    warn: (bindings: Readonly<Record<string, unknown>>, message: string): void => {
      logger.warn(bindings, message);
    },
  },
};

/**
 * runSub 专用的简化版响应式溢出重试。
 *
 * 子代理用独立 contextHistory 局部变量(非 Session 驱动),无法重取 WorkingMemory,
 * 故仅用更小的 maxChars 预算对 contextHistory 重新 compactToBudget 重试,不改 limit。
 * 降级系数复用 OVERFLOW_BUDGET_FACTORS(与主循环一致,便于心智模型统一)。
 */
export async function generateSubagentResponse(
  contextHistory: Message[],
  tools: ToolDefinition[],
  reporter: Reporter,
  runtime: SubagentExecutionRuntime,
  onRetry: (info: RetryInfo) => void,
  signal?: AbortSignal,
  requestOptions?: Pick<LLMProviderRequestOptions, "toolChoice">,
): Promise<Message> {
  const promptCacheCapabilities = runtime.provider.requestCapabilities;
  const preparePromptCacheSharding = promptCacheCapabilities?.preparePromptCacheSharding;
  const routeThresholdActive = preparePromptCacheSharding?.();
  const promptCacheRequest =
    runtime.usageSession &&
    preparePromptCacheSharding &&
    promptCacheCapabilities.promptCacheRouteIdentity
      ? runtime.usageSession.preparePromptCacheSharding(
          promptCacheCapabilities.promptCacheRouteIdentity,
          contextHistory,
          routeThresholdActive ?? false,
        )
      : {
          shardSeed: promptCacheConversationShardSeed(contextHistory),
          active: routeThresholdActive,
        };
  if (!runtime.compactor) {
    return generateWithRetry(
      providerForReporter(runtime.provider, reporter, signal),
      contextHistory,
      tools,
      {
        signal,
        onRetry,
        ...(promptCacheRequest.shardSeed
          ? { promptCacheShardSeed: promptCacheRequest.shardSeed }
          : {}),
        ...(promptCacheRequest.active !== undefined
          ? { promptCacheShardActive: promptCacheRequest.active }
          : {}),
        ...requestOptions,
        ...(runtime.onRateLimited
          ? { onRateLimited: (failure) => runtime.onRateLimited?.(failure, reporter, signal) }
          : {}),
      },
    );
  }
  let context = compactSubagentContext(contextHistory, runtime.compactor, undefined, tools);
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateWithRetry(
        providerForReporter(runtime.provider, reporter, signal),
        context,
        tools,
        {
          signal,
          onRetry,
          ...(promptCacheRequest.shardSeed
            ? { promptCacheShardSeed: promptCacheRequest.shardSeed }
            : {}),
          ...(promptCacheRequest.active !== undefined
            ? { promptCacheShardActive: promptCacheRequest.active }
            : {}),
          ...requestOptions,
          ...(runtime.onRateLimited
            ? { onRateLimited: (failure) => runtime.onRateLimited?.(failure, reporter, signal) }
            : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      if (attempt >= MAX_OVERFLOW_RETRY) {
        logger.error(
          { attempt, maxRetry: MAX_OVERFLOW_RETRY },
          `[Subagent] 响应式压缩已用尽 ${MAX_OVERFLOW_RETRY} 次降级仍溢出,抛出 ContextOverflowError`,
        );
        throw error;
      }
      const budgetFactor = OVERFLOW_BUDGET_FACTORS[attempt + 1]!;
      const newBudget = Math.max(1, Math.floor(runtime.compactor.maxChars * budgetFactor));
      context = compactSubagentContext(contextHistory, runtime.compactor, newBudget, tools);
      logger.warn(
        { attempt: attempt + 1, budget: newBudget },
        `[Subagent] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1}):预算 ${newBudget} 字符`,
      );
    }
  }
}

/** Engine compatibility entry for Runtime's subagent context policy. */
export function compactSubagentContext(
  contextHistory: Message[],
  compactor: Compactor,
  budget?: number,
  tools: readonly ToolDefinition[] = [],
): Message[] {
  return compactRuntimeSubagentContext(
    contextHistory,
    compactor,
    subagentContextPolicyDependencies,
    budget,
    tools,
  );
}

export function buildSubagentEvidenceSnapshot(
  contextHistory: readonly Message[],
): string | undefined {
  return buildRuntimeSubagentEvidenceSnapshot(contextHistory);
}
