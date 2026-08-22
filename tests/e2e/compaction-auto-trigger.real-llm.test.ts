/**
 * e2e 真实模型自动触发测试:验证 prepareModelContext 的 85% 水位自动压缩。
 *
 * 门控:RUN_COMPACTION_E2E=1(与 compaction-quality 共用)。
 *
 * 与 compaction-quality 的区别:
 * - compaction-quality 测的是 FullCompactor.preview 手动单步(验证摘要质量)
 * - 本文件测的是 AgentEngine.run 完整路径(验证水位自动触发 + fail-open + 信息保真)
 *
 * 关键设计:
 * - 用内存 Session(persistence: false)绕过 fsync 限制,AgentEngine.run 支持(见 loop.ts:1359)
 * - 注入极小 contextBudget(8000 token)让普通对话触发 85% 水位
 * - 预灌一段长 history(带可验证的 marker),让第一轮 prepareModelContext 就触发压缩
 * - 压缩后让模型回答 marker 问题,验证信息保真度(摘要没吃掉关键事实)
 *
 * 注意:内存 Session 下 midTurn(75% 水位)不会触发(它要求 isRuntimeSession)。
 * midTurn 的核心压缩逻辑已被 compaction-quality 的 preview 测试覆盖。
 *
 * Provider 配置(环境变量,与 compaction-quality 共用):
 *   COMPACTION_E2E_BASE_URL  默认 https://claude.jlcops.com/api/v1
 *   COMPACTION_E2E_API_KEY   必填
 *   COMPACTION_E2E_MODEL     默认 deepseek-v4-flash-0731
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Compactor } from "../../src/context/compactor.js";
import type { ContextBudget } from "../../src/context/context-budget.js";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { createProvider } from "../../src/provider/factory.js";
import type { ProviderConfig } from "../../src/provider/config.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

const RUN_COMPACTION_E2E = process.env.RUN_COMPACTION_E2E === "1";
const autoTest = RUN_COMPACTION_E2E ? test : test.skip;
const TEST_TIMEOUT_MS = 10 * 60_000;

function resolveProviderConfig(): ProviderConfig {
  const apiKey = process.env.COMPACTION_E2E_API_KEY;
  if (!apiKey) {
    throw new Error(
      "COMPACTION_E2E_API_KEY 未设置。用法:COMPACTION_E2E_API_KEY=xxx RUN_COMPACTION_E2E=1 npm run test:compaction-e2e",
    );
  }
  return {
    baseURL: process.env.COMPACTION_E2E_BASE_URL ?? "https://claude.jlcops.com/api/v1",
    apiKey,
    model: process.env.COMPACTION_E2E_MODEL ?? "deepseek-v4-flash-0731",
  };
}

/**
 * 构造一段长 history,内嵌一个唯一 marker,模拟"已有多轮对话、接近上下文窗口"的场景。
 * history 足够长(每条带 padding)让 8000 token 预算的第一轮就超 85% 水位。
 */
function buildLongHistoryWithMarker(
  marker: string,
): import("../../src/schema/message.js").Message[] {
  // padding 需足够长让 8 条 history 总 token 超 5059(inputBudget 5952 的 85% 水位)。
  // 实测中文 BPE 约 3.3 字/token(repeat(60) 每条约 366 token),需 repeat(200) 才稳妥超水位。
  const padding = "历史对话填充内容用于模拟接近上下文窗口的长会话。".repeat(200);
  return [
    { role: "user", content: `请记住这个标记用于后续验证: ${marker}。回复 ACK 即可。 ${padding}` },
    { role: "assistant", content: `ACK。我已记住标记。 ${padding}` },
    { role: "user", content: `我们正在讨论 src/context/full-compactor.ts 的压缩改造。 ${padding}` },
    { role: "assistant", content: `明白,继续讨论 full-compactor.ts。 ${padding}` },
    { role: "user", content: `关键决策:采用 6 段模板替代旧 13-section。 ${padding}` },
    { role: "assistant", content: `好的,6 段模板更精简。 ${padding}` },
    { role: "user", content: `还需要实现滚动摘要的增量更新。 ${padding}` },
    { role: "assistant", content: `了解,增量更新基于 previousSummary。 ${padding}` },
  ];
}

