import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGoalCompletion } from "@pico/runtime/goal-evaluator";
import type { LLMProvider, Message } from "@pico/core";

const goal = {
  title: "迁移包边界",
  description: "完成当前 Runtime 模块迁移",
  completionCriteria: ["Goal schema v2 已落盘", "相关集成测试通过"],
  progress: "投影已迁移",
};

test("Goal 评估器只向 Provider 发送有界上下文并解析结构化验收结果", async () => {
  let received: Message[] | undefined;
  const provider: LLMProvider = {
    generate: async (messages, tools, options) => {
      received = messages;
      assert.deepEqual(tools, []);
      assert.equal(options?.purpose, "hook");
      return {
        role: "assistant",
        content:
          '```json\n{"outcome":"met","progress":true,"reason":"验证完成","evidence":["schema v2 snapshot 已落盘","旧 schema 被拒绝"]}\n```',
      };
    },
  };

  const result = await evaluateGoalCompletion(
    provider,
    { ...goal, evidence: ["schema v2 snapshot 已落盘", "旧 schema 被拒绝"] },
    Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}: ${"x".repeat(900)}`,
    })) as Message[],
  );

  assert.deepEqual(result, {
    outcome: "met",
    progress: true,
    reason: "验证完成",
    evidence: ["schema v2 snapshot 已落盘", "旧 schema 被拒绝"],
    evaluatorFailed: false,
  });
  assert.equal(received?.length, 2);
  assert.match(received?.[1]?.content ?? "", /assistant: 9: x{797}/u);
  assert.doesNotMatch(received?.[1]?.content ?? "", /user: 0: x/u);
  assert.match(received?.[1]?.content ?? "", /之前各轮记录的证据/u);
  assert.match(received?.[1]?.content ?? "", /schema v2 snapshot 已落盘/u);
});

test("Goal 评估器在 Provider 失败时返回可续跑的中性结果", async () => {
  const provider: LLMProvider = {
    generate: async () => {
      throw new Error("provider unavailable");
    },
  };

  const result = await evaluateGoalCompletion(provider, goal, []);
  assert.deepEqual(result, {
    outcome: "progress",
    progress: false,
    reason: "",
    evidence: [],
    evaluatorFailed: true,
  });
});

test("Goal 评估器不会接受缺少逐项证据的 met 结果", async () => {
  const provider: LLMProvider = {
    generate: async () => ({
      role: "assistant",
      content: '{"outcome":"met","progress":true,"reason":"已完成","evidence":[]}',
    }),
  };

  const result = await evaluateGoalCompletion(
    provider,
    { ...goal, completionCriteria: ["第一项", "第二项"] },
    [],
  );
  assert.equal(result.outcome, "progress");
  assert.equal(result.evaluatorFailed, true);
  assert.deepEqual(result.evidence, []);
});
