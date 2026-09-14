import {
  ContextOverflowError,
  type LLMProvider,
  type LLMProviderRequestOptions,
  type Message,
  type Reporter,
  type ToolDefinition,
} from "@pico/core";
import { ContextCompactionError, sanitizeToolPairs } from "./compactor.js";
import {
  buildRuntimeSubagentEvidenceSnapshot,
  compactRuntimeSubagentContext,
  type RuntimeSubagentCompactor,
} from "./subagent-context-policy.js";
import { promptCacheConversationShardSeed } from "./prompt-cache.js";
import { providerForReporter } from "./provider-reporting.js";
import { generateWithRetry, type RateLimitFailure, type RetryInfo } from "./provider-retry.js";

const MAX_OVERFLOW_RETRY = 3;
const OVERFLOW_BUDGET_FACTORS = [1.0, 0.6, 0.4, 0.25] as const;

export interface SubagentUsageSession {
  preparePromptCacheSharding(
    routeIdentity: string,
    contextHistory: readonly Message[],
    routeThresholdActive: boolean,
  ): {
    readonly shardSeed?: string;
    readonly active?: boolean;
  };
}

/** Runtime-facing dependencies needed for a local, isolated subagent response. */
export interface SubagentResponseRuntime {
  readonly provider: LLMProvider;
  readonly compactor?: RuntimeSubagentCompactor;
  readonly usageSession?: SubagentUsageSession;
  readonly onRateLimited?: (
    failure: RateLimitFailure,
    reporter: Reporter,
    signal?: AbortSignal,
  ) => LLMProvider | undefined;
}

/** Product logging is injected by Engine; standalone Runtime use remains quiet. */
export interface SubagentContextDiagnostics {
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

const silentDiagnostics: SubagentContextDiagnostics = {
  warn: () => {},
  error: () => {},
};

/**
 * Generate one subagent response, compacting its private history and retrying
 * context overflow with progressively smaller budgets. The Engine supplies
 * attribution and logging, while this policy remains independent of Session.
 */
export async function generateSubagentResponse(
  contextHistory: Message[],
  tools: ToolDefinition[],
  reporter: Reporter,
  runtime: SubagentResponseRuntime,
  onRetry: (info: RetryInfo) => void,
  signal?: AbortSignal,
  requestOptions?: Pick<LLMProviderRequestOptions, "toolChoice">,
  diagnostics: SubagentContextDiagnostics = silentDiagnostics,
): Promise<Message> {
  const promptCacheCapabilities = runtime.provider.requestCapabilities;
  const preparePromptCacheSharding = promptCacheCapabilities?.preparePromptCacheSharding;
  const routeThresholdActive = preparePromptCacheSharding?.();
  const defaultShardSeed = promptCacheConversationShardSeed(contextHistory);
  const promptCacheRequest: { readonly shardSeed?: string; readonly active?: boolean } =
    runtime.usageSession &&
    preparePromptCacheSharding &&
    promptCacheCapabilities.promptCacheRouteIdentity
      ? runtime.usageSession.preparePromptCacheSharding(
          promptCacheCapabilities.promptCacheRouteIdentity,
          contextHistory,
          routeThresholdActive ?? false,
        )
      : {
          ...(defaultShardSeed ? { shardSeed: defaultShardSeed } : {}),
          ...(routeThresholdActive !== undefined ? { active: routeThresholdActive } : {}),
        };
  if (!runtime.compactor) {
    return generate(
      runtime,
      reporter,
      contextHistory,
      tools,
      onRetry,
      signal,
      requestOptions,
      promptCacheRequest,
    );
  }

  let context = compactSubagentContext(
    contextHistory,
    runtime.compactor,
    undefined,
    tools,
    diagnostics,
  );
  for (let attempt = 0; ; attempt++) {
    try {
      return await generate(
        runtime,
        reporter,
        context,
        tools,
        onRetry,
        signal,
        requestOptions,
        promptCacheRequest,
      );
    } catch (error) {
      if (!(error instanceof ContextOverflowError)) throw error;
      if (attempt >= MAX_OVERFLOW_RETRY) {
        diagnostics.error(
          { attempt, maxRetry: MAX_OVERFLOW_RETRY },
          `[Subagent] 响应式压缩已用尽 ${MAX_OVERFLOW_RETRY} 次降级仍溢出,抛出 ContextOverflowError`,
        );
        throw error;
      }
      const budgetFactor = OVERFLOW_BUDGET_FACTORS[attempt + 1]!;
      const newBudget = Math.max(1, Math.floor(runtime.compactor.maxChars * budgetFactor));
      context = compactSubagentContext(
        contextHistory,
        runtime.compactor,
        newBudget,
        tools,
        diagnostics,
      );
      diagnostics.warn(
        { attempt: attempt + 1, budget: newBudget },
        `[Subagent] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1}):预算 ${newBudget} 字符`,
      );
    }
  }
}

/** Compact a private subagent history using Runtime's token-aware policy. */
export function compactSubagentContext(
  contextHistory: Message[],
  compactor: RuntimeSubagentCompactor,
  budget?: number,
  tools: readonly ToolDefinition[] = [],
  diagnostics: SubagentContextDiagnostics = silentDiagnostics,
): Message[] {
  return compactRuntimeSubagentContext(
    contextHistory,
    compactor,
    {
      sanitizeToolPairs,
      isContextCompactionError: (error: unknown): error is ContextCompactionError =>
        error instanceof ContextCompactionError,
      logger: diagnostics,
    },
    budget,
    tools,
  );
}

export function buildSubagentEvidenceSnapshot(
  contextHistory: readonly Message[],
): string | undefined {
  return buildRuntimeSubagentEvidenceSnapshot(contextHistory);
}

function generate(
  runtime: SubagentResponseRuntime,
  reporter: Reporter,
  context: Message[],
  tools: ToolDefinition[],
  onRetry: (info: RetryInfo) => void,
  signal: AbortSignal | undefined,
  requestOptions: Pick<LLMProviderRequestOptions, "toolChoice"> | undefined,
  promptCacheRequest: { readonly shardSeed?: string; readonly active?: boolean },
): Promise<Message> {
  return generateWithRetry(
    providerForReporter(runtime.provider, reporter, signal),
    context,
    tools,
    {
      ...(signal ? { signal } : {}),
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
