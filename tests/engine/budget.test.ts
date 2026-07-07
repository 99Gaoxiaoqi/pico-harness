// IterationBudget 单元测试:验证 turns / tokens / cost / wall-clock 维度。
//
// 验证范围:
// 1. maxWallClockMs 未设 → 不检查墙钟(向后兼容)
// 2. maxWallClockMs 超时 → canStartTurn 返回 false
// 3. maxWallClockMs 未超时 → canStartTurn 返回 true
// 4. 与 maxTurns 组合:先触发的维度生效
// 5. 现有 turns / tokens / cost 维度回归

import { describe, expect, it } from "vitest";
import { IterationBudget } from "../../src/engine/budget.js";
import type { Usage } from "../../src/schema/message.js";

describe("IterationBudget - wall-clock", () => {
  it("maxWallClockMs 未设时不检查墙钟", () => {
    const budget = new IterationBudget({ maxTurns: 5 });
    // 即使等待也不应触发墙钟(未配置)
    expect(budget.canStartTurn(1)).toEqual({ allowed: true });
  });

  it("maxWallClockMs 设为 100ms,sleep 150ms 后 canStartTurn 返回 false", async () => {
    const budget = new IterationBudget({ maxWallClockMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const decision = budget.canStartTurn(1);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("墙钟时间上限");
  });

  it("maxWallClockMs 设为 1000ms,立即 canStartTurn 返回 true", () => {
    const budget = new IterationBudget({ maxWallClockMs: 1000 });
    const decision = budget.canStartTurn(1);
    expect(decision.allowed).toBe(true);
  });

  it("与 maxTurns 组合:两个都设,先触发的维度生效", () => {
    // maxTurns 先触发(turn 2 > 1)
    const budget = new IterationBudget({ maxTurns: 1, maxWallClockMs: 100000 });
    const decision = budget.canStartTurn(2);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("最大轮次");
  });

  it("墙钟先触发时返回墙钟原因", async () => {
    // maxTurns 宽松,墙钟紧
    const budget = new IterationBudget({ maxTurns: 100, maxWallClockMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const decision = budget.canStartTurn(1);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("墙钟时间上限");
  });
});

describe("IterationBudget - 回归:现有维度", () => {
  const usage: Usage = {
    promptTokens: 100,
    completionTokens: 50,
  };

  it("maxTurns 限制", () => {
    const budget = new IterationBudget({ maxTurns: 3 });
    expect(budget.canStartTurn(3).allowed).toBe(true);
    expect(budget.canStartTurn(4).allowed).toBe(false);
  });

  it("maxTokens 限制", () => {
    const budget = new IterationBudget({ maxTokens: 200 });
    expect(budget.consumeUsage(usage).allowed).toBe(true); // total 150
    expect(budget.consumeUsage(usage).allowed).toBe(false); // total 300 > 200
  });

  it("maxCostCNY 限制", () => {
    const budget = new IterationBudget({ maxCostCNY: 1 });
    expect(budget.consumeCost(0.5).allowed).toBe(true);
    expect(budget.consumeCost(0.6).allowed).toBe(false); // total 1.1 > 1
  });
});
