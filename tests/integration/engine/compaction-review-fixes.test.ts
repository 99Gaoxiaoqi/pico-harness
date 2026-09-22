import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { wrapFullCompactionSummary } from "@pico/pico-host/product-full-compactor";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { FULL_COMPACTION_SUMMARY_MARKER } from "@pico/core";
import { computeCheckpointSourceDigest } from "@pico/runtime/runtime-compaction-checkpoint";

const TEST_ROOT = process.env.PICO_TEST_TMPDIR ?? tmpdir();
async function mkTestDir(prefix: string): Promise<string> {
  return mkdtemp(join(TEST_ROOT, prefix));
}

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
  const seedRun = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
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
  const run2 = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
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
  const seedRun = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
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

  const run2 = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  const result = await run2.findLastCompactionCheckpoint();
  assert.equal(result, undefined, "标签缺失时应返回 undefined，不 fallback 到 content.trim()");
});

// ============================================================
// 4. buildEvidenceSnapshot 间接验证：硬重置 summary 不含 checkpoint summary
// ============================================================
// buildEvidenceSnapshot 未导出，通过 FullCompactor 的 wrapped summary 格式间接验证：
// 确认 wrapped summary 以 FULL_COMPACTION_SUMMARY_MARKER 开头（buildEvidenceSnapshot 应跳过它）
test("wrapFullCompactionSummary 保留完整摘要的结构边界", () => {
  const wrapped = wrapFullCompactionSummary("## 任务目标\n测试");
  assert.ok(
    wrapped.startsWith(FULL_COMPACTION_SUMMARY_MARKER),
    "wrapped summary 应以 FULL_COMPACTION_SUMMARY_MARKER 开头",
  );
  assert.ok(wrapped.includes("<pico_compaction_summary>"), "应包含 XML 开标签");
  assert.ok(wrapped.includes("</pico_compaction_summary>"), "应包含 XML 闭标签");
});
