import type {
  CapabilitySupport,
  ModelCapabilityConfig,
  ModelPrice,
  ModelRouteCapabilities,
  ModelRouteCapabilityContext,
  OpenAIOutputTokenField,
  PromptCachePolicy,
  ProviderProfile,
  ProviderProtocol,
} from "@pico/core";
import { resolveModelReasoningCapability } from "./model-reasoning.js";
import { resolveNativeWebSearchCapability } from "./model-web-search.js";
import { resolveProviderProfile } from "./provider-profile.js";

/** Resolve concrete route capabilities before any request is sent. */
export function resolveModelRouteCapabilities(
  provider: ProviderProtocol,
  model: string,
  override: ModelCapabilityConfig | undefined,
  context: ModelRouteCapabilityContext = {},
): ModelRouteCapabilities {
  const profile = resolveProviderProfile(provider, model);
  const reasoningProfile = resolveModelReasoningCapability(provider, model, {
    ...(override?.reasoning !== undefined ? { config: override.reasoning } : {}),
  });
  return {
    nativeWebSearch: resolveNativeWebSearchCapability({
      provider,
      model,
      ...(context.baseURL !== undefined ? { baseURL: context.baseURL } : {}),
      ...(override?.webSearch !== undefined ? { webSearch: override.webSearch } : {}),
    }),
    contextWindowTokens: override?.context ?? profile.contextWindowTokens,
    contextSource: override?.context === undefined ? "profile_default" : "config",
    maxOutputTokens: override?.output,
    outputSource: override?.output === undefined ? "provider_default" : "config",
    outputTokenField:
      override?.outputTokenField ?? defaultOpenAIOutputTokenField(provider, context.baseURL),
    vision: override?.vision ?? "unknown",
    reasoning: reasoningProfile.enabled,
    reasoningProfile,
    toolCall: override?.toolCall ?? "unknown",
    cache: override?.cache ?? "unknown",
    promptCache: resolvePromptCachePolicy(provider, override),
    toolChoiceNoneWithTools:
      override?.toolChoiceNoneWithTools ??
      defaultToolChoiceNoneWithTools(provider, context.baseURL),
    streamUsage: override?.streamUsage ?? "unknown",
    price: override?.price
      ? { currency: "USD", source: "config", ...override.price }
      : unknownModelPrice(),
  };
}

