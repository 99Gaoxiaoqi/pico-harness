// 统一思考强度 (ThinkingEffort) 抽象层。
//
// ThinkingEffort 控制的是模型原生 reasoning 能力 —— 通过请求参数告诉模型
// "思考多深"(OpenAI 的 reasoning_effort / Anthropic 的 thinking.budget_tokens)。
//
// 设计参考:Kimi Code kosong 包的 ThinkingEffort 统一抽象。
// 档位定为 4 档(off/low/medium/high),覆盖主流厂商支持范围。

/** 统一思考强度档位 */
export type ThinkingEffort = "off" | "low" | "medium" | "high";

/** 默认思考强度(对齐 Kimi Code DEFAULT_THINKING_EFFORT) */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "high";

const VALID_EFFORTS = new Set<ThinkingEffort>(["off", "low", "medium", "high"]);

// ── 厂商翻译:统一档位 → 各厂商请求参数 ──────────────────────────────

/**
 * 翻译为 OpenAI 的 reasoning_effort 字符串。
 * off → undefined(不发送该参数);其余原样映射。
 */
export function toOpenAIReasoningEffort(
  effort: ThinkingEffort,
): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "off":
      return undefined;
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
  }
}

/** Anthropic thinking 配置块 */
export interface AnthropicThinkingConfig {
  type: "enabled";
  budget_tokens: number;
}

/**
 * 翻译为 Anthropic 的 thinking 配置块(budget_tokens 模式)。
 * off → undefined;其余按档位映射 token 预算(对齐 Kimi anthropic.ts:337)。
 */
export function toAnthropicThinkingConfig(
  effort: ThinkingEffort,
): AnthropicThinkingConfig | undefined {
  switch (effort) {
    case "off":
      return undefined;
    case "low":
      return { type: "enabled", budget_tokens: 1024 };
    case "medium":
      return { type: "enabled", budget_tokens: 4096 };
    case "high":
      return { type: "enabled", budget_tokens: 32_000 };
  }
}

/**
 * 获取某档位对应的 Anthropic budget_tokens(供 max_tokens 保护计算用)。
 * off 返回 0。
 */
export function anthropicBudgetTokens(effort: ThinkingEffort): number {
  return toAnthropicThinkingConfig(effort)?.budget_tokens ?? 0;
}

// ── 解析:CLI 字符串 / 旧布尔值 → ThinkingEffort ─────────────────────

/**
 * 把 CLI 的 --thinking 原始值解析为统一档位。
 * 兼容老的布尔语义("true"/"false")和新枚举语义(off/low/medium/high)。
 *
 * - undefined / "false" → "off"
 * - "true" → DEFAULT_THINKING_EFFORT(high)
 * - "off"/"low"/"medium"/"high" → 原样
 * - 其他无法识别的值 → DEFAULT_THINKING_EFFORT(宽容降级,不报错)
 */
export function resolveThinkingEffort(raw: string | undefined): ThinkingEffort {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return "off";
  if (normalized === "false") return "off";
  if (normalized === "true") return DEFAULT_THINKING_EFFORT;
  if (VALID_EFFORTS.has(normalized as ThinkingEffort)) {
    return normalized as ThinkingEffort;
  }
  return DEFAULT_THINKING_EFFORT;
}

/** 判断字符串是否为合法的 ThinkingEffort 档位(含 off) */
export function isValidThinkingEffort(value: string): boolean {
  return VALID_EFFORTS.has(value as ThinkingEffort);
}

/**
 * 钳位:对 always-thinking 的模型(无法关闭推理),把 off 强制升到默认档。
 * 仿 Kimi Code config/index.ts:127 的 getter 钳位思路。
 *
 * @param effort 用户/CLI 请求的档位
 * @param alwaysThinking 模型是否无法关闭思考
 * @returns 钳位后的有效档位
 */
export function clampThinkingEffort(
  effort: ThinkingEffort,
  alwaysThinking: boolean,
): ThinkingEffort {
  if (effort === "off" && alwaysThinking) {
    return DEFAULT_THINKING_EFFORT;
  }
  return effort;
}
