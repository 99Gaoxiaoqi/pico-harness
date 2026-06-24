import { describe, expect, it } from "vitest";
import {
  createContextBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokenBudgetAsChars,
  isWithinContextBudget,
} from "../src/context/context-budget.js";
import { resolveProviderProfile } from "../src/provider/profile.js";
import type { Message } from "../src/schema/message.js";

describe("ContextBudget", () => {
  it("估算单条消息 content 与 toolCalls 的 token", () => {
    const msg: Message = {
      role: "assistant",
      content: "abcd",
      toolCalls: [{ id: "c1", name: "bash", arguments: '{"command":"ls"}' }],
    };

    expect(estimateMessageTokens(msg)).toBeGreaterThan(1);
  });

  it("估算多条消息 token 总量", () => {
    expect(
      estimateMessagesTokens([
        { role: "user", content: "a".repeat(8) },
        { role: "assistant", content: "b".repeat(8) },
      ]),
    ).toBe(4);
  });

  it("从 ProviderProfile 创建输入预算", () => {
    const profile = resolveProviderProfile("openai", "glm-5.2");

    const budget = createContextBudget(profile, {
      reservedOutputTokens: 1000,
      safetyMarginTokens: 500,
    });

    expect(budget.contextWindowTokens).toBe(profile.contextWindowTokens);
    expect(budget.inputBudgetTokens).toBe(profile.contextWindowTokens - 1500);
  });

  it("判断上下文是否仍在输入预算内", () => {
    const budget = {
      contextWindowTokens: 100,
      reservedOutputTokens: 10,
      safetyMarginTokens: 10,
      inputBudgetTokens: 2,
    };

    expect(isWithinContextBudget([{ role: "user", content: "abcd" }], budget)).toBe(true);
    expect(isWithinContextBudget([{ role: "user", content: "a".repeat(20) }], budget)).toBe(false);
  });

  it("可以把 token 预算折算回字符预算给 Compactor 使用", () => {
    expect(estimateTokenBudgetAsChars(10)).toBe(40);
    expect(estimateTokenBudgetAsChars(-1)).toBe(0);
  });
});
