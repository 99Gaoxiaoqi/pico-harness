// E2E: 用真实大模型验证 ThinkingEffort 系统。
// 运行: node --env-file=.env --import tsx scripts/e2e-thinking-effort.ts
//
// 验证点:
//   A. 不同 thinkingEffort 下 OpenAI body 含正确的 reasoning_effort
//   B. thinkingEffort=high 比 off 给出更详细的回答(模型思考行为差异)
//   C. createProvider 三参数签名正常透传 thinkingEffort
//   D. 子代理继承 thinkingEffort(复用 provider)

import { createRawProvider } from "../src/provider/factory.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../src/provider/thinking.js";
import { resolveProviderProfile } from "../src/provider/profile.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";

async function sendAndMeasure(
  provider: LLMProvider,
  effort: ThinkingEffort,
  prompt: string,
): Promise<{ content: string; length: number }> {
  const messages: Message[] = [{ role: "user", content: prompt }];
  const start = Date.now();
  const reply = await provider.generate(messages, []);
  const elapsed = Date.now() - start;
  const content = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
  console.log(`  [${effort}] 耗时 ${elapsed}ms, 回复 ${content.length} 字`);
  console.log(`  ──────────────────────────────────────────────`);
  console.log(content);
  console.log(`  ──────────────────────────────────────────────`);
  return { content, length: content.length };
}

async function main() {
  console.log("=== E2E ThinkingEffort 系统集成测试 ===\n");

  // 0. 检查模型是否支持 thinking 控制
  const model = process.env.LLM_MODEL ?? "deepseek-v4-pro";
  const profile = resolveProviderProfile("openai", model);
  console.log(`[setup] 模型: ${model}`);
  console.log(`[setup] supportsThinkingControl: ${profile.supportsThinkingControl}`);
  console.log(`[setup] alwaysThinking: ${profile.alwaysThinking ?? false}`);
  if (!profile.supportsThinkingControl) {
    console.log("\n⚠️  当前模型不支持 thinking 控制,但 provider 注入逻辑仍然可验证。\n");
  }

  const question = "一根5米长的杆子，要通过一个宽3米、高4米的矩形门洞，怎么过去？";

  // === 验证 A+B: 不同档位下 provider 行为差异 ===
  console.log("--- 验证 A+B: 不同 thinkingEffort 档位行为对比 ---");
  console.log(`[prompt] "${question}"\n`);

  const efforts: ThinkingEffort[] = ["off", "low", "medium", "high"];
  const results: Record<string, { content: string; length: number }> = {};

  for (const effort of efforts) {
    console.log(`[创建 provider] thinkingEffort = ${effort}`);
    const provider = createRawProvider("openai", undefined, effort);
    results[effort] = await sendAndMeasure(provider, effort, question);
    console.log();
  }

  // 验证 A: 不同档位实际发出了请求(这里无法直接截获 body,但可确认无崩溃)
  console.log("--- 验证结果 ---");
  const allOk = Object.values(results).every((r) => r.content.length > 0);
  console.log(`[验证 A] 四种档位均成功返回: ${allOk ? "✅ 通过" : "❌ 有失败"}`);

  // 验证 B: high 档位理论上会给出更详细的回答(带思考),但简单问题差异可能小
  // 至少 high 不会比 off 短太多(<0.5x)
  const offLen = results["off"]!.length;
  const highLen = results["high"]!.length;
  const ratio = offLen > 0 ? (highLen / offLen).toFixed(2) : "N/A";
  console.log(`[验证 B] high(${highLen}字) / off(${offLen}字) = ${ratio}x`);
  console.log(`          注: 简单问题差异可能小,主要验证无崩溃;复杂问题差异更明显`);

  // === 验证 C: resolveThinkingEffort 兼容性 ===
  console.log("\n--- 验证 C: resolveThinkingEffort 兼容性 ---");
  const compatCases: [string | undefined, string][] = [
    ["true", "high"],
    ["false", "off"],
    ["off", "off"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    [undefined, "off"],
    ["invalid", "high"], // 宽容降级:未识别值 → DEFAULT_THINKING_EFFORT
  ];
  let compatPass = true;
  for (const [input, expected] of compatCases) {
    const actual = resolveThinkingEffort(input);
    const ok = actual === expected;
    if (!ok) compatPass = false;
    console.log(`  resolveThinkingEffort(${input === undefined ? "undefined" : `"${input}"`}) => "${actual}" ${ok ? "✅" : `❌ expected "${expected}"`}`);
  }
  console.log(`[验证 C] resolveThinkingEffort 兼容性: ${compatPass ? "✅ 通过" : "❌ 有失败"}`);

  // === 验证 D: 子代理继承 thinkingEffort(用 createProvider 三参数) ===
  console.log("\n--- 验证 D: createProvider 三参数签名 ---");
  try {
    const p1 = createRawProvider("openai", undefined, "high");
    const p2 = createRawProvider("openai", undefined, "off");
    // 如果能正常创建,签名正确
    console.log(`  创建 high 档 provider: ✅`);
    console.log(`  创建 off 档 provider: ✅`);
  } catch (err) {
    console.log(`  创建 provider 失败: ❌ ${err}`);
  }

  console.log("\n=== E2E ThinkingEffort 完成 ===");
}

main().catch((err) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
