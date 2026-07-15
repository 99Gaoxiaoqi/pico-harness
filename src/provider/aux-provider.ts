import type { ProviderConfig } from "./config.js";
import type { ProviderKind } from "./factory.js";

export type AuxProviderEnv = Readonly<Record<string, string | undefined>>;

export interface AuxProviderConfig {
  readonly kind: ProviderKind;
  readonly config: ProviderConfig;
}

/**
 * 只从宿主显式冻结的环境快照解析辅助模型；不得回退到 process.env。
 * 三个必填字段缺任意一个时禁用辅助模型，由 FullCompactor 使用主 Provider。
 */
export function resolveAuxProviderConfig(env: AuxProviderEnv): AuxProviderConfig | undefined {
  const baseURL = env["AUX_LLM_BASE_URL"];
  const apiKey = env["AUX_LLM_API_KEY"];
  const model = env["AUX_LLM_MODEL"];
  if (!baseURL || !apiKey || !model) return undefined;
  return {
    kind: (env["AUX_LLM_PROVIDER"] as ProviderKind | undefined) ?? "openai",
    config: { baseURL, apiKey, model },
  };
}
