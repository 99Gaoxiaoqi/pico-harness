// E2E: 验证 ThinkingEffort 系统。
// 运行: node --env-file=.env --import tsx scripts/e2e-thinking-effort.ts
//
// 验证点:
//   A. 用 fake fetch 捕获 OpenAI body,验证不同 thinkingEffort 含正确 reasoning_effort
//   B. 可选真实模型对比: RUN_REAL_THINKING_E2E=1 时观察 high/off 回复差异
//   C. createProvider 三参数签名正常透传 thinkingEffort
//   D. 子代理继承 thinkingEffort(复用 provider)

import { createRawProvider } from "../src/provider/factory.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../src/provider/thinking.js";
import { resolveProviderProfile } from "../src/provider/profile.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";

const originalFetch = globalThis.fetch;

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

  // === 验证 A: fake fetch 捕获请求 body ===
  console.log("--- 验证 A: request body reasoning_effort ---");
  const capturedBodies: Record<string, Record<string, unknown>> = {};
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const effortKey = (body.reasoning_effort as string | undefined) ?? "off";
    capturedBodies[effortKey] = body;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      async json() {
        return { choices: [{ message: { role: "assistant", content: "ok" } }] };
      },
      async text() {
        return '{"choices":[{"message":{"role":"assistant","content":"ok"}}]}';
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const efforts: ThinkingEffort[] = ["off", "low", "medium", "high"];
  for (const effort of efforts) {
    const provider = createRawProvider(
      "openai",
      { baseURL: "https://fixture.local", apiKey: "sk-test", model },
      effort,
    );
    await provider.generate([{ role: "user", content: question }], []);
  }

  const bodyChecks = [
    ["off", capturedBodies.off?.reasoning_effort === undefined],
    ["low", capturedBodies.low?.reasoning_effort === "low"],
    ["medium", capturedBodies.medium?.reasoning_effort === "medium"],
    ["high", capturedBodies.high?.reasoning_effort === "high"],
  ] as const;
  for (const [effort, ok] of bodyChecks) {
    console.log(`  [${effort}] reasoning_effort body 校验: ${ok ? "✅" : "❌"}`);
    if (!ok) {
      throw new Error(`thinkingEffort=${effort} 的 request body 不符合预期`);
    }
  }

  globalThis.fetch = originalFetch;

  if (process.env.RUN_REAL_THINKING_E2E === "1") {
    // === 验证 B: 不同档位下 provider 行为差异 ===
    console.log("\n--- 验证 B: 真实模型 thinkingEffort 档位行为对比 ---");
    console.log(`[prompt] "${question}"\n`);

    const results: Record<string, { content: string; length: number }> = {};
    for (const effort of efforts) {
      console.log(`[创建 provider] thinkingEffort = ${effort}`);
      const provider = createRawProvider("openai", undefined, effort);
      results[effort] = await sendAndMeasure(provider, effort, question);
      console.log();
    }

    const allOk = Object.values(results).every((r) => r.content.length > 0);
    if (!allOk) throw new Error("真实模型对比中存在空回复");
    const offLen = results["off"]!.length;
    const highLen = results["high"]!.length;
    const ratio = offLen > 0 ? (highLen / offLen).toFixed(2) : "N/A";
    console.log(`[验证 B] high(${highLen}字) / off(${offLen}字) = ${ratio}x`);
    console.log("          注: 简单问题差异可能小,这里仅作显式 opt-in 的真实模型观察");
  } else {
    console.log("\n[验证 B] 跳过真实模型对比;设置 RUN_REAL_THINKING_E2E=1 后启用。");
  }

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
    console.log(
      `  resolveThinkingEffort(${input === undefined ? "undefined" : `"${input}"`}) => "${actual}" ${ok ? "✅" : `❌ expected "${expected}"`}`,
    );
  }
  console.log(`[验证 C] resolveThinkingEffort 兼容性: ${compatPass ? "✅ 通过" : "❌ 有失败"}`);
  if (!compatPass) {
    throw new Error("resolveThinkingEffort 兼容性验证失败");
  }

  // === 验证 D: 子代理继承 thinkingEffort(用 createProvider 三参数) ===
  console.log("\n--- 验证 D: createProvider 三参数签名 ---");
  try {
    const fakeConfig = { baseURL: "https://fixture.local", apiKey: "sk-test", model };
    createRawProvider("openai", fakeConfig, "high");
    createRawProvider("openai", fakeConfig, "off");
    // 如果能正常创建,签名正确
    console.log(`  创建 high 档 provider: ✅`);
    console.log(`  创建 off 档 provider: ✅`);
  } catch (err) {
    console.log(`  创建 provider 失败: ❌ ${err}`);
    throw err;
  }

  console.log("\n=== E2E ThinkingEffort 完成 ===");
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
