import assert from "node:assert/strict";
import { test } from "node:test";
import type { LLMProvider, Message } from "@pico/core";
import { evaluateGoal } from "@pico/runtime/goal-evaluator";

test("Goal evaluator sends only six bounded user/assistant messages and uses no tools", async () => {
  let received: Message[] | undefined;
  const provider: LLMProvider = {
    generate: async (messages, tools, options) => {
      received = messages;
      assert.deepEqual(tools, []);
      assert.equal(options?.purpose, "goal_evaluation");
      assert.equal(options?.maxOutputTokens, 1_024);
      return {
        role: "assistant",
        content:
          '{"met":false,"impossible":false,"progress":true,"waiting":false,"reason":"已完成一项"}',
      };
    },
  };

  const history = Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${index}: ${"x".repeat(900)}`,
  })) as Message[];
  const result = await evaluateGoal(provider, "做完全部工作", history);

  assert.deepEqual(result, {
    met: false,
    impossible: false,
    progress: true,
    waiting: false,
    evaluatorFailed: false,
    reason: "已完成一项",
  });
  assert.equal(received?.length, 2);
  assert.doesNotMatch(received?.[1]?.content ?? "", /0: x/u);
  assert.match(received?.[1]?.content ?? "", /8: x{497}/u);
  assert.doesNotMatch(received?.[1]?.content ?? "", /x{501}/u);
});

test("Goal evaluator converts provider failures and malformed output to neutral failures", async () => {
  const failures: LLMProvider[] = [
    {
      generate: async () => {
        throw new Error("provider unavailable");
      },
    },
    {
      generate: async () => ({
        role: "assistant",
        content: '{"met":"true","reason":"invalid flag"}',
      }),
    },
  ];
  for (const provider of failures) {
    const result = await evaluateGoal(provider, "完成要求", []);
    assert.equal(result.evaluatorFailed, true);
    assert.equal(result.met, undefined);
    assert.ok(result.reason.length > 0);
  }
});

test("Goal evaluator aborts the provider when its deadline expires", async () => {
  let sawAbort = false;
  const provider: LLMProvider = {
    generate: async (_messages, _tools, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
  const result = await evaluateGoal(provider, "等待或完成", [], { timeoutMs: 5 });
  assert.equal(sawAbort, true);
  assert.equal(result.evaluatorFailed, true);
  assert.match(result.reason, /超时/u);
});

test("Goal evaluator normalizes omitted fields and selects the judgment object like upstream", async () => {
  const result = await evaluateGoal(
    {
      generate: async () => ({
        role: "assistant",
        content: 'example: {"unrelated":true} judgment: {"met":true}',
      }),
    },
    "完成要求",
    [],
  );
  assert.deepEqual(result, {
    met: true,
    impossible: false,
    progress: false,
    waiting: false,
    evaluatorFailed: false,
    reason: "未提供原因",
  });
});
