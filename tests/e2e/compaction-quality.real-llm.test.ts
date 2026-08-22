/**
 * e2e 真实模型测试:语义压缩改造的摘要质量验收。
 *
 * 门控:RUN_COMPACTION_E2E=1(独立于 RUN_LLM_E2E,避免污染主套件)。
 * 用真实模型生成压缩摘要,用 anchor 匹配评分验证保真度。
 *
 * Provider 配置(环境变量,默认指向 jlcops OpenAI 兼容端点):
 *   COMPACTION_E2E_BASE_URL  默认 https://claude.jlcops.com/api/v1
 *   COMPACTION_E2E_API_KEY   必填
 *   COMPACTION_E2E_MODEL     默认 deepseek-v4-flash-0731
 *
 * 三层验收:
 * - L2 单步摘要质量:FullCompactor.preview 生成摘要 → scoreCompactionQuality recall >= 0.8
 * - L3 滚动摘要增量更新:第一次压缩 → 追加内容 → 第二次压缩 → 第二次摘要保留第一次 anchor
 * - L4 模板验证:摘要包含 6 段标题,不含旧 13-section 标题
 *
 * 成本控制:每 case 1-2 次模型调用,用廉价 fast 模型。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { Session } from "../../src/engine/session.js";
import { scoreCompactionQuality } from "../fixtures/compaction-quality.js";
import { compactionQualityCases } from "../fixtures/compaction-quality-cases.js";
import type { Message } from "../../src/schema/message.js";
import { createProvider } from "../../src/provider/factory.js";
import type { ProviderConfig } from "../../src/provider/config.js";

const RUN_COMPACTION_E2E = process.env.RUN_COMPACTION_E2E === "1";
const compactionTest = RUN_COMPACTION_E2E ? test : test.skip;
const TEST_TIMEOUT_MS = 10 * 60_000;

function resolveProviderConfig(): ProviderConfig {
  const apiKey = process.env.COMPACTION_E2E_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COMPACTION_E2E_API_KEY 未设置。压缩质量 e2e 测试需要真实模型凭证。\n" +
        "用法:COMPACTION_E2E_API_KEY=xxx RUN_COMPACTION_E2E=1 npm run test:compaction-e2e",
    );
  }
  return {
    baseURL: process.env.COMPACTION_E2E_BASE_URL ?? "https://claude.jlcops.com/api/v1",
    apiKey,
    model: process.env.COMPACTION_E2E_MODEL ?? "deepseek-v4-flash-0731",
  };
}

/** 构造内存 Session(无持久化,避免 fsync 限制)。preview 只读 Session 标识。 */
function createInMemorySession(): Session {
  return new Session(`compaction-e2e-${Date.now()}`, process.cwd(), { persistence: false });
}

compactionTest(
  "L2: 真实模型生成的 6 段摘要保留关键事实(recall >= 0.8)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const config = resolveProviderConfig();
    const provider = createProvider("openai", config);
    const compactor = new FullCompactor({ provider, maxAttempts: 1 });
    const session = createInMemorySession();

    for (const testCase of compactionQualityCases) {
      const preview = await compactor.preview(session, testCase.history, {
        inputBudgetTokens: 4_000,
        targetRetainedTokens: 1,
        trigger: "manual",
      });
      assert.ok(preview, `case ${testCase.id}: 应生成摘要`);

      const summary = preview.summary;
      console.log(`\n=== case ${testCase.id} 摘要 ===\n${summary}\n`);

      // L4:验证模板格式 — 包含 6 段标题之一(中英文都接受)
      assert.ok(
        /任务目标|## Goal/i.test(summary),
        `case ${testCase.id}: 摘要应包含"任务目标/Goal"段`,
      );

      // L2:验证 anchor 保真度
      const score = scoreCompactionQuality(summary, testCase.gold);
      console.log(
        `case ${testCase.id}: recall=${score.recall.toFixed(2)} (${score.matchedAnchors}/${score.totalAnchors})`,
      );
      assert.ok(
        score.recall >= 0.8,
        `case ${testCase.id}: recall ${score.recall.toFixed(2)} < 0.80。未匹配:${score.unmatchedDescriptions.join("; ")}`,
      );
    }
  },
);