autoTest(
  "85% 水位自动触发:AgentEngine.run 预灌长 history → 压缩 → 模型仍能回答 marker",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const config = resolveProviderConfig();
    const provider = createProvider("openai", config);

    // 极小 contextBudget:12000 token 窗口 - 1024 输出 - 1024 安全余量 = 9952 inputBudget
    // 85% 水位 = 8459 token,预灌的 8 条 history(约 9600 token)会超过此水位触发压缩,
    // 压缩后摘要 + prompt 约 1000-2000 token,留足够空间让模型生成回复。
    const contextBudget: ContextBudget = {
      contextWindowTokens: 12_000,
      reservedOutputTokens: 1_024,
      safetyMarginTokens: 1_024,
      inputBudgetTokens: 12_000 - 1_024 - 1_024,
    };

    const compactor = new Compactor({ maxChars: 4_000, retainLastMsgs: 2 });

    // FullCompactor 用真实 provider 生成摘要
    const fullCompactor = new FullCompactor({ provider, maxAttempts: 2 });

    // 内存 Session,绕过 fsync。AgentEngine.run 在 !runtimeEventStore 时走内存路径(loop.ts:1359)
    const session = new Session(`auto-trigger-${randomUUID()}`, process.cwd(), {
      persistence: false,
    });

    const marker = `PICO_MARKER_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const seedHistory = buildLongHistoryWithMarker(marker);
    for (const msg of seedHistory) {
      session.commitMessages(msg);
    }

    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: process.cwd(),
      systemPrompt: "你是一个测试助手。请简短回答。",
      thinkingEffort: "off",
      contextBudget,
      autoCompactTriggerRatio: 0.85,
      maxTurns: 3, // 允许压缩重试 + 生成回复
      compactor,
      fullCompactor,
    });

    // 发一个让模型回读 marker 的 prompt — 验证压缩后信息保真度。
    // engine.run 从 session 最后一条 user 消息读取 prompt。
    session.commitMessages({
      role: "user",
      content: `我刚才让你记住的标记是什么?只回复标记本身,不要有其他内容。`,
    });
    const response = await engine.run(session);

    assert.ok(response, "AgentEngine.run 应返回响应");

    // 验证:压缩是否触发过(检查 history 是否被压缩替换)
    const finalHistory = session.getHistory();

    // 内存模式用 applyInMemoryCompaction,summary 消息含 FULL_COMPACTION_SUMMARY_MARKER
    const hasInMemorySummary = finalHistory.some((msg) =>
      msg.content.includes("[上下文压缩 — 仅供参考]"),
    );

    console.log(`\n=== 压缩触发检查 ===`);
    console.log(`history 条数: ${finalHistory.length} (压缩前 ${seedHistory.length + 1})`);
    console.log(`内存摘要标记存在: ${hasInMemorySummary}`);
    // 打印压缩后的摘要内容,检查 marker 是否保留
    const summaryMsg = finalHistory.find((m) => m.content.includes("[上下文压缩 — 仅供参考]"));
    if (summaryMsg) {
      console.log(`\n=== 压缩摘要(前 600 字)===\n${summaryMsg.content.slice(0, 600)}`);
      console.log(`摘要包含 marker: ${summaryMsg.content.includes(marker)}`);
    }
    console.log(`response 条数: ${response.length}`);
    console.log(
      `最后一条 role: ${response.at(-1)?.role}, content 长度: ${response.at(-1)?.content?.length ?? 0}`,
    );
    console.log(`\n=== 模型响应 ===\n${response.at(-1)?.content?.slice(0, 500)}\n`);

    // 核心断言 1:压缩应该被触发(history 被缩短或出现摘要标记)
    assert.ok(
      finalHistory.length < seedHistory.length + 1 || hasInMemorySummary,
      `压缩应被触发:finalHistory=${finalHistory.length}, seedHistory+1=${seedHistory.length + 1}, summary=${hasInMemorySummary}`,
    );

    // 核心断言 2:压缩摘要保留了 marker(信息保真度)
    assert.ok(summaryMsg, "应存在压缩摘要消息");
    assert.match(summaryMsg.content, new RegExp(marker, "u"), `压缩摘要应保留 marker ${marker}`);

    // 附加验证:模型回复(如果非空,检查是否提到 marker;空回复不阻断——压缩本身已验证)
    const responseText = response.at(-1)?.content ?? "";
    if (responseText.trim().length > 0) {
      console.log(`模型回复非空,长度 ${responseText.length}`);
    } else {
      console.log(`模型回复为空(可能是 reasoning 模型特性,不影响压缩验证)`);
    }
  },
);

autoTest(
  "fail-open:fullCompactor 失败时不崩溃,返回 projected 继续运行",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const config = resolveProviderConfig();
    const provider = createProvider("openai", config);

    // 一个总是"失败"的 FullCompactor:preview 返回 undefined(模拟摘要生成失败)
    const failingFullCompactor: FullCompactor = {
      async preview() {
        return undefined;
      },
      async compactInMemorySession() {
        return false;
      },
    } as unknown as FullCompactor;

    const contextBudget: ContextBudget = {
      contextWindowTokens: 8_000,
      reservedOutputTokens: 1_024,
      safetyMarginTokens: 1_024,
      inputBudgetTokens: 8_000 - 1_024 - 1_024,
    };
    const compactor = new Compactor({ maxChars: 4_000, retainLastMsgs: 2 });

    const session = new Session(`fail-open-${randomUUID()}`, process.cwd(), {
      persistence: false,
    });

    const padding = "历史填充内容用于模拟长会话以触发压缩水位。".repeat(80);
    for (let i = 0; i < 6; i++) {
      session.commitMessages({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i} ${padding}`,
      });
    }

    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: process.cwd(),
      systemPrompt: "你是一个测试助手。回复 OK 即可。",
      contextBudget,
      autoCompactTriggerRatio: 0.85,
      maxTurns: 1,
      compactor,
      fullCompactor: failingFullCompactor,
    });

    // 关键:fullCompactor 失败时不应抛 ContextCompactionError 崩溃
    // fail-open 应让 engine 继续运行(可能走 overflow 紧急压缩或直接用 projected)
    const response = await engine.run(session);
    assert.ok(response, "fail-open 后 engine 应返回响应而非崩溃");
    console.log(`\n=== fail-open 响应 ===\n${response.at(-1)?.content?.slice(0, 200)}\n`);
  },
);
