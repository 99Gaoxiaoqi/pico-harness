import type { Message, ToolDefinition } from "../schema/message.js";
import type { LLMProviderRequestOptions } from "../provider/interface.js";
import { ContextOverflowError } from "../provider/errors.js";
import { generateWithRetry, type RetryInfo } from "../provider/retry.js";
import type { Compactor } from "../context/compactor.js";
import { ContextCompactionError, sanitizeToolPairs } from "../context/compactor.js";
import { CHARS_PER_TOKEN, estimateModelInputTokens } from "../context/context-budget.js";
import { promptCacheConversationShardSeed } from "../provider/prompt-cache.js";
import { logger } from "../observability/logger.js";
import type { Reporter } from "./reporter.js";
import type { SubagentExecutionRuntime } from "./subagent-runner.js";
import { providerForReporter } from "./provider-reporting.js";
import { buildEvidenceSnapshot, estimateTraceLength } from "./context-evidence.js";
const MAX_OVERFLOW_RETRY = 3;
const OVERFLOW_BUDGET_FACTORS = [1.0, 0.6, 0.4, 0.25] as const;
/**
 * runSub 专用的简化版响应式溢出重试。
 *
 * 子代理用独立 contextHistory 局部变量(非 Session 驱动),无法重取 WorkingMemory,
 * 故仅用更小的 maxChars 预算对 contextHistory 重新 compactToBudget 重试,不改 limit。
 * 降级系数复用 OVERFLOW_BUDGET_FACTORS(与主循环一致,便于心智模型统一)。
 *
 * 与 generateWithOverflowRetry 的差异:
 *   - 不从 Session 重取 WorkingMemory(子代理无 Session)
 *   - 仅压缩字符预算,条数不变
 *   - 首轮压缩也由本方法内部完成(调用方直接传原始 contextHistory)
 *
 * @param contextHistory 子代理当前完整上下文(未经压缩)
 * @param tools 本轮可用工具
 * @returns 模型响应消息
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
    // 无 Compactor:子代理无法降级,叠加普通重试层(溢出则原样抛出)
    return generateWithRetry(
      providerForReporter(runtime.provider, reporter, signal),
      contextHistory,
      tools,
      {
        signal,
        onRetry: onRetry,
        ...(promptCacheRequest.shardSeed
          ? { promptCacheShardSeed: promptCacheRequest.shardSeed }
          : {}),
        ...(promptCacheRequest.active !== undefined
          ? { promptCacheShardActive: promptCacheRequest.active }
          : {}),
        ...requestOptions,
        ...(runtime.onRateLimited
          ? { onRateLimited: () => runtime.onRateLimited?.(reporter, signal) }
          : {}),
      },
    );
  }
  // 首轮:用默认预算压缩(attempt 0,系数 1.0);传入 tools 以启用 token 维度自适应校正(ctx-2)
  let context = compactSubagentContext(contextHistory, runtime.compactor, undefined, tools);
  for (let attempt = 0; ; attempt++) {
    try {
      // 【集成点】同 generateWithOverflowRetry,叠加普通重试层在内,
      // 响应式压缩在外(子代理版仅降字符预算,不改 WorkingMemory 条数)。
      return await generateWithRetry(
        providerForReporter(runtime.provider, reporter, signal),
        context,
        tools,
        {
          signal,
          onRetry: onRetry,
          ...(promptCacheRequest.shardSeed
            ? { promptCacheShardSeed: promptCacheRequest.shardSeed }
            : {}),
          ...(promptCacheRequest.active !== undefined
            ? { promptCacheShardActive: promptCacheRequest.active }
            : {}),
          ...requestOptions,
          ...(runtime.onRateLimited
            ? { onRateLimited: () => runtime.onRateLimited?.(reporter, signal) }
            : {}),
        },
      );
    } catch (err) {
      if (!(err instanceof ContextOverflowError)) {
        throw err;
      }
      if (attempt >= MAX_OVERFLOW_RETRY) {
        logger.error(
          { attempt, maxRetry: MAX_OVERFLOW_RETRY },
          `[Subagent] 响应式压缩已用尽 ${MAX_OVERFLOW_RETRY} 次降级仍溢出,抛出 ContextOverflowError`,
        );
        throw err;
      }
      const budgetFactor = OVERFLOW_BUDGET_FACTORS[attempt + 1]!;
      const newBudget = Math.max(1, Math.floor(runtime.compactor.maxChars * budgetFactor));
      // contextHistory 已持久化上一档压缩结果；继续缩紧预算时从该结构化历史降级，
      // 避免下一轮又从未压缩原文开始并重复探索。
      context = compactSubagentContext(contextHistory, runtime.compactor, newBudget, tools);
      logger.warn(
        { attempt: attempt + 1, budget: newBudget },
        `[Subagent] ⚠ 上下文溢出,响应式降级重试(attempt ${attempt + 1}):预算 ${newBudget} 字符`,
      );
    }
  }
}

/**
 * 子代理上下文压缩 + 硬重置兜底。
 *
 * 子代理没有 Session，因此压缩结果必须回写到这次 runSub 的局部历史；
 * 否则 provider 本轮虽看到压缩请求，下轮仍会从未压缩原文重新开始。
 * compactToBudget 完全失败时，保留 system/task 和一条结构化 evidence snapshot；
 * 若连 snapshot 也放不下，才退化到只保留 system/task。
 */