function resolvePromptCachePolicy(
  provider: ProviderProtocol,
  override: ModelCapabilityConfig | undefined,
): PromptCachePolicy {
  if (override?.cache === false && override.promptCache !== undefined) {
    throw new Error("promptCache cannot be configured when cache=false");
  }
  const configured = override?.promptCache;
  if (!configured) {
    return provider === "claude"
      ? { mode: "explicit", ttl: "5m", keyShards: 1, prewarm: false }
      : { mode: "implicit", keyShards: 1, prewarm: false };
  }

  const keyShards = configured.keyShards ?? 1;
  if (!Number.isSafeInteger(keyShards) || keyShards < 1 || keyShards > 64) {
    throw new Error("promptCache.keyShards must be an integer between 1 and 64");
  }
  const shardThresholdRpm = configured.shardThresholdRpm ?? (keyShards > 1 ? 15 : undefined);
  if (
    shardThresholdRpm !== undefined &&
    (!Number.isSafeInteger(shardThresholdRpm) ||
      shardThresholdRpm < 1 ||
      shardThresholdRpm > 1_000_000)
  ) {
    throw new Error("promptCache.shardThresholdRpm must be an integer between 1 and 1000000");
  }
  if (configured.shardThresholdRpm !== undefined && keyShards <= 1) {
    throw new Error("promptCache.shardThresholdRpm requires keyShards greater than 1");
  }
  const prewarm = configured.prewarm ?? false;
  if (provider === "responses") {
    if (
      configured.mode !== "implicit" ||
      configured.ttl !== undefined ||
      configured.explicitBreakpoints !== undefined ||
      prewarm
    ) {
      throw new Error(
        "Responses supports implicit prompt caching without TTL, breakpoints or prewarm",
      );
    }
    return {
      mode: "implicit",
      keyShards,
      ...(shardThresholdRpm !== undefined ? { shardThresholdRpm } : {}),
      ...(configured.retention ? { retention: configured.retention } : {}),
      prewarm: false,
    };
  }
  if (provider === "openai") {
    if (configured.ttl !== undefined && configured.ttl !== "30m") {
      throw new Error("OpenAI promptCache.ttl must be 30m");
    }
    if (
      configured.retention !== undefined &&
      configured.retention !== "in_memory" &&
      configured.retention !== "24h"
    ) {
      throw new Error("OpenAI promptCache.retention must be in_memory or 24h");
    }
    if (configured.retention !== undefined && configured.mode !== "implicit") {
      throw new Error("OpenAI promptCache.retention requires promptCache.mode=implicit");
    }
    if (configured.explicitBreakpoints === true && configured.mode !== "explicit") {
      throw new Error("OpenAI explicitBreakpoints requires promptCache.mode=explicit");
    }
    if (configured.ttl !== undefined && configured.explicitBreakpoints !== true) {
      throw new Error("OpenAI promptCache.ttl requires explicitBreakpoints=true");
    }
    if (prewarm) throw new Error("OpenAI promptCache.prewarm is not supported");
    return {
      mode: configured.mode,
      ...(configured.ttl ? { ttl: configured.ttl } : {}),
      ...(configured.explicitBreakpoints !== undefined
        ? { explicitBreakpoints: configured.explicitBreakpoints }
        : {}),
      ...(configured.retention !== undefined ? { retention: configured.retention } : {}),
      keyShards,
      ...(shardThresholdRpm !== undefined ? { shardThresholdRpm } : {}),
      prewarm: false,
    };
  }
  if (provider === "claude") {
    if (configured.mode !== "explicit") {
      throw new Error("Claude promptCache.mode must be explicit");
    }
    if (configured.ttl !== undefined && configured.ttl !== "5m" && configured.ttl !== "1h") {
      throw new Error("Claude promptCache.ttl must be 5m or 1h");
    }
    if (keyShards !== 1) throw new Error("Claude promptCache.keyShards must be 1");
    if (configured.shardThresholdRpm !== undefined) {
      throw new Error("Claude promptCache.shardThresholdRpm is not supported");
    }
    if (configured.explicitBreakpoints !== undefined) {
      throw new Error("Claude promptCache.explicitBreakpoints is not supported");
    }
    if (configured.retention !== undefined) {
      throw new Error("Claude promptCache.retention is not supported");
    }
    return { mode: "explicit", ttl: configured.ttl ?? "5m", keyShards: 1, prewarm };
  }
  throw new Error("Unsupported provider protocol");
}

/** Official Anthropic and OpenAI endpoints are safe defaults; compatible gateways must opt in. */
export function defaultToolChoiceNoneWithTools(
  provider: ProviderProtocol,
  baseURL: string | undefined,
): CapabilitySupport {
  if (!baseURL) return "unknown";
  try {
    const endpoint = new URL(baseURL);
    if (endpoint.protocol !== "https:") return "unknown";
    const hostname = endpoint.hostname.toLowerCase();
    if (provider === "claude") return hostname === "api.anthropic.com" ? true : "unknown";
    return hostname === "api.openai.com" ? true : "unknown";
  } catch {
    return "unknown";
  }
}

function defaultOpenAIOutputTokenField(
  provider: ProviderProtocol,
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
    ...(capabilities.maxOutputTokens !== undefined
      ? { maxOutputTokens: capabilities.maxOutputTokens }
      : {}),
    supportsPromptCache:
      capabilities.cache === "unknown" ? profile.supportsPromptCache : capabilities.cache,
    supportsThinkingControl:
      capabilities.reasoning === "unknown"
        ? profile.supportsThinkingControl
        : capabilities.reasoning,
  };
}
