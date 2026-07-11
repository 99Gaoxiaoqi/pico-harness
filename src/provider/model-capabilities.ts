import type { ProviderKind } from "./factory.js";
import { resolveProviderProfile } from "./profile.js";

export interface ModelPrice {
  currency: "USD";
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  source: "config" | "unknown";
}

/**
 * Provider route metadata used before a request is sent. Values are concrete so
 * callers never need to infer support from a model name at execution time.
 */
export interface ModelRouteCapabilities {
  contextWindowTokens: number;
  maxOutputTokens: number;
  vision: boolean;
  reasoning: boolean;
  toolCall: boolean;
  cache: boolean;
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
  const fallbackModel =
    override?.fallback === false ? undefined : (override?.fallback ?? profile.fallbackModel);
  return {
    contextWindowTokens: override?.context ?? profile.contextWindowTokens,
    maxOutputTokens: override?.output ?? profile.maxOutputTokens,
    // All three built-in adapters implement image and tool request translation.
    vision: override?.vision ?? true,
    reasoning: override?.reasoning ?? profile.supportsThinkingControl,
    toolCall: override?.toolCall ?? true,
    cache: override?.cache ?? profile.supportsPromptCache,
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
