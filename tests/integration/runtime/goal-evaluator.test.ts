import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGoalCompletion } from "@pico/runtime/goal-evaluator";
import type { LLMProvider, Message } from "@pico/core";

const goal = {
  title: "迁移包边界",
  description: "完成当前 Runtime 模块迁移",
  progress: "投影已迁移",
};

test("Goal 评估器只向 Provider 发送有界上下文并解析严格 JSON", async () => {
  let received: Message[] | undefined;
  const provider: LLMProvider = {
    generate: async (messages, tools, options) => {
      received = messages;
      assert.deepEqual(tools, []);
      assert.equal(options?.purpose, "hook");
      return {
        role: "assistant",
        content:
          '```json\n{"met":true,"impossible":false,"progress":true,"reason":"验证完成"}\n```',
      };
    },
  };

  const result = await evaluateGoalCompletion(
    provider,
    goal,
    Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `${index}: ${"x".repeat(600)}`,
    })) as Message[],
  );

  assert.deepEqual(result, {
    met: true,
    impossible: false,
    progress: true,
    reason: "验证完成",
    evaluatorFailed: false,
  });
  assert.equal(received?.length, 2);
  assert.match(received?.[1]?.content ?? "", /2: x{497}/u);
  assert.doesNotMatch(received?.[1]?.content ?? "", /1: x/u);
});

test("Goal 评估器在 Provider 失败时 fail-open", async () => {
  const provider: LLMProvider = {
    generate: async () => {
      throw new Error("provider unavailable");
    },
  };

  const result = await evaluateGoalCompletion(provider, goal, []);
  assert.deepEqual(result, {
    met: false,
    impossible: false,
    progress: false,
    reason: "",
    evaluatorFailed: true,
  });
});
