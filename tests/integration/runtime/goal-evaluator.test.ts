import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { LLMProvider, Message } from "@pico/core";
import { buildGoalEvidenceContext, evaluateGoal } from "@pico/runtime/goal-evaluator";

function evidenceFixture(
  history: readonly Message[] = [{ role: "assistant", content: "交付说明" }],
) {
  const identity = {
    goalId: "goal-current",
    goalRevision: 1,
    generation: 1,
    sessionId: "session-current",
    runId: "run-current",
    turnId: "turn-current",
    invocationId: "invocation-current",
    runStartedEventId: "run-start",
  };
  const messages = history.map((message, index) => ({
    eventId: `message-${index}`,
    sequence: index + 2,
    role: message.role as "user" | "assistant",
    content: message.content,
    sha256: createHash("sha256").update(message.content).digest("hex"),
    sizeBytes: Buffer.byteLength(message.content),
    truncated: false,
  }));
  const throughSequence = history.length + 2;
  return buildGoalEvidenceContext(identity, {
    throughSequence,
    identity: {
      started: { ...identity, eventId: "run-start", sequence: 1 },
      terminal: { ...identity, eventId: "run-end", sequence: throughSequence, status: "completed" },
    },
    tools: [],
    messages,
    toolResultCount: 0,
    messageCount: messages.length,
    incompleteToolCallCount: 0,
    potentialMutationCount: 0,
    potentialMutations: [],
  });
}

test("Goal evaluator requires bounded current-Run evidence and uses no tools", async () => {
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
  const result = await evaluateGoal(provider, "做完全部工作", {
    evidence: evidenceFixture(history),
  });

  const { evidenceTrace, ...decision } = result;
  assert.deepEqual(decision, {
    met: false,
    impossible: false,
    progress: true,
    waiting: false,
    evaluatorFailed: false,
    reason: "已完成一项",
  });
  assert.equal(evidenceTrace.sourceRunId, "run-current");
  assert.equal(evidenceTrace.providedEvidence.length, 6);
  assert.equal(received?.length, 2);
  assert.doesNotMatch(received?.[1]?.content ?? "", /0: x/u);
  assert.match(received?.[1]?.content ?? "", /8: x{497}/u);
  assert.doesNotMatch(received?.[1]?.content ?? "", /x{501}/u);
  await assert.rejects(
    // @ts-expect-error The old evidence-free call is deliberately unsupported.
    evaluateGoal(provider, "做完全部工作", {}),
    /必须提供当前 Run 的执行证据/u,
  );
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
    const result = await evaluateGoal(provider, "完成要求", { evidence: evidenceFixture() });
    assert.equal(result.evaluatorFailed, true);
    assert.equal(result.met, undefined);
    assert.ok(result.reason.length > 0);
    assert.equal(result.evidenceTrace.sourceRunId, "run-current");
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
  const result = await evaluateGoal(provider, "等待或完成", {
    evidence: evidenceFixture(),
    timeoutMs: 5,
  });
  assert.equal(sawAbort, true);
  assert.equal(result.evaluatorFailed, true);
  assert.match(result.reason, /超时/u);
});

test("Goal evaluator normalizes omitted fields and selects the judgment object", async () => {
  const result = await evaluateGoal(
    {
      generate: async () => ({
        role: "assistant",
        content:
          'example: {"unrelated":true} judgment: {"met":true,"acceptanceBasis":"delivery","citedEvidenceIds":["message-0"]}',
      }),
    },
    "完成要求",
    { evidence: evidenceFixture() },
  );
  const { evidenceTrace, ...decision } = result;
  assert.deepEqual(decision, {
    met: true,
    impossible: false,
    progress: false,
    waiting: false,
    evaluatorFailed: false,
    reason: "未提供原因",
  });
  assert.deepEqual(evidenceTrace.citedEvidenceIds, ["message-0"]);
});
