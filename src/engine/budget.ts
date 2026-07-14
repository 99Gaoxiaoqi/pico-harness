import { toCanonicalUsage, type Usage } from "../schema/message.js";

export interface BudgetConfig {
  maxTurns?: number;
  maxTokens?: number;
  maxCostCNY?: number;
  maxWallClockMs?: number;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

export class IterationBudget {
  private totalTokens = 0;
  private totalCostCNY = 0;
  private readonly startMs = Date.now();

  constructor(private readonly config: BudgetConfig = {}) {}

  canStartTurn(nextTurn: number): BudgetDecision {
    if (this.config.maxTurns !== undefined && nextTurn > this.config.maxTurns) {
      return {
        allowed: false,
        reason: `已达到最大轮次 ${this.config.maxTurns}`,
      };
    }
    if (this.config.maxWallClockMs !== undefined) {
      const elapsed = Date.now() - this.startMs;
      if (elapsed > this.config.maxWallClockMs) {
        return {
          allowed: false,
          reason: `已达墙钟时间上限 ${this.config.maxWallClockMs}ms(实际 ${elapsed}ms)`,
        };
      }
    }
    return this.currentDecision();
  }

  consumeUsage(usage: Usage): BudgetDecision {
    const canonical = toCanonicalUsage(usage);
    this.totalTokens += canonical.totalPromptTokens + canonical.totalCompletionTokens;
    return this.currentDecision();
  }

  consumeCost(costCNY: number): BudgetDecision {
    this.totalCostCNY += costCNY;
    return this.currentDecision();
  }

  /**
   * 只读检查当前预算。子代理与主循环共享同一预算时，用于在新的
   * Provider 调用前阻止已超限的后续请求，不额外消费轮次。
   */
  currentDecision(): BudgetDecision {
    if (this.config.maxTokens !== undefined && this.totalTokens > this.config.maxTokens) {
      return {
        allowed: false,
        reason: `已达到 Token 预算 ${this.config.maxTokens}`,
      };
    }
    if (this.config.maxCostCNY !== undefined && this.totalCostCNY > this.config.maxCostCNY) {
      return {
        allowed: false,
        reason: `已达到成本预算 ¥${this.config.maxCostCNY}`,
      };
    }
    return { allowed: true };
  }
}
