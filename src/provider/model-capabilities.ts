import type { ProviderKind } from "./factory.js";
import { resolveProviderProfile, type ProviderProfile, type ProviderProtocol } from "./profile.js";

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

/**
 * Provider route metadata used before a request is sent. Values are concrete so
 * callers never need to infer support from a model name at execution time.
 */
export interface ModelRouteCapabilities {
  contextWindowTokens: number;
  contextSource: CapabilityValueSource;
  maxOutputTokens: number;
  outputSource: CapabilityValueSource;
  vision: CapabilitySupport;
  reasoning: CapabilitySupport;
  toolCall: CapabilitySupport;
  cache: CapabilitySupport;
  price: ModelPrice;
  fallbackModel?: string;
}

/** User-configurable route capability overrides. Omitted fields keep legacy profile defaults. */
export interface ModelCapabilityConfig {
  context?: number;
  output?: number;
  vision?: boolean;
  reasoning?: boolean;
  toolCall?: boolean;
  cache?: boolean;
  price?: Omit<ModelPrice, "currency" | "source">;
  /** false explicitly disables a legacy profile fallback. */
  fallback?: string | false;
}

export function resolveModelRouteCapabilities(
  provider: ProviderKind,
  model: string,
  override: ModelCapabilityConfig | undefined,
): ModelRouteCapabilities {
  const profile = resolveProviderProfile(provider, model);
  const fallbackModel = override?.fallback === false ? undefined : override?.fallback;
  return {
    contextWindowTokens: override?.context ?? profile.contextWindowTokens,
    contextSource: override?.context === undefined ? "profile_default" : "config",
    maxOutputTokens: override?.output ?? profile.maxOutputTokens,
    outputSource: override?.output === undefined ? "profile_default" : "config",
    // Adapter support does not prove a custom endpoint/model supports the feature.
    vision: override?.vision ?? "unknown",
    reasoning: override?.reasoning ?? "unknown",
    toolCall: override?.toolCall ?? "unknown",
    cache: override?.cache ?? "unknown",
    price: override?.price
      ? { currency: "USD", source: "config", ...override.price }
      : unknownModelPrice(),
    ...(fallbackModel ? { fallbackModel } : {}),
  };
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
    ...(capabilities.fallbackModel ? { fallbackModel: capabilities.fallbackModel } : {}),
  };
}
