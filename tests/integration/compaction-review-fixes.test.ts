/**
 * Review 修复的回归测试：
 * 1. enforceSummaryCharLimit 纯逻辑（优先级裁剪 + 无标题回退 + 双 ## 修复验证）
 * 2. findLastCompactionCheckpoint hard-reset 分支（遇 hard-reset 返回 undefined）
 * 3. findLastCompactionCheckpoint missing-tag 分支（标签缺失返回 undefined）
 * 4. buildEvidenceSnapshot 跳过 checkpoint summary（纯逻辑验证）
 *
 * 纯逻辑测试不需要持久化 Session；持久化分支测试用 PICO_TEST_TMPDIR 绕过沙箱 fsync 限制。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  enforceSummaryCharLimit,
  wrapFullCompactionSummary,
} from "../../src/context/full-compactor.js";
import { Session } from "../../src/engine/session.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { FULL_COMPACTION_SUMMARY_MARKER } from "../../src/context/compaction-markers.js";
import { computeCheckpointSourceDigest } from "../../src/context/runtime-compaction-checkpoint.js";

const TEST_ROOT = process.env.PICO_TEST_TMPDIR ?? tmpdir();
async function mkTestDir(prefix: string): Promise<string> {
  return mkdtemp(join(TEST_ROOT, prefix));
}

// ============================================================
// 1. enforceSummaryCharLimit 纯逻辑测试
// ============================================================

test("enforceSummaryCharLimit: 短摘要原样返回", () => {
  const summary = "## 任务目标\n短摘要";
  const result = enforceSummaryCharLimit(summary, 1500);
  assert.equal(result, summary);
});

test("enforceSummaryCharLimit: 超长摘要按优先级裁剪，无双重 ## 前缀", () => {
  // 构造 6 段超长摘要，每段约 400 字
  const section = (title: string) => `## ${title}\n${"x".repeat(400)}\n`;
  const summary =
    section("任务目标") +
    section("进展") +
    section("关键决策与约束") +
    section("已尝试/失败路径") +
    section("下一步") +
    section("关键上下文");

  const result = enforceSummaryCharLimit(summary, 1500);
  assert.ok(result.length <= 1600, `结果应接近 1500 上限，实际 ${result.length}`);
  assert.ok(result.includes("[摘要已截断"), "应包含截断标记");

  // 验证无双重 ## 前缀
  assert.doesNotMatch(result, /## ## /u, "不应有双重 ## 前缀");

  // 验证高优先级 section 被保留
  assert.match(result, /## 任务目标/u, "应保留任务目标段");
  assert.match(result, /## 关键上下文/u, "应保留关键上下文段");

  // 验证低优先级 section 被丢弃
  assert.doesNotMatch(result, /## 进展/u, "进展段应被裁掉");
  assert.doesNotMatch(result, /## 下一步/u, "下一步段应被裁掉");
});

test("enforceSummaryCharLimit: 无标题纯文本回退到 head 截断", () => {
  const summary = "x".repeat(3000); // 无 ## 标题
  const result = enforceSummaryCharLimit(summary, 500);
  assert.ok(result.includes("[摘要已截断"), "应包含截断标记");
  assert.ok(result.length < 600, "应在预算附近");
  assert.ok(result.includes("x".repeat(100)), "应保留 head 部分");
});

test("enforceSummaryCharLimit: 单段超预算时截断该段", () => {
  const summary = `## 任务目标\n${"y".repeat(2000)}`;
  const result = enforceSummaryCharLimit(summary, 300);
  assert.ok(result.includes("[摘要已截断"), "应包含截断标记");
  assert.match(result, /## 任务目标/u, "应保留任务目标标题");
  assert.ok(result.length <= 400, "应在预算附近");
});

// ============================================================
// 2. findLastCompactionCheckpoint hard-reset 分支
// ============================================================

test("findLastCompactionCheckpoint: 遇 hard-reset checkpoint 返回 undefined", async (t) => {
  const root = await mkTestDir("pico-hard-reset-skip-");
  const session = new Session("hard-reset-skip", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  // 先写一个正常 checkpoint
  const history = [
    { role: "user" as const, content: `msg ${"context ".repeat(40)}` },
    { role: "assistant" as const, content: `resp ${"context ".repeat(40)}` },
    { role: "user" as const, content: "latest" },
    { role: "assistant" as const, content: "reply" },
  ];
  const seedRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await seedRun.run(async () => {
    await seedRun.commitMessages(session, history);
    const beforeNormal = await seedRun.readModelHistoryEntries();
    await seedRun.recordCheckpoint({
      checkpointId: "checkpoint:normal-1",
      coveredEventCount: 2,
      sourceDigest: computeCheckpointSourceDigest(beforeNormal.slice(0, 2)),
      throughEventId: beforeNormal[1]!.eventId,
      summary: {
        role: "assistant",
        content: wrapFullCompactionSummary("## 任务目标\n正常摘要"),
      },
    });
    // 再写一个 hard-reset checkpoint
    const beforeReset = await seedRun.readModelHistoryEntries();
    await seedRun.recordCheckpoint({
      checkpointId: "hard-reset:after-overflow",
      coveredEventCount: beforeReset.length,
      sourceDigest: computeCheckpointSourceDigest(beforeReset),
      throughEventId: beforeReset.at(-1)!.eventId,
      summary: {
        role: "assistant",
        content: "[CONTEXT RESET] evidence snapshot...",
      },
    });
  });

  // hard-reset 之后的 findLastCompactionCheckpoint 应返回 undefined
  // （hard-reset 使之前的 checkpoint 失效，不再向前查找）
  const run2 = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = await run2.findLastCompactionCheckpoint();
  assert.equal(result, undefined, "遇 hard-reset 应返回 undefined，不返回更早的 checkpoint");
});

// ============================================================
// 3. findLastCompactionCheckpoint missing-tag 分支
// ============================================================

test("findLastCompactionCheckpoint: 标签缺失时返回 undefined", async (t) => {
  const root = await mkTestDir("pico-missing-tag-");
  const session = new Session("missing-tag", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  const history = [
    { role: "user" as const, content: `msg ${"context ".repeat(40)}` },
    { role: "assistant" as const, content: `resp ${"context ".repeat(40)}` },
  ];
  const seedRun = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await seedRun.run(async () => {
    await seedRun.commitMessages(session, history);
    const entries = await seedRun.readModelHistoryEntries();
    // 写一个不带 XML 标签的 checkpoint（模拟旧格式或损坏数据）
    await seedRun.recordCheckpoint({
      checkpointId: "checkpoint:no-tags",
      coveredEventCount: 1,
      sourceDigest: computeCheckpointSourceDigest(entries.slice(0, 1)),
      throughEventId: entries[0]!.eventId,
      summary: {
        role: "assistant",
        content: "[上下文压缩 — 仅供参考] 这段没有 XML 标签 --- 历史摘要结束 ---",
      },
    });
  });

  const run2 = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  const result = await run2.findLastCompactionCheckpoint();
  assert.equal(result, undefined, "标签缺失时应返回 undefined，不 fallback 到 content.trim()");
});

// ============================================================
// 4. buildEvidenceSnapshot 间接验证：硬重置 summary 不含 checkpoint summary
// ============================================================
// buildEvidenceSnapshot 未导出，通过 FullCompactor 的 wrapped summary 格式间接验证：
// 确认 wrapped summary 以 FULL_COMPACTION_SUMMARY_MARKER 开头（buildEvidenceSnapshot 应跳过它）
test("wrapFullCompactionSummary 产生正确的 marker 前缀供 buildEvidenceSnapshot 跳过", () => {
  const wrapped = wrapFullCompactionSummary("## 任务目标\n测试");
  assert.ok(
    wrapped.startsWith(FULL_COMPACTION_SUMMARY_MARKER),
    "wrapped summary 应以 FULL_COMPACTION_SUMMARY_MARKER 开头",
  );
  assert.ok(wrapped.includes("<pico_compaction_summary>"), "应包含 XML 开标签");
  assert.ok(wrapped.includes("</pico_compaction_summary>"), "应包含 XML 闭标签");
});
