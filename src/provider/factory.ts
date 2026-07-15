// Provider 工厂:按协议类型创建对应适配器。

import type { ProviderConfig } from "./config.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";
import type { LLMProvider } from "./interface.js";
import { coordinateReasoningLevel, type ReasoningLevel } from "./reasoning-capability.js";
import { CapabilityPreflightProvider } from "./capability-preflight.js";
import { providerProfileForRoute } from "./model-capabilities.js";
import { withProviderErrorRedaction } from "./error-redaction.js";

export type ProviderKind = "openai" | "claude" | "gemini";

/**
 * 把可选 thinkingEffort 合并进显式 config。凭证选择与轮换由 Runtime 宿主持有。
 */
function resolveConfig(
  config: ProviderConfig,
  thinkingEffort: ReasoningLevel | undefined,
): ProviderConfig {
  const cfg = config;
  if (thinkingEffort !== undefined) return { ...cfg, thinkingEffort };
  if (cfg.thinkingEffort !== undefined || !cfg.capabilities) return cfg;
  const selected = coordinateReasoningLevel(cfg.capabilities.reasoningProfile);
  return selected.level === undefined ? cfg : { ...cfg, thinkingEffort: selected.level };
}

/** 按协议类型创建 raw Provider；网络配置必须由调用方显式提供。 */
export function createProvider(
  kind: ProviderKind,
  config: ProviderConfig,
  thinkingEffort?: ReasoningLevel,
): LLMProvider {
  return createRawProvider(kind, config, thinkingEffort);
}

/** 创建原始 Provider;运行时 fallback/计费由装配层负责。 */
export function createRawProvider(
  kind: ProviderKind,
  config: ProviderConfig,
  thinkingEffort?: ReasoningLevel,
): LLMProvider {
  const cfg = resolveConfig(config, thinkingEffort);
  const profile = cfg.capabilities
    ? providerProfileForRoute(kind, cfg.model, cfg.capabilities)
    : undefined;
  let provider: LLMProvider;
  switch (kind) {
    case "openai":
      provider = new OpenAIProvider(cfg, profile);
      break;
    case "claude":
      provider = new ClaudeProvider(cfg, profile);
      break;
    case "gemini":
      provider = new GeminiProvider(cfg, profile);
      break;
  }
  provider = withProviderErrorRedaction(provider, [cfg.apiKey]);
  return cfg.capabilities
    ? new CapabilityPreflightProvider(
        provider,
        cfg.routeId ?? `${kind}/${cfg.model}`,
        cfg.capabilities,
        cfg.thinkingEffort ?? "off",
      )
    : provider;
}
