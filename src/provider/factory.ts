// Provider 工厂:按协议类型创建对应适配器。

import { loadProviderConfig, loadApiKeys, type ProviderConfig } from "./config.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";
import type { LLMProvider } from "./interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import { logger } from "../observability/logger.js";
import { resolveProviderProfile } from "./profile.js";
import type { ThinkingEffort } from "./thinking.js";
import { CredentialPool } from "./credential-pool.js";

export type ProviderKind = "openai" | "claude" | "gemini";

export const GLM_52_MODEL = "glm-5.2";
export const GLM_52_FALLBACK_MODEL = "kimi-k2.5";

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
  thinkingEffort: ThinkingEffort | undefined,
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
  if (thinkingEffort === undefined) return cfg;
  return { ...cfg, thinkingEffort };
}

/** 按协议类型创建 Provider;不传 config 时从环境变量读取;thinkingEffort 可单独覆盖 */
export function createProvider(
  kind: ProviderKind,
  config?: ProviderConfig,
  thinkingEffort?: ThinkingEffort,
): LLMProvider {
  const cfg = resolveConfig(config, thinkingEffort);
  switch (kind) {
    case "openai":
      return createOpenAIProviderWithFallback(cfg);
    case "claude":
      return new ClaudeProvider(cfg);
    case "gemini":
      return new GeminiProvider(cfg);
  }
}

/** 创建不带模型 fallback 的原始 Provider,供外层需要自行处理 fallback/计费时使用 */
export function createRawProvider(
  kind: ProviderKind,
  config?: ProviderConfig,
  thinkingEffort?: ThinkingEffort,
): LLMProvider {
  const cfg = resolveConfig(config, thinkingEffort);
  switch (kind) {
    case "openai":
      return new OpenAIProvider(cfg);
    case "claude":
      return new ClaudeProvider(cfg);
    case "gemini":
      return new GeminiProvider(cfg);
  }
}

function createOpenAIProviderWithFallback(config: ProviderConfig): LLMProvider {
  const fallbackModel = fallbackModelFor(config.model);
  if (!fallbackModel) {
    return new OpenAIProvider(config);
  }

  return new ModelFallbackProvider(
    config,
    fallbackModel,
    (providerConfig) => new OpenAIProvider(providerConfig),
  );
}

class ModelFallbackProvider implements LLMProvider {
  private activeProvider: LLMProvider;
  private activeModel: string;
  private switched = false;

  constructor(
    private readonly primaryConfig: ProviderConfig,
    private readonly fallbackModel: string,
    private readonly create: (config: ProviderConfig) => LLMProvider,
  ) {
    this.activeModel = primaryConfig.model;
    this.activeProvider = create(primaryConfig);
  }

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    try {
      return await this.activeProvider.generate(messages, availableTools);
    } catch (err) {
      if (this.switched || !isModelUnavailableError(err, this.activeModel)) {
        throw err;
      }

      logger.warn(`[Provider] ${this.activeModel} 不可用,自动切换到 ${this.fallbackModel}`);
      this.activeModel = this.fallbackModel;
      this.activeProvider = this.create({
        ...this.primaryConfig,
        model: this.fallbackModel,
      });
      this.switched = true;
      return this.activeProvider.generate(messages, availableTools);
    }
  }
}

export function fallbackModelFor(model: string): string | undefined {
  return resolveProviderProfile("openai", model).fallbackModel;
}

export function isModelUnavailableError(error: unknown, model: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const normalizedModel = model.toLowerCase();

  if (!lower.includes("model") && !lower.includes("模型") && !lower.includes(normalizedModel)) {
    return false;
  }

  return [
    "unavailable",
    "not found",
    "does not exist",
    "not exist",
    "unsupported",
    "quota",
    "rate limit",
    "ratelimit",
    "throttling",
    "429",
    "不可用",
    "不存在",
    "未找到",
    "不支持",
  ].some((keyword) => lower.includes(keyword));
}
