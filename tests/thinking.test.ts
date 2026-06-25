// ThinkingEffort 统一思考强度系统的单元测试。
// 覆盖:档位翻译(OpenAI/Anthropic)、CLI 解析兼容、always-thinking 钳位、
// provider body 注入(mock fetch 验证 reasoning_effort / thinking.budget_tokens)。

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  toOpenAIReasoningEffort,
  toAnthropicThinkingConfig,
  anthropicBudgetTokens,
  resolveThinkingEffort,
  clampThinkingEffort,
  isValidThinkingEffort,
  DEFAULT_THINKING_EFFORT,
  type ThinkingEffort,
} from "../src/provider/thinking.js";
import { resolveProviderProfile } from "../src/provider/profile.js";

// ── 翻译函数 ──────────────────────────────────────────────────────

describe("toOpenAIReasoningEffort", () => {
  it("off → undefined(不发送参数)", () => {
    expect(toOpenAIReasoningEffort("off")).toBeUndefined();
  });
  it("low/medium/high → 原样映射", () => {
    expect(toOpenAIReasoningEffort("low")).toBe("low");
    expect(toOpenAIReasoningEffort("medium")).toBe("medium");
    expect(toOpenAIReasoningEffort("high")).toBe("high");
  });
});

describe("toAnthropicThinkingConfig", () => {
  it("off → undefined(不发送 thinking 块)", () => {
    expect(toAnthropicThinkingConfig("off")).toBeUndefined();
  });
  it("low → budget_tokens 1024", () => {
    expect(toAnthropicThinkingConfig("low")).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
  });
  it("medium → budget_tokens 4096", () => {
    expect(toAnthropicThinkingConfig("medium")).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
  });
  it("high → budget_tokens 32000", () => {
    expect(toAnthropicThinkingConfig("high")).toEqual({
      type: "enabled",
      budget_tokens: 32_000,
    });
  });
});

describe("anthropicBudgetTokens", () => {
  it("off → 0", () => {
    expect(anthropicBudgetTokens("off")).toBe(0);
  });
  it("high → 32000", () => {
    expect(anthropicBudgetTokens("high")).toBe(32_000);
  });
});

// ── CLI 解析兼容 ──────────────────────────────────────────────────

describe("resolveThinkingEffort", () => {
  it("undefined → off", () => {
    expect(resolveThinkingEffort(undefined)).toBe("off");
  });
  it("空字符串 → off", () => {
    expect(resolveThinkingEffort("")).toBe("off");
  });
  it('"false" → off(向后兼容老布尔语义)', () => {
    expect(resolveThinkingEffort("false")).toBe("off");
  });
  it('"true" → DEFAULT_THINKING_EFFORT(high)', () => {
    expect(resolveThinkingEffort("true")).toBe(DEFAULT_THINKING_EFFORT);
    expect(resolveThinkingEffort("true")).toBe("high");
  });
  it("枚举值原样返回(大小写不敏感)", () => {
    expect(resolveThinkingEffort("low")).toBe("low");
    expect(resolveThinkingEffort("MEDIUM")).toBe("medium");
    expect(resolveThinkingEffort("High")).toBe("high");
    expect(resolveThinkingEffort("OFF")).toBe("off");
  });
  it("无法识别的值 → 宽容降级到 high", () => {
    expect(resolveThinkingEffort("xyz")).toBe("high");
    expect(resolveThinkingEffort("max")).toBe("high");
  });
});

// ── always-thinking 钳位 ──────────────────────────────────────────

describe("clampThinkingEffort", () => {
  it("alwaysThinking=false 时 off 不被钳位", () => {
    expect(clampThinkingEffort("off", false)).toBe("off");
  });
  it("alwaysThinking=true 时 off 被钳位到 high", () => {
    expect(clampThinkingEffort("off", true)).toBe("high");
  });
  it("非 off 档位不受 alwaysThinking 影响", () => {
    expect(clampThinkingEffort("low", true)).toBe("low");
    expect(clampThinkingEffort("medium", true)).toBe("medium");
  });
});

