import type { ProviderProfile, ProviderProtocol } from "@pico/core";

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
  responses: {
    protocol: "responses",
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

/** Resolve built-in model defaults; route-specific overrides are layered outside this function. */
export function resolveProviderProfile(protocol: ProviderProtocol, model: string): ProviderProfile {
  const defaults = DEFAULTS[protocol];
  const exact = MODEL_PROFILES[normalizeModel(model)] ?? {};
  return { ...defaults, ...exact, protocol, model };
}

export function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}
