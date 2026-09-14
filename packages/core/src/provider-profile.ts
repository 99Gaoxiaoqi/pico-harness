/** Provider wire protocol understood by the stable model-facing contracts. */
export type ProviderProtocol = "openai" | "claude" | "responses";

/** How an adapter must encode an assistant message without visible content. */
export type AssistantContentMode = "empty_string" | "null_when_empty";

/**
 * Resolved, vendor-neutral model envelope consumed by context and request policy.
 *
 * Concrete defaults and model-family lookup stay in the outer Provider adapter.
 */
export interface ProviderProfile {
  protocol: ProviderProtocol;
  model: string;
  assistantContent: AssistantContentMode;
  contextWindowTokens: number;
  maxOutputTokens: number;
  supportsReasoningContent: boolean;
  supportsPromptCache: boolean;
  /** 是否支持通过 reasoning_effort / thinking.budget_tokens 控制思考强度。 */
  supportsThinkingControl: boolean;
  /** 某些推理模型无法关闭思考(always-thinking)，设 off 时会被钳位到开启。 */
  alwaysThinking?: boolean;
}