export function compactSubagentContext(
  contextHistory: Message[],
  compactor: Compactor,
  budget?: number,
  tools: readonly ToolDefinition[] = [],
): Message[] {
  // ctx-2: 子代理预算闭环原本纯字符(maxChars = inputBudgetTokens * CHARS_PER_TOKEN,
  // 而 CHARS_PER_TOKEN 是英文经验值,对中文失真 4-8 倍)。首轮(budget 未指定)先用
  // BPE token 估算判断是否真的超预算(token 维度),而不是仅靠字符水位线。
  //   - token 维度已超预算:按实际内容密度(chars/token)反推与 token 预算匹配的
  //     自适应字符预算,而非沿用英文经验值。英文内容(chars/token≈4)自适应后与
  //     旧 maxChars(tokens*4)量级一致、行为不变;中文内容(chars/token≈0.5-1)
  //     自适应后会显著收紧,杜绝 4-8 倍超出窗口。
  //   - token 维度未超预算:无内存压力,直接跳过 compact() 的字符水位 gate。否则
  //     英文/代码内容(~4 chars/token,30k token ≈ 120k chars)会超过 maxChars
  //     (≈ inputBudgetTokens*1.5 字符)而 token 还远未触顶,被提前误压(loop-9)。
  //     这里只做与 compact() no-op 路径一致的 sanitizeToolPairs(维护 tool 配对
  //     不变量),不经字符水位 gating。主循环的 token 维度触发逻辑不受影响。
  if (budget === undefined && contextHistory.length > 0) {
    const currentTokens = estimateModelInputTokens(contextHistory, tools);
    // maxChars 由 inputBudgetTokens * CHARS_PER_TOKEN 换算而来,反推 token 预算。
    const tokenBudget = Math.max(1, Math.floor(compactor.maxChars / CHARS_PER_TOKEN));
    if (currentTokens > tokenBudget) {
      const currentChars = compactor.estimateLength(contextHistory);
      const adaptiveCharBudget =
        currentTokens > 0
          ? Math.max(1, Math.floor((tokenBudget * currentChars) / currentTokens))
          : undefined;
      if (adaptiveCharBudget !== undefined) {
        budget = adaptiveCharBudget;
        logger.warn(
          { currentTokens, tokenBudget, currentChars, adaptiveCharBudget },
          `[Subagent] ⚠ token 维度已超预算,按内容密度自适应收紧字符预算(英文经验值 CHARS_PER_TOKEN 对中文过度宽松)`,
        );
      }
    } else {
      // loop-9: token 维度未超预算时显式跳过字符水位压缩,避免英文/代码内容被误压。
      return persistSubagentContext(contextHistory, sanitizeToolPairs(contextHistory));
    }
  }
  // system prompt 不允许被 Compactor 裁剪。动态 workspace/tool 纪律可能使它大于
  // 最低降级系数算出的预算；若不钳制可行下限，会在真正的 provider
  // overflow 重试之前误抛 ContextCompactionError。
  const effectiveBudget =
    budget === undefined
      ? undefined
      : Math.max(budget, estimateTraceLength(contextHistory.slice(0, 1)) + 1);
  try {
    const compacted =
      effectiveBudget !== undefined
        ? compactor.compactToBudget(contextHistory, effectiveBudget)
        : compactor.compactToBudget(contextHistory);
    return persistSubagentContext(contextHistory, compacted);
  } catch (err) {
    if (err instanceof ContextCompactionError) {
      const evidenceSnapshot = buildSubagentEvidenceSnapshot(contextHistory);
      logger.warn(
        {
          beforeChars: err.beforeChars,
          afterChars: err.afterChars,
          maxChars: err.maxChars,
          evidenceSnapshot: evidenceSnapshot !== undefined,
        },
        `[Subagent] ⚠ 压缩彻底失败,重置为任务指令与结构化证据快照`,
      );
      const taskBoundary = contextHistory.slice(0, 2);
      const reset = evidenceSnapshot
        ? [
            ...taskBoundary,
            {
              role: "user" as const,
              content: evidenceSnapshot,
              providerData: {
                picoKind: "subagent_evidence_snapshot",
                picoHiddenFromTranscript: true,
              },
            },
          ]
        : taskBoundary;
      try {
        const compactedReset =
          effectiveBudget !== undefined
            ? compactor.compactToBudget(reset, effectiveBudget)
            : compactor.compactToBudget(reset);
        return persistSubagentContext(contextHistory, compactedReset);
      } catch (resetError) {
        if (!(resetError instanceof ContextCompactionError) || !evidenceSnapshot) {
          throw resetError;
        }
        const compactedTask =
          effectiveBudget !== undefined
            ? compactor.compactToBudget(taskBoundary, effectiveBudget)
            : compactor.compactToBudget(taskBoundary);
        return persistSubagentContext(contextHistory, compactedTask);
      }
    }
    throw err;
  }
}

function persistSubagentContext(contextHistory: Message[], compacted: Message[]): Message[] {
  contextHistory.splice(0, contextHistory.length, ...compacted);
  return contextHistory;
}

export function buildSubagentEvidenceSnapshot(
  contextHistory: readonly Message[],
): string | undefined {
  return buildEvidenceSnapshot(contextHistory, 2, "[SUBAGENT EVIDENCE SNAPSHOT]");
}
