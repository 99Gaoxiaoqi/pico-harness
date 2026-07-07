// 阶段 5.5 Image/Media 真实 vision e2e — 用真正支持 vision 的模型验证端到端。
// 用法: npx vitest run tests/e2e/stage5-vision-e2e.test.ts
//
// 测试目标:
//   用 Doubao-Seed-2.0-pro(多模态模型)走 Claude 原生协议,
//   发送 16x16 纯蓝色 PNG,验证模型真正看到并识别出颜色。
//   这是真正的端到端 vision 验证(不是只验证翻译格式不报错)。
//
// 凭证:用户提供端点
//   Claude 协议: https://claude.jlcops.com/api/v1 (Doubao-Seed-2.0-pro 支持 vision)
//   API_KEY: cr_81973ecc042bc925ea2ae16eba9b7d946e67761f1765bcdf80c1ef2acdc5dca2

import { describe, it, expect } from "vitest";
import { ClaudeProvider } from "../../src/provider/claude.js";
import type { Message, ImagePart } from "../../src/schema/message.js";

// Claude 协议端点(baseURL 带 /v1,claude.ts 拼 /messages)
const BASE_URL = "https://claude.jlcops.com/api/v1";
const API_KEY = "cr_81973ecc042bc925ea2ae16eba9b7d946e67761f1765bcdf80c1ef2acdc5dca2";
const MODEL = "Doubao-Seed-2.0-pro";

// 16x16 纯蓝色 PNG(RGB 0,0,255)——Node 手写生成的最小有效 PNG
const BLUE_16x16_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNgYPhPIhrVMKph2GoAAJLb/wFh5Z4RAAAAAElFTkSuQmCC";

// 探测端点可用性
let endpointAvailable = false;
try {
  const probe = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
    signal: AbortSignal.timeout(15_000),
  });
  endpointAvailable = probe.ok;
} catch {
  // 连接失败
}

const describeOrSkip = endpointAvailable ? describe : describe.skip;

describeOrSkip("阶段 5.5 真实 vision e2e(Doubao-Seed-2.0-pro)", { timeout: 120000 }, () => {
  it("pico ClaudeProvider 翻译图片 → 模型真正识别出蓝色", async () => {
    // 用 pico 的 ClaudeProvider(它会翻译 images 为 Claude image block)
    const provider = new ClaudeProvider({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
    });

    const blueImage: ImagePart = {
      type: "image_base64",
      mimeType: "image/png",
      data: BLUE_16x16_PNG,
    };

    const messages: Message[] = [
      {
        role: "user",
        content: "图片里是什么颜色?用英文回答(一个词)。",
        images: [blueImage],
      },
    ];

    const result = await provider.generate(messages, []);
    console.log(`[E2E vision] 模型回复: "${result.content}"`);
    console.log(`[E2E vision] reasoning: ${result.reasoning?.slice(0, 200) ?? "(无)"}`);

    // 验证模型真正看到了图片并识别出蓝色
    expect(result.content.length).toBeGreaterThan(0);
    // 模型应该提到 blue(允许不同的大小写或表述)
    const lower = result.content.toLowerCase();
    const mentionsBlue = lower.includes("blue") || lower.includes("蓝");
    expect(mentionsBlue, `模型应该识别出蓝色,实际回复:"${result.content}"`).toBe(true);
  }, 60000);

  it("无图片消息行为不变(回归)", async () => {
    const provider = new ClaudeProvider({
      baseURL: BASE_URL,
      apiKey: API_KEY,
      model: MODEL,
    });

    const result = await provider.generate(
      [{ role: "user", content: "1+1=? 只回答数字。" }],
      [],
    );
    console.log(`[E2E vision-regress] 模型回复: "${result.content}"`);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content).toContain("2");
  }, 30000);
});
