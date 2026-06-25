export type ProviderProtocol = "openai" | "claude";
export type AssistantContentMode = "empty_string" | "null_when_empty";

export interface ProviderProfile {
  protocol: ProviderProtocol;
  model: string;
  fallbackModel?: string;
  assistantContent: AssistantContentMode;
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsReasoningContent: boolean;
  supportsPromptCache: boolean;
  /** 是否支持通过 reasoning_effort / thinking.budget_tokens 控制思考强度 */
  supportsThinkingControl: boolean;
  /** 某些推理模型无法关闭思考(always-thinking),设 off 时会被钳位到开启 */
  alwaysThinking?: boolean;
}

const DEFAULTS: Record<ProviderProtocol, Omit<ProviderProfile, "model">> = {
  openai: {
    protocol: "openai",
    assistantContent: "empty_string",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
    supportsReasoningContent: true,
    supportsPromptCache: false,
    supportsThinkingControl: false,
  },
  claude: {
    protocol: "claude",
    assistantContent: "empty_string",
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
    supportsReasoningContent: false,
    supportsPromptCache: true,
    supportsThinkingControl: false,
  },
};

const MODEL_PROFILES: Record<string, Partial<ProviderProfile>> = {
  "glm-5.2": {
    fallbackModel: "kimi-k2.5",
    assistantContent: "null_when_empty",
    supportsReasoningContent: true,
    supportsThinkingControl: true,
  },
  "kimi-k2.5": {
    supportsReasoningContent: true,
    supportsThinkingControl: true,
  },
  "deepseek-v4-pro": {
    supportsReasoningContent: true,
    supportsThinkingControl: true,
  },
  "claude-3-5-sonnet": {
    supportsPromptCache: true,
    maxOutputTokens: 4096,
  },
};

export function resolveProviderProfile(protocol: ProviderProtocol, model: string): ProviderProfile {
  const defaults = DEFAULTS[protocol];
  const normalized = normalizeModel(model);
  const exact = MODEL_PROFILES[normalized] ?? {};
  return {
    ...defaults,
    ...exact,
    protocol,
    model,
  };
}

export function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}
