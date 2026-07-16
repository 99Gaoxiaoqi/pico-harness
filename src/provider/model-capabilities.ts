import type { ProviderKind } from "./factory.js";
import { resolveProviderProfile, type ProviderProfile, type ProviderProtocol } from "./profile.js";
import {
  resolveModelReasoningCapability,
  type ModelReasoningCapabilityInput,
  type ResolvedModelReasoningCapability,
} from "./reasoning-capability.js";

export interface ModelPrice {
  currency: "USD";
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  source: "config" | "unknown";
}

export type CapabilitySupport = boolean | "unknown";
export type CapabilityValueSource = "config" | "profile_default";
export type OpenAIOutputTokenField = "max_tokens" | "max_completion_tokens";

/**
 * Provider route metadata used before a request is sent. Values are concrete so
 * callers never need to infer support from a model name at execution time.
 */
export interface ModelRouteCapabilities {
  contextWindowTokens: number;
  contextSource: CapabilityValueSource;
  maxOutputTokens: number;
  outputSource: CapabilityValueSource;
  /** OpenAI-compatible request field used to enforce maxOutputTokens on the wire. */
  outputTokenField: OpenAIOutputTokenField;
  vision: CapabilitySupport;
  reasoning: CapabilitySupport;
  /** Model-specific reasoning levels and protocol request patches. */
  reasoningProfile: ResolvedModelReasoningCapability;
  toolCall: CapabilitySupport;
  cache: CapabilitySupport;
  /** Whether this route accepts OpenAI stream_options.include_usage. */
  streamUsage: CapabilitySupport;
  price: ModelPrice;
}

/** User-configurable route capability overrides. Omitted fields keep legacy profile defaults. */
export interface ModelCapabilityConfig {
  context?: number;
  output?: number;
  /** Official OpenAI defaults to max_completion_tokens; compatible endpoints keep max_tokens. */
  outputTokenField?: OpenAIOutputTokenField;
  vision?: boolean;
  reasoning?: ModelReasoningCapabilityInput;
  toolCall?: boolean;
  cache?: boolean;
  streamUsage?: boolean;
  price?: Omit<ModelPrice, "currency" | "source">;
}

export interface ModelRouteCapabilityContext {
  /** Endpoint authority is required to choose an official OpenAI wire default safely. */
  baseURL?: string;
}

export function resolveModelRouteCapabilities(
  provider: ProviderKind,
  model: string,
  override: ModelCapabilityConfig | undefined,
  context: ModelRouteCapabilityContext = {},
): ModelRouteCapabilities {
  const profile = resolveProviderProfile(provider, model);
  const reasoningProfile = resolveModelReasoningCapability(provider, model, {
    config: override?.reasoning,
  });
  return {
    contextWindowTokens: override?.context ?? profile.contextWindowTokens,
    contextSource: override?.context === undefined ? "profile_default" : "config",
    maxOutputTokens: override?.output ?? profile.maxOutputTokens,
    outputSource: override?.output === undefined ? "profile_default" : "config",
    outputTokenField:
      override?.outputTokenField ?? defaultOpenAIOutputTokenField(provider, context.baseURL),
    // Adapter support does not prove a custom endpoint/model supports the feature.
    vision: override?.vision ?? "unknown",
    reasoning: reasoningProfile.enabled,
    reasoningProfile,
    toolCall: override?.toolCall ?? "unknown",
    cache: override?.cache ?? "unknown",
    streamUsage: override?.streamUsage ?? "unknown",
    price: override?.price
      ? { currency: "USD", source: "config", ...override.price }
      : unknownModelPrice(),
  };
}

function defaultOpenAIOutputTokenField(
  provider: ProviderKind,
  baseURL: string | undefined,
): OpenAIOutputTokenField {
  if (provider !== "openai" || !baseURL) return "max_tokens";
  try {
    const endpoint = new URL(baseURL);
    if (endpoint.protocol === "https:" && endpoint.hostname.toLowerCase() === "api.openai.com") {
      return "max_completion_tokens";
    }
  } catch {
    // Endpoint validation belongs to configuration loading; retain the compatible fallback here.
  }
  return "max_tokens";
}

export function unknownModelPrice(): ModelPrice {
  return {
    currency: "USD",
    inputPerMillion: null,
    outputPerMillion: null,
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
    source: "unknown",
  };
}

/** Apply route metadata to protocol translation without losing compatibility quirks. */
export function providerProfileForRoute(
  protocol: ProviderProtocol,
  model: string,
  capabilities: ModelRouteCapabilities,
): ProviderProfile {
  const profile = resolveProviderProfile(protocol, model);
  return {
    ...profile,
    contextWindowTokens: capabilities.contextWindowTokens,
    maxOutputTokens: capabilities.maxOutputTokens,
    supportsPromptCache:
      capabilities.cache === "unknown" ? profile.supportsPromptCache : capabilities.cache,
    supportsThinkingControl:
      capabilities.reasoning === "unknown"
        ? profile.supportsThinkingControl
        : capabilities.reasoning,
  };
}
