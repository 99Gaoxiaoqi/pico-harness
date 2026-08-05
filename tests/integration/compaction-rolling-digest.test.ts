/**
 * L1 集成测试:语义压缩改造的控制流验收(mock provider,零成本)。
 *
 * 覆盖三项核心改造的确定性逻辑:
 * 1. 内容哈希 sourceDigest:修改 covered 事件内容但保持 eventId → 重放抛 integrity error
 * 2. 滚动摘要 checkpoint 链:连续两次压缩,第二次 checkpoint 带 previousCheckpointId 指向第一个
 * 3. 新版 digest 带版本前缀 sha256-content:v1:
 *
 * 模型行为(摘要质量、增量更新效果)由 e2e 真实模型测试覆盖,不在此文件。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FullCompactor } from "../../src/context/full-compactor.js";
import {
  CONTENT_DIGEST_V1_PREFIX,
  computeCheckpointSourceDigest,
  recordRuntimeCompactionCheckpoint,
} from "../../src/context/runtime-compaction-checkpoint.js";
import { materializeRuntimeHistory } from "../../src/engine/session-runtime-read-model.js";
import { Session } from "../../src/engine/session.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { Message } from "../../src/schema/message.js";
import type { LLMProvider } from "../../src/provider/interface.js";

/**
 * 测试根目录:优先用 PICO_TEST_TMPDIR(允许 fsync 的目录),回退到 os.tmpdir()。
 * 某些沙箱环境禁止 tmpdir 的 fsync,用项目内目录绕过。
 */
const TEST_ROOT = process.env.PICO_TEST_TMPDIR ?? tmpdir();
async function mkTestDir(prefix: string): Promise<string> {
  return mkdtemp(join(TEST_ROOT, prefix));
}

function mockProvider(content: string): LLMProvider {
  return { async generate() {
    return { role: "assistant", content };
  } };
}

function paddedHistory(): Message[] {
  return [
    { role: "user", content: `old user one ${"context ".repeat(40)}` },
    { role: "assistant", content: `old assistant one ${"context ".repeat(40)}` },
    { role: "user", content: `old user two ${"context ".repeat(40)}` },
    { role: "assistant", content: `old assistant two ${"context ".repeat(40)}` },
    { role: "user", content: "latest request" },
    { role: "assistant", content: "latest response" },
  ];
}

test("computeCheckpointSourceDigest 带版本前缀并对内容变化敏感", () => {
  const entries = [
    {
      eventId: "evt-1",
      message: { role: "user" as const, content: "hello world" },
    },
    {
      eventId: "evt-2",
      message: { role: "assistant" as const, content: "hi there" },
    },
  ];
  const digest = computeCheckpointSourceDigest(entries);
  assert.ok(digest.startsWith(CONTENT_DIGEST_V1_PREFIX), "digest 应带 v1 版本前缀");

  // 同样内容 → 同样 digest(确定性)
  const digest2 = computeCheckpointSourceDigest(entries);
  assert.equal(digest, digest2);

  // 内容变了但 eventId 不变 → digest 变(旧逻辑只哈希 eventId 不会变)
  const tampered = [
    { eventId: "evt-1", message: { role: "user" as const, content: "TAMPERED" } },
    { eventId: "evt-2", message: { role: "assistant" as const, content: "hi there" } },
  ];
  const tamperedDigest = computeCheckpointSourceDigest(tampered);
  assert.notEqual(digest, tamperedDigest, "内容变化应导致 digest 变化");
});

test("Runtime checkpoint 使用内容哈希 digest 且重放校验通过", async (t) => {
  const root = await mkTestDir("pico-rolling-digest-");
  const session = new Session("rolling-digest", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  const originalHistory = paddedHistory();
  const seedRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await seedRun.run(async () => {
    await seedRun.commitMessages(session, originalHistory);
  });

  const compactionRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = await compactionRun.run(() =>
    recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: compactionRun,
      compactor: new FullCompactor({ provider: mockProvider("digest checkpoint summary"), maxAttempts: 1 }),
      request: { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
    }),
  );

  assert.ok(result);
  // checkpoint 事件应记录内容哈希 digest(带版本前缀)
  const events = await session.runtimeEventStore!.readSession(session.id);
  const checkpointEvents = events.filter((e) => e.kind === "context.checkpoint.recorded");
  assert.equal(checkpointEvents.length, 1);
  const storedDigest = checkpointEvents[0]!.data.sourceDigest;
  assert.ok(storedDigest.startsWith(CONTENT_DIGEST_V1_PREFIX), "存储的 digest 应带版本前缀");

  // 重放校验通过(内容未变)
  const modelHistory = materializeRuntimeHistory(events);
  assert.ok(modelHistory.length < originalHistory.length, "压缩后 history 应更短");
});

