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
export type PromptCacheMode = "implicit" | "explicit";
export type PromptCacheTtl = "5m" | "1h" | "30m" | "24h" | `${number}s`;

export interface PromptCachePolicyConfig {
  mode: PromptCacheMode;
  ttl?: PromptCacheTtl;
  /** OpenAI GPT-5.6 content-block breakpoints; enable only after route capability probing. */
  explicitBreakpoints?: boolean;
  keyShards?: number;
  /** Activate configured key sharding after this route exceeds the calls-per-minute threshold. */
  shardThresholdRpm?: number;
  prewarm?: boolean;
}

export interface PromptCachePolicy {
  mode: PromptCacheMode;
  ttl?: PromptCacheTtl;
  explicitBreakpoints?: boolean;
  keyShards: number;
  shardThresholdRpm?: number;
  prewarm: boolean;
}

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
  /** Route behavior for provider-side prompt caching; separate from support detection. */
  promptCache: PromptCachePolicy;
  /** Whether tools may stay on the wire while tool_choice:none forbids their use. */
  toolChoiceNoneWithTools: CapabilitySupport;
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
  promptCache?: PromptCachePolicyConfig;
  toolChoiceNoneWithTools?: boolean;
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
  provider: ProviderKind,
  override: ModelCapabilityConfig | undefined,
): PromptCachePolicy {
  if (override?.cache === false && override.promptCache !== undefined) {
    throw new Error("promptCache cannot be configured when cache=false");
  }
  const configured = override?.promptCache;
  if (!configured) {
    if (provider === "claude") {
      return { mode: "explicit", ttl: "5m", keyShards: 1, prewarm: false };
    }
    return { mode: "implicit", keyShards: 1, prewarm: false };
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
  if (provider === "openai") {
    if (
      configured.mode !== "explicit" &&
      (keyShards > 1 || configured.shardThresholdRpm !== undefined)
    ) {
      throw new Error("OpenAI prompt-cache key sharding requires promptCache.mode=explicit");
    }
    if (configured.ttl !== undefined && configured.ttl !== "30m") {
      throw new Error("OpenAI promptCache.ttl must be 30m");
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
    return {
      mode: "explicit",
      ttl: configured.ttl ?? "5m",
      keyShards: 1,
      prewarm,
    };
  }

  if (
    configured.ttl !== undefined &&
    (!/^[1-9]\d*s$/u.test(configured.ttl) ||
      !Number.isSafeInteger(Number(configured.ttl.slice(0, -1))))
  ) {
    throw new Error("Gemini promptCache.ttl must be a positive integer number of seconds");
  }
  if (keyShards !== 1) throw new Error("Gemini promptCache.keyShards must be 1");
  if (configured.shardThresholdRpm !== undefined) {
    throw new Error("Gemini promptCache.shardThresholdRpm is not supported");
  }
  if (configured.explicitBreakpoints !== undefined) {
    throw new Error("Gemini promptCache.explicitBreakpoints is not supported");
  }
  if (prewarm) throw new Error("Gemini promptCache.prewarm is not supported");
  return {
    mode: configured.mode,
    ...(configured.mode === "explicit"
      ? { ttl: configured.ttl ?? ("3600s" as const) }
      : configured.ttl
        ? { ttl: configured.ttl }
        : {}),
    keyShards: 1,
    prewarm: false,
  };
}

/**
 * Official Anthropic and OpenAI endpoints are safe defaults. Compatible gateways must opt in per
 * model because partial protocol implementations are common.
 */
export function defaultToolChoiceNoneWithTools(
  provider: ProviderKind,
  baseURL: string | undefined,
): CapabilitySupport {
  if (provider !== "claude" && provider !== "openai") return false;
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
