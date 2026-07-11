// Provider 工厂:按协议类型创建对应适配器。

import { loadProviderConfig, loadApiKeys, type ProviderConfig } from "./config.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";
import type { LLMProvider } from "./interface.js";
import { coordinateReasoningLevel, type ReasoningLevel } from "./reasoning-capability.js";
import { CredentialPool } from "./credential-pool.js";
import { CapabilityPreflightProvider } from "./capability-preflight.js";
import { providerProfileForRoute } from "./model-capabilities.js";

export type ProviderKind = "openai" | "claude" | "gemini";

/**
 * 进程级单例:多 key 轮换池。
 * 仅当配置了多 key(LLM_API_KEYS 含 2+ 个)时初始化;单 key 时为 undefined,
 * 整个轮换机制对现有流程透明(向后兼容)。
 */
let credentialPool: CredentialPool | undefined;

/** 初始化(或重建)进程级凭证池;keys <= 1 时不创建,保留单 key 行为。 */
export function initCredentialPool(keys: string[] = loadApiKeys()): CredentialPool | undefined {
  credentialPool = keys.length > 1 ? new CredentialPool(keys) : undefined;
  return credentialPool;
}

/** 取进程级凭证池(可能为 undefined:单 key / 未配置多 key)。retry 层据此决定是否轮换。 */
export function getCredentialPool(): CredentialPool | undefined {
  // 懒初始化:首次访问时若环境变量含多 key 则自动建池
  if (credentialPool === undefined) {
    return initCredentialPool();
  }
  return credentialPool;
}

/** 仅供测试重置单例。 */
export function resetCredentialPool(): void {
  credentialPool = undefined;
}

/**
 * 把可选 thinkingEffort 合并进 config。
 *
 * 凭证轮换(4.2)策略:
 * - 调用方未传 config(从环境变量加载)→ 若存在多 key 池,自动取下一个可用 key;
 * - 调用方显式传了 config(apiKey 已定)→ 信任调用方,不再轮换。
 *   这使 factory 行为确定:传入的 apiKey 即所用 key,便于上层(run-agent)统一管控轮换。
 * - 单 key / 无池 → apiKey 保持原值(向后兼容)。
 */
function resolveConfig(
  config: ProviderConfig | undefined,
  thinkingEffort: ReasoningLevel | undefined,
): ProviderConfig {
  let cfg: ProviderConfig;
  if (config === undefined) {
    cfg = loadProviderConfig();
    const pool = getCredentialPool();
    if (pool && pool.size > 1) {
      cfg = { ...cfg, apiKey: pool.getNext() };
    }
  } else {
    cfg = config;
  }
  if (thinkingEffort !== undefined) return { ...cfg, thinkingEffort };
  if (cfg.thinkingEffort !== undefined || !cfg.capabilities) return cfg;
  const selected = coordinateReasoningLevel(cfg.capabilities.reasoningProfile);
  return selected.level === undefined ? cfg : { ...cfg, thinkingEffort: selected.level };
}

/** 按协议类型创建 raw Provider;不传 config 时从环境变量读取;thinkingEffort 可单独覆盖 */
export function createProvider(
  kind: ProviderKind,
  config?: ProviderConfig,
  thinkingEffort?: ReasoningLevel,
): LLMProvider {
  return createRawProvider(kind, config, thinkingEffort);
}

/** 创建原始 Provider;运行时 fallback/计费由装配层负责。 */
export function createRawProvider(
  kind: ProviderKind,
  config?: ProviderConfig,
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
  return cfg.capabilities
    ? new CapabilityPreflightProvider(
        provider,
        cfg.routeId ?? `${kind}/${cfg.model}`,
        cfg.capabilities,
        cfg.thinkingEffort ?? "off",
      )
    : provider;
}