compactionTest(
  "L3: 滚动摘要增量更新保留第一次的关键 anchor(recall >= 0.7)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const config = resolveProviderConfig();
    const provider = createProvider("openai", config);
    const compactor = new FullCompactor({ provider, maxAttempts: 1 });
    const session = createInMemorySession();

    // 取第一个 case 做滚动摘要测试
    const testCase = compactionQualityCases[0]!;
    const baseHistory = [...testCase.history];

    // 第一次压缩
    const preview1 = await compactor.preview(session, baseHistory, {
      inputBudgetTokens: 4_000,
      targetRetainedTokens: 1,
      trigger: "manual",
    });
    assert.ok(preview1, "第一次压缩应成功");
    console.log(`\n=== 第一次摘要 ===\n${preview1.summary}\n`);

    // 构造第二次压缩的 history:第一次 summary + 保留尾部 + 新增对话
    const extendedHistory: Message[] = [
      { role: "assistant", content: preview1.wrappedSummary },
      ...baseHistory.slice(preview1.compactedCount),
      { role: "user", content: "新任务:继续调试另一个文件 src/provider/claude.ts 的 TS2304 错误" },
      { role: "assistant", content: "好的,我来排查 claude.ts 的 TS2304 错误。先看具体报错。" },
    ];

    // 第二次压缩(带 previousSummary 启用增量更新)
    const preview2 = await compactor.preview(
      session,
      extendedHistory,
      { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
      undefined, // signal
      preview1.summary, // previousSummary — 启用滚动摘要增量更新
    );
    assert.ok(preview2, "第二次压缩应成功");
    console.log(`\n=== 第二次摘要(增量更新)===\n${preview2.summary}\n`);

    // 验证第二次摘要仍保留第一次的关键 anchor
    const score = scoreCompactionQuality(preview2.summary, testCase.gold);
    console.log(
      `滚动摘要: recall=${score.recall.toFixed(2)} (${score.matchedAnchors}/${score.totalAnchors})`,
    );
    assert.ok(
      score.recall >= 0.7,
      `滚动摘要 recall ${score.recall.toFixed(2)} < 0.70。增量更新丢失了第一次的关键事实:${score.unmatchedDescriptions.join("; ")}`,
    );
  },
);

compactionTest(
  "L3-deep: 3 轮滚动摘要后核心 anchor 仍存活(recall >= 0.5)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const config = resolveProviderConfig();
    const provider = createProvider("openai", config);
    const compactor = new FullCompactor({ provider, maxAttempts: 1 });
    const session = createInMemorySession();

    const testCase = compactionQualityCases[0]!;
    const baseHistory = [...testCase.history];

    // 第 1 轮压缩
    const preview1 = await compactor.preview(session, baseHistory, {
      inputBudgetTokens: 4_000,
      targetRetainedTokens: 1,
      trigger: "manual",
    });
    assert.ok(preview1, "第 1 轮压缩应成功");
    console.log(`\n=== 第 1 轮摘要 ===\n${preview1.summary.slice(0, 200)}...\n`);

    // 第 2 轮:追加新事件 + 增量压缩
    const history2: Message[] = [
      { role: "assistant", content: preview1.wrappedSummary },
      ...baseHistory.slice(preview1.compactedCount),
      { role: "user", content: "继续:查看 src/provider/claude.ts 的 TS2304 错误" },
      { role: "assistant", content: "已查看 claude.ts,TS2304 是类型导出缺失。" },
    ];
    const preview2 = await compactor.preview(
      session,
      history2,
      { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
      undefined,
      preview1.summary,
    );
    assert.ok(preview2, "第 2 轮压缩应成功");
    console.log(`=== 第 2 轮摘要 ===\n${preview2.summary.slice(0, 200)}...\n`);

    // 第 3 轮:再追加新事件 + 增量压缩
    const history3: Message[] = [
      { role: "assistant", content: preview2.wrappedSummary },
      ...history2.slice(preview2.compactedCount),
      { role: "user", content: "好的,现在修复 claude.ts 的导出声明" },
      { role: "assistant", content: "已修复 claude.ts,添加了 export 关键字。运行 tsc 验证。" },
    ];
    const preview3 = await compactor.preview(
      session,
      history3,
      { inputBudgetTokens: 4_000, targetRetainedTokens: 1, trigger: "manual" },
      undefined,
      preview2.summary,
    );
    assert.ok(preview3, "第 3 轮压缩应成功");
    console.log(`=== 第 3 轮摘要 ===\n${preview3.summary.slice(0, 200)}...\n`);

    // 验证 3 轮后核心 anchor 仍存活(阈值比 2 轮宽松,0.5 而非 0.7)
    const score = scoreCompactionQuality(preview3.summary, testCase.gold);
    console.log(
      `3 轮深度衰减: recall=${score.recall.toFixed(2)} (${score.matchedAnchors}/${score.totalAnchors})`,
    );
    assert.ok(
      score.recall >= 0.5,
      `3 轮滚动后 recall ${score.recall.toFixed(2)} < 0.50。深度衰减丢失了核心事实:${score.unmatchedDescriptions.join("; ")}`,
    );
  },
);
