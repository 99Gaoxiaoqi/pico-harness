// 辅助模型配置层 (5.3a)。
// 从独立的 AUX_LLM_* 环境变量加载辅助模型配置,与主模型(ProviderConfig)解耦。
// 任一关键变量缺失 → 不启用辅助模型(undefined),调用方据此降级。

import { createProvider, type ProviderKind } from "./factory.js";
import type { LLMProvider } from "./interface.js";

export interface AuxProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** provider 协议,默认 openai */
  kind?: ProviderKind;
}

/**
 * 从环境变量加载辅助模型配置。任一缺失返回 undefined(不启用)。
 * - AUX_LLM_BASE_URL
 * - AUX_LLM_API_KEY
 * - AUX_LLM_MODEL
 * - AUX_LLM_PROVIDER(可选,默认 openai)
 */
export function loadAuxProviderConfig(): AuxProviderConfig | undefined {
  const baseURL = process.env.AUX_LLM_BASE_URL;
  const apiKey = process.env.AUX_LLM_API_KEY;
  const model = process.env.AUX_LLM_MODEL;
  if (!baseURL || !apiKey || !model) return undefined;
  const kind = (process.env.AUX_LLM_PROVIDER as ProviderKind | undefined) ?? "openai";
  return { baseURL, apiKey, model, kind };
}

/** 用辅助模型配置创建 provider。 */
export function createAuxProvider(config: AuxProviderConfig): LLMProvider {
  return createProvider(config.kind ?? "openai", {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
  });
}
