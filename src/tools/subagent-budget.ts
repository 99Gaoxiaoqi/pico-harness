export interface OutputBudgetRange {
  softMin: number;
  softMax: number;
  hardMax: number;
}

/**
 * 子代理结果回灌主上下文时的统一预算合约。
 *
 * softMin 不是填充目标：简单任务可以更短。softMax 是常规目标，
 * hardMax 只在模型输出失控或结构化证据较多时作最后熔断。
 */
export const SUBAGENT_OUTPUT_BUDGET = {
  summary: { softMin: 1_000, softMax: 2_000, hardMax: 5_000 },
  batch: { softMin: 6_000, softMax: 8_000, hardMax: 12_000 },
} as const satisfies Record<"summary" | "batch", OutputBudgetRange>;
