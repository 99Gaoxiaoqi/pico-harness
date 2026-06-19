// Provider 工厂:按协议类型创建对应适配器。

import { loadProviderConfig, type ProviderConfig } from "./config.js";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./interface.js";

export type ProviderKind = "openai" | "claude";

/** 按协议类型创建 Provider;不传 config 时从环境变量读取 */
export function createProvider(kind: ProviderKind, config?: ProviderConfig): LLMProvider {
  const cfg = config ?? loadProviderConfig();
  switch (kind) {
    case "openai":
      return new OpenAIProvider(cfg);
    case "claude":
      return new ClaudeProvider(cfg);
  }
}
