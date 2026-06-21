import { toCanonicalUsage, type Usage } from "../schema/message.js";

export interface BudgetConfig {
  maxTurns?: number;
  maxTokens?: number;
  maxCostCNY?: number;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

export class IterationBudget {
  private totalTokens = 0;
  private totalCostCNY = 0;

  constructor(private readonly config: BudgetConfig = {}) {}

  canStartTurn(nextTurn: number): BudgetDecision {
    if (this.config.maxTurns !== undefined && nextTurn > this.config.maxTurns) {
      return {
        allowed: false,
        reason: `已达到最大轮次 ${this.config.maxTurns}`,
      };
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

  private currentDecision(): BudgetDecision {
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
