export type ProviderProtocol = "openai" | "claude" | "gemini";
export type AssistantContentMode = "empty_string" | "null_when_empty";

export interface ProviderProfile {
  protocol: ProviderProtocol;
  model: string;
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
  gemini: {
    protocol: "gemini",
    assistantContent: "empty_string",
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 8192,
    supportsReasoningContent: false,
    supportsPromptCache: false,
    supportsThinkingControl: false,
  },
};

const MODEL_PROFILES: Record<string, Partial<ProviderProfile>> = {
  "glm-5.2": {
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
  "gemini-1.5-pro": {
    contextWindowTokens: 2_097_152,
    maxOutputTokens: 8192,
  },
  "gemini-1.5-flash": {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 8192,
  },
  "gemini-2.0-flash": {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 8192,
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
