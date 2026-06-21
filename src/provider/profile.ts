export type ProviderProtocol = "openai" | "claude";
export type AssistantContentMode = "empty_string" | "null_when_empty";

export interface ProviderProfile {
  protocol: ProviderProtocol;
  model: string;
  fallbackModel?: string;
  assistantContent: AssistantContentMode;
  maxOutputTokens: number;
  supportsReasoningContent: boolean;
  supportsPromptCache: boolean;
}

const DEFAULTS: Record<ProviderProtocol, Omit<ProviderProfile, "model">> = {
  openai: {
    protocol: "openai",
    assistantContent: "empty_string",
    maxOutputTokens: 4096,
    supportsReasoningContent: true,
    supportsPromptCache: false,
  },
  claude: {
    protocol: "claude",
    assistantContent: "empty_string",
    maxOutputTokens: 4096,
    supportsReasoningContent: false,
    supportsPromptCache: true,
  },
};

const MODEL_PROFILES: Record<string, Partial<ProviderProfile>> = {
  "glm-5.2": {
    fallbackModel: "kimi-k2.5",
    assistantContent: "null_when_empty",
    supportsReasoningContent: true,
  },
  "kimi-k2.5": {
    supportsReasoningContent: true,
  },
  "claude-3-5-sonnet": {
    supportsPromptCache: true,
    maxOutputTokens: 4096,
  },
};

export function resolveProviderProfile(
  protocol: ProviderProtocol,
  model: string,
): ProviderProfile {
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
