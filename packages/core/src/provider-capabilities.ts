import type { ResolvedModelReasoningCapability } from "./provider-reasoning.js";

export interface NativeWebSearchCapability {
  available: boolean;
  reason: string;
  adapter?: "openai-web-search" | "anthropic-web-search";
}

export interface ModelPrice {
  currency: "USD";
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  source: "config" | "unknown";
}

export type CapabilitySupport = boolean | "unknown";
export type CapabilityValueSource = "config" | "profile_default" | "provider_default";
export type OpenAIOutputTokenField = "max_tokens" | "max_completion_tokens";
export type PromptCacheMode = "implicit" | "explicit";
export type PromptCacheTtl = "5m" | "1h" | "30m" | "24h" | `${number}s`;
export type OpenAIPromptCacheRetention = "in_memory" | "24h";

export interface PromptCachePolicyConfig {
  mode: PromptCacheMode;
  ttl?: PromptCacheTtl;
  /** OpenAI GPT-5.6 content-block breakpoints; enable only after route capability probing. */
  explicitBreakpoints?: boolean;
  /** Legacy OpenAI maximum-retention policy; mutually exclusive with GPT-5.6 options. */
  retention?: OpenAIPromptCacheRetention;
  keyShards?: number;
  /** Activate configured key sharding after this route exceeds the calls-per-minute threshold. */
  shardThresholdRpm?: number;
  prewarm?: boolean;
}

export interface PromptCachePolicy {
  mode: PromptCacheMode;
  ttl?: PromptCacheTtl;
  explicitBreakpoints?: boolean;
  retention?: OpenAIPromptCacheRetention;
  keyShards: number;
  shardThresholdRpm?: number;
  prewarm: boolean;
}

/** Provider route metadata used before a request is sent. */
export interface ModelRouteCapabilities {
  nativeWebSearch?: NativeWebSearchCapability;
  contextWindowTokens: number;
  contextSource: CapabilityValueSource;
  maxOutputTokens: number | undefined;
  outputSource: CapabilityValueSource;
  /** OpenAI-compatible request field used to enforce maxOutputTokens on the wire. */
  outputTokenField: OpenAIOutputTokenField;
  vision: CapabilitySupport;
  reasoning: CapabilitySupport;
  /** Model-specific reasoning levels and protocol request patches. */
  reasoningProfile: ResolvedModelReasoningCapability;
  toolCall: CapabilitySupport;
  cache: CapabilitySupport;
  /** Route behavior for provider-side prompt caching; separate from support detection. */
  promptCache: PromptCachePolicy;
  /** Whether tools may stay on the wire while tool_choice:none forbids their use. */
  toolChoiceNoneWithTools: CapabilitySupport;
  /** Whether this route accepts OpenAI stream_options.include_usage. */
  streamUsage: CapabilitySupport;
  price: ModelPrice;
}

/** User-configurable route capability overrides. Omitted fields keep profile defaults. */
export interface ModelCapabilityConfig {
  webSearch?: boolean;
  context?: number;
  output?: number;
  /** Official OpenAI defaults to max_completion_tokens; compatible endpoints keep max_tokens. */
  outputTokenField?: OpenAIOutputTokenField;
  vision?: boolean;
  reasoning?: import("./provider-reasoning.js").ModelReasoningCapabilityInput;
  toolCall?: boolean;
  cache?: boolean;
  promptCache?: PromptCachePolicyConfig;
  toolChoiceNoneWithTools?: boolean;
  streamUsage?: boolean;
  price?: Omit<ModelPrice, "currency" | "source">;
}

export interface ModelRouteCapabilityContext {
  /** Endpoint authority is required to choose an official OpenAI wire default safely. */
  baseURL?: string;
}
