// Provider 工厂:按协议类型创建对应适配器。

import { loadProviderConfig, type ProviderConfig } from "./config.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";

export type ProviderKind = "openai" | "claude";

export const GLM_52_MODEL = "glm-5.2";
export const GLM_52_FALLBACK_MODEL = "kimi-k2.5";

/** 按协议类型创建 Provider;不传 config 时从环境变量读取 */
export function createProvider(kind: ProviderKind, config?: ProviderConfig): LLMProvider {
  const cfg = config ?? loadProviderConfig();
  switch (kind) {
    case "openai":
      return createOpenAIProviderWithFallback(cfg);
    case "claude":
      return new ClaudeProvider(cfg);
  }
}

/** 创建不带模型 fallback 的原始 Provider,供外层需要自行处理 fallback/计费时使用 */
export function createRawProvider(kind: ProviderKind, config?: ProviderConfig): LLMProvider {
  const cfg = config ?? loadProviderConfig();
  switch (kind) {
    case "openai":
      return new OpenAIProvider(cfg);
    case "claude":
      return new ClaudeProvider(cfg);
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

      console.warn(`[Provider] ${this.activeModel} 不可用,自动切换到 ${this.fallbackModel}`);
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
  const normalized = model.replaceAll("-", "").toLowerCase();
  if (normalized === "glm5.2") {
    return GLM_52_FALLBACK_MODEL;
  }
  return undefined;
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
