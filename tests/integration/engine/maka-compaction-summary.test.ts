import assert from "node:assert/strict";
import { test } from "node:test";
import type { LLMProvider, Message } from "@pico/core";
import { FullCompactor, wrapFullCompactionSummary } from "@pico/runtime/full-compactor";
import { recordRuntimeCompactionCheckpoint } from "@pico/runtime/runtime-compaction-checkpoint";
import { isValidStoredCompactionSummary } from "../../../packages/runtime/src/history-compact-summary-validation.js";

const summary = `## Goal
完成迁移并保持用户约束。
## Progress
### Done
已读取 src/provider.ts。${"详细事实。".repeat(350)}
### In Progress
正在运行真实模型测试。
## Key Decisions
保留原始工具错误；失败的方案不可重复。
## Next Steps
1. 验证后继续当前任务。
## Critical Context
- src/provider.ts；运行 npm test；错误 TS2345。`;
const anchor: Message = { role: "user", content: "继续完成迁移，不要丢失任务。" };
const history: Message[] = [
  anchor,
  { role: "assistant", content: "已读取代码。" },
  { role: "assistant", content: "已运行检查。" },
  { role: "user", content: "不要引入新依赖", providerData: { picoKind: "steer" } },
  { role: "assistant", content: "下一步验证。" },
];

test("Maka summary checkpoint repairs once, retains full source and active directives, then rolls forward", async () => {
  const requests: Message[][] = [];
  const options: unknown[] = [];
  const provider: LLMProvider = {
    async generate(messages, _tools, requestOptions) {
      requests.push([...messages]);
      options.push(requestOptions);
      return { role: "assistant", content: requests.length === 1 ? "broken" : summary };
    },
  };
  const compactor = new FullCompactor({ provider, maxAttempts: 1 });
  let entries = history.map((message, index) => ({ eventId: `event-${index}`, message }));
  let saved:
    | Parameters<
        Parameters<typeof recordRuntimeCompactionCheckpoint>[0]["runtimeRun"]["recordCheckpoint"]
      >[0]
    | undefined;
  const session = { id: "maka-summary-integration" };
  const runtimeRun = {
    claimsSession: () => true,
    readModelHistoryEntries: async () => entries,
    findLastCompactionCheckpoint: async () => undefined,
    recordCheckpoint: async (input: NonNullable<typeof saved>) => {
      saved = input;
      entries = [
        { eventId: input.checkpointId, message: input.summary },
        ...entries.slice(input.coveredEventCount),
      ];
    },
  };
  const result = await recordRuntimeCompactionCheckpoint({
    session,
    runtimeRun,
    compactor,
    request: { trigger: "manual", inputBudgetTokens: 16000, preservedAnchor: anchor },
  });
  assert.ok(result && saved);
  assert.equal(requests.length, 2);
  assert.equal((options[0] as { maxOutputTokens: number }).maxOutputTokens, 8000);
  assert.equal(result.preview.summary, summary); // More than 1500 characters, never sliced.
  assert.equal(result.preview.compactedCount, 3);
  assert.match(saved.summary.content, /当前用户任务（原文）：\n继续完成迁移/);
  assert.ok(entries.some(({ message }) => message.content === "不要引入新依赖"));
  assert.ok(
    isValidStoredCompactionSummary(
      saved.summary.content,
      saved.summary.providerData?.picoSummaryFormat,
    ),
  );
  assert.equal(
    isValidStoredCompactionSummary(wrapFullCompactionSummary("broken"), "sections_v1"),
    false,
  );
  const longSource = "x".repeat(5000) + "SOURCE_TAIL";
  await compactor.preview(
    session,
    [
      { role: "assistant", content: saved.summary.content },
      { role: "user", content: longSource },
      { role: "assistant", content: "finished" },
      { role: "assistant", content: "tail" },
    ],
    { trigger: "manual", inputBudgetTokens: 16000 },
    undefined,
    summary,
  );
  assert.ok(requests.at(-1)![1]!.content.includes(summary));
  assert.ok(requests.at(-1)![1]!.content.includes(longSource));
});

