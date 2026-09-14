import type { Message, ToolDefinition } from "@pico/core";
import { buildEvidenceSnapshot, estimateTraceLength } from "./context-evidence.js";
import { CHARS_PER_TOKEN, estimateModelInputTokens } from "./context-budget.js";

export interface RuntimeSubagentCompactor {
  readonly maxChars: number;
  estimateLength(messages: Message[]): number;
  compactToBudget(messages: Message[], budget?: number): Message[];
}

export interface RuntimeContextCompactionError {
  readonly beforeChars: number;
  readonly afterChars: number;
  readonly maxChars: number;
}

export interface RuntimeSubagentContextPolicyDependencies {
  /** Engine owns the concrete tool-pair sanitizer while Runtime owns the policy. */
  sanitizeToolPairs(messages: Message[]): Message[];
  isContextCompactionError(error: unknown): error is RuntimeContextCompactionError;
  logger: {
    warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
  };
}

/**
 * Compact a local subagent history with token-aware budgeting and a fail-closed
 * evidence reset. The concrete Compactor and its error class remain outer
 * adapters, so this policy has no dependency on Engine construction.
 */
export function compactRuntimeSubagentContext(
  contextHistory: Message[],
  compactor: RuntimeSubagentCompactor,
  dependencies: RuntimeSubagentContextPolicyDependencies,
  budget?: number,
  tools: readonly ToolDefinition[] = [],
): Message[] {
  if (budget === undefined && contextHistory.length > 0) {
    const currentTokens = estimateModelInputTokens(contextHistory, tools);
    const tokenBudget = Math.max(1, Math.floor(compactor.maxChars / CHARS_PER_TOKEN));
    if (currentTokens > tokenBudget) {
      const currentChars = compactor.estimateLength(contextHistory);
      const adaptiveCharBudget =
        currentTokens > 0
          ? Math.max(1, Math.floor((tokenBudget * currentChars) / currentTokens))
          : undefined;
      if (adaptiveCharBudget !== undefined) {
        budget = adaptiveCharBudget;
        dependencies.logger.warn(
          { currentTokens, tokenBudget, currentChars, adaptiveCharBudget },
          `[Subagent] ⚠ token 维度已超预算,按内容密度自适应收紧字符预算(英文经验值 CHARS_PER_TOKEN 对中文过度宽松)`,
        );
      }
    } else {
      return persistSubagentContext(contextHistory, dependencies.sanitizeToolPairs(contextHistory));
    }
  }

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
  } catch (error) {
    if (!dependencies.isContextCompactionError(error)) throw error;
    const evidenceSnapshot = buildRuntimeSubagentEvidenceSnapshot(contextHistory);
    dependencies.logger.warn(
      {
        beforeChars: error.beforeChars,
        afterChars: error.afterChars,
        maxChars: error.maxChars,
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
      if (!dependencies.isContextCompactionError(resetError) || !evidenceSnapshot) {
        throw resetError;
      }
      const compactedTask =
        effectiveBudget !== undefined
          ? compactor.compactToBudget(taskBoundary, effectiveBudget)
          : compactor.compactToBudget(taskBoundary);
      return persistSubagentContext(contextHistory, compactedTask);
    }
  }
}

export function buildRuntimeSubagentEvidenceSnapshot(
  contextHistory: readonly Message[],
): string | undefined {
  return buildEvidenceSnapshot(contextHistory, 2, "[SUBAGENT EVIDENCE SNAPSHOT]");
}

function persistSubagentContext(contextHistory: Message[], compacted: Message[]): Message[] {
  contextHistory.splice(0, contextHistory.length, ...compacted);
  return contextHistory;
}