describe("isValidThinkingEffort", () => {
  it("合法档位", () => {
    expect(isValidThinkingEffort("off")).toBe(true);
    expect(isValidThinkingEffort("low")).toBe(true);
    expect(isValidThinkingEffort("medium")).toBe(true);
    expect(isValidThinkingEffort("high")).toBe(true);
  });
  it("非法值", () => {
    expect(isValidThinkingEffort("xhigh")).toBe(false);
    expect(isValidThinkingEffort("true")).toBe(false);
    expect(isValidThinkingEffort("")).toBe(false);
  });
});

// ── profile 能力探测 ─────────────────────────────────────────────

describe("ProviderProfile thinking 能力探测", () => {
  it("GLM-5.2 标记为支持思考控制", () => {
    const profile = resolveProviderProfile("openai", "glm-5.2");
    expect(profile.supportsThinkingControl).toBe(true);
  });
  it("deepseek-v4-pro 标记为支持思考控制", () => {
    const profile = resolveProviderProfile("openai", "deepseek-v4-pro");
    expect(profile.supportsThinkingControl).toBe(true);
  });
  it("未知模型默认不支持思考控制", () => {
    const profile = resolveProviderProfile("openai", "gpt-4o");
    expect(profile.supportsThinkingControl).toBe(false);
  });
});

// ── provider body 注入(mock fetch) ────────────────────────────────

describe("OpenAIProvider body 注入 reasoning_effort", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function captureBody(
    thinkingEffort: ThinkingEffort | undefined,
  ): Promise<Record<string, unknown>> {
    const { OpenAIProvider } = await import("../src/provider/openai.js");
    const provider = new OpenAIProvider({
      baseURL: "http://localhost",
      apiKey: "test",
      model: "test-model",
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    });
    await provider.generate([{ role: "user", content: "hi" }], []);
    const callArgs = fetchSpy.mock.calls[0];
    const req = callArgs?.[1] as RequestInit;
    return JSON.parse(req.body as string) as Record<string, unknown>;
  }

  it("thinkingEffort=high 时 body 含 reasoning_effort: high", async () => {
    const body = await captureBody("high");
    expect(body["reasoning_effort"]).toBe("high");
  });

  it("thinkingEffort=medium 时 body 含 reasoning_effort: medium", async () => {
    const body = await captureBody("medium");
    expect(body["reasoning_effort"]).toBe("medium");
  });

  it("thinkingEffort=off 时 body 不含 reasoning_effort", async () => {
    const body = await captureBody("off");
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  it("未设置 thinkingEffort 时 body 不含 reasoning_effort(向后兼容)", async () => {
    const body = await captureBody(undefined);
    expect(body["reasoning_effort"]).toBeUndefined();
  });
});

describe("ClaudeProvider body 注入 thinking.budget_tokens", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function captureBody(
    thinkingEffort: ThinkingEffort | undefined,
  ): Promise<Record<string, unknown>> {
    const { ClaudeProvider } = await import("../src/provider/claude.js");
    const provider = new ClaudeProvider({
      baseURL: "http://localhost",
      apiKey: "test",
      model: "test-model",
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    });
    await provider.generate(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      [],
    );
    const callArgs = fetchSpy.mock.calls[0];
    const req = callArgs?.[1] as RequestInit;
    return JSON.parse(req.body as string) as Record<string, unknown>;
  }

  it("thinkingEffort=high 时 body 含 thinking.budget_tokens: 32000", async () => {
    const body = await captureBody("high");
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 32_000 });
    // max_tokens 必须 > budget_tokens
    expect(body["max_tokens"]).toBeGreaterThan(32_000);
  });

  it("thinkingEffort=off 时 body 不含 thinking 块", async () => {
    const body = await captureBody("off");
    expect(body["thinking"]).toBeUndefined();
  });
});