test("Maka summary rejects repeated malformed or output-truncated completions without checkpoint writes", async () => {
  for (const response of [
    { role: "assistant" as const, content: "```\n## Goal\nplaceholder" },
    { role: "assistant" as const, content: summary, providerData: { finishReason: "length" } },
  ]) {
    let calls = 0;
    let writes = 0;
    const compactor = new FullCompactor({
      maxAttempts: 1,
      provider: {
        async generate() {
          calls++;
          return response;
        },
      },
    });
    const result = await recordRuntimeCompactionCheckpoint({
      session: { id: "reject" },
      compactor,
      request: { trigger: "manual", inputBudgetTokens: 16000 },
      runtimeRun: {
        claimsSession: () => true,
        readModelHistoryEntries: async () =>
          history.map((message, index) => ({ eventId: `${index}`, message })),
        findLastCompactionCheckpoint: async () => undefined,
        recordCheckpoint: async () => {
          writes++;
        },
      },
    });
    assert.equal(result, undefined);
    assert.equal(calls, 2);
    assert.equal(writes, 0);
  }
});

test("Maka summarizer overflow retreats only to the last proven accepted prefix", async () => {
  const { ContextOverflowError } = await import("@pico/core");
  const source: Message[] = [
    ...history.slice(0, 3),
    { role: "assistant", content: "new completed work" },
    { role: "assistant", content: "tail" },
  ];
  for (const acceptedHistoryPrefixCount of [undefined, 2]) {
    let calls = 0;
    const provider: LLMProvider = {
      async generate() {
        calls++;
        if (calls === 1) throw new ContextOverflowError("input too large");
        return { role: "assistant", content: summary };
      },
    };
    const result = await new FullCompactor({ provider, maxAttempts: 3 }).preview(
      { id: "proven" },
      source,
      {
        trigger: "manual",
        inputBudgetTokens: 16000,
        ...(acceptedHistoryPrefixCount ? { acceptedHistoryPrefixCount } : {}),
      },
    );
    assert.equal(calls, acceptedHistoryPrefixCount ? 2 : 1);
    assert.equal(result?.compactedCount, acceptedHistoryPrefixCount);
  }
});

test("Maka safe prefix leaves an open tool batch intact and checkpoint failures never apply history", async () => {
  const source: Message[] = [
    { role: "user", content: "old task" },
    { role: "assistant", content: "old result" },
    { role: "user", content: "active task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "open-call", name: "read_file", arguments: "{}" }],
    },
  ];
  const compactor = new FullCompactor({
    provider: {
      async generate() {
        return { role: "assistant", content: summary };
      },
    },
  });
  const preview = await compactor.preview({ id: "open-batch" }, source, {
    trigger: "manual",
    inputBudgetTokens: 16000,
  });
  assert.equal(preview?.compactedCount, 3);
  const entries = source.map((message, i) => ({ eventId: `event-${i}`, message }));
  const before = structuredClone(entries);
  const failure = new Error("durable write failed");
  await assert.rejects(
    recordRuntimeCompactionCheckpoint({
      session: { id: "write-failure" },
      compactor,
      request: { trigger: "manual", inputBudgetTokens: 16000 },
      runtimeRun: {
        claimsSession: () => true,
        readModelHistoryEntries: async () => entries,
        findLastCompactionCheckpoint: async () => undefined,
        recordCheckpoint: async () => {
          throw failure;
        },
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(entries, before);
});

test("Maka exact malformed summary source is latched while changed history remains eligible", async () => {
  let calls = 0;
  const compactor = new FullCompactor({
    maxAttempts: 1,
    provider: {
      async generate() {
        calls++;
        return { role: "assistant", content: "broken" };
      },
    },
  });
  const identity = { id: "malformed-circuit" };
  const request = { trigger: "manual" as const, inputBudgetTokens: 16000 };
  assert.equal(await compactor.preview(identity, history, request), undefined);
  assert.equal(calls, 2);
  assert.equal(await compactor.preview(identity, history, request), undefined);
  assert.equal(calls, 2);
  const changed = history.map((message) => ({ ...message, content: `${message.content} changed` }));
  assert.equal(await compactor.preview(identity, changed, request), undefined);
  assert.equal(calls, 4);
});