test("滚动摘要:连续两次压缩,第二个 checkpoint 带 previousCheckpointId 指向第一个", async (t) => {
  const root = await mkTestDir("pico-rolling-chain-");
  const session = new Session("rolling-chain", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  // 初始长 history
  const history1 = paddedHistory();
  const seedRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await seedRun.run(async () => {
    await seedRun.commitMessages(session, history1);
  });

  // 第一次压缩
  let callCount = 0;
  const capturingProvider: LLMProvider = {
    async generate() {
      callCount++;
      return {
        role: "assistant",
        content: `## 任务目标\n压缩摘要 #${callCount}\n\n## 关键上下文\n- 文件 src/test.ts`,
      };
    },
  };

  const run1 = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result1 = await run1.run(() =>
    recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: run1,
      compactor: new FullCompactor({ provider: capturingProvider, maxAttempts: 1 }),
      request: { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
    }),
  );
  assert.ok(result1, "第一次压缩应成功");

  // 追加更多内容,制造第二次压缩需求
  const run2 = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run2.run(async () => {
    await run2.commitMessages(session, [
      { role: "user", content: `new user ${"padding ".repeat(40)}` },
      { role: "assistant", content: `new assistant ${"padding ".repeat(40)}` },
      { role: "user", content: "second latest request" },
      { role: "assistant", content: "second latest response" },
    ]);
  });

  // 第二次压缩
  const result2 = await run2.run(() =>
    recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: run2,
      compactor: new FullCompactor({ provider: capturingProvider, maxAttempts: 1 }),
      request: { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
    }),
  );
  assert.ok(result2, "第二次压缩应成功");

  // 验证 checkpoint 链:第二个 checkpoint 应带 previousCheckpointId 指向第一个
  const events = await session.runtimeEventStore!.readSession(session.id);
  const checkpointEvents = events.filter((e) => e.kind === "context.checkpoint.recorded");
  assert.equal(checkpointEvents.length, 2, "应有 2 个 checkpoint");

  const firstCheckpointId = checkpointEvents[0]!.data.checkpointId;
  const secondCheckpoint = checkpointEvents[1]!;
  assert.equal(
    secondCheckpoint.data.previousCheckpointId,
    firstCheckpointId,
    "第二个 checkpoint 的 previousCheckpointId 应指向第一个",
  );
  assert.equal(
    checkpointEvents[0]!.data.previousCheckpointId,
    undefined,
    "第一个 checkpoint 不应有 previousCheckpointId",
  );
});

test("findLastCompactionCheckpoint 返回上一个 checkpoint 的摘要正文", async (t) => {
  const root = await mkTestDir("pico-find-last-");
  const session = new Session("find-last", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  const history = paddedHistory();
  const seedRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await seedRun.run(async () => {
    await seedRun.commitMessages(session, history);
  });

  // 压缩前:无 checkpoint
  const run1 = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const before = await run1.findLastCompactionCheckpoint();
  assert.equal(before, undefined, "压缩前应无上一个 checkpoint");

  // 压缩
  await run1.run(() =>
    recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: run1,
      compactor: new FullCompactor({
        provider: mockProvider("## 任务目标\nfindLast 测试\n\n## 关键上下文\n- 文件 a.ts"),
        maxAttempts: 1,
      }),
      request: { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
    }),
  );

  // 压缩后:findLastCompactionCheckpoint 应返回摘要正文(去掉 REFERENCE-ONLY 包装)
  const run2 = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const after = await run2.findLastCompactionCheckpoint();
  assert.ok(after, "压缩后应返回上一个 checkpoint");
  assert.ok(after.summaryText.includes("findLast 测试"), "摘要正文应不含 REFERENCE-ONLY 包装");
  assert.ok(!after.summaryText.includes("[上下文压缩"), "摘要正文应去掉 SUMMARY_PREFIX");
});
