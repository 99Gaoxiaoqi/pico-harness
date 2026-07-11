// Provider 共享配置:从环境变量读取 BaseURL / API Key / 模型名。
// Node 22 通过 `node --env-file=.env` 或 `tsx --env-file=.env` 加载 .env。

import type { ThinkingEffort } from "./thinking.js";
import type { RateLimitInfo } from "./ratelimit.js";
import type { ModelRouteCapabilities } from "./model-capabilities.js";

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Route-owned capability metadata. Legacy/direct callers may omit it. */
  capabilities?: ModelRouteCapabilities;
  /**
   * 模型原生思考强度(第 N 讲:统一 ThinkingEffort)。
   * 不从环境变量加载 —— 由 CLI/调用方显式传入,保持本接口为纯网络配置 + 显式运行时参数。
   * 未提供(off)时 provider 不发送任何 reasoning/thinking 参数,与旧行为一致。
   */
  thinkingEffort?: ThinkingEffort;
  /**
   * 限流信息回传回调(第 N 讲:RateLimit header 回传)。
   * provider 在每次响应(resp.ok)成功后解析 RateLimit header,命中即回调。
   * 可选:未提供时 provider 不解析 header,行为与旧版一致。
   */
  onRateLimitInfo?: (info: RateLimitInfo) => void;
}

/**
 * 读取所有可用 API key:
 * - 优先读 LLM_API_KEYS(逗号分隔,复数,支持多凭证轮换);
 * - 回退到 LLM_API_KEY(单数,向后兼容单 key);
 * - 过滤空段(逗号分隔可能产生空字符串)。
 * 返回值:无 key 时返回空数组。
 */
export function loadApiKeys(): string[] {
  const multi = process.env.LLM_API_KEYS;
  if (multi && multi.trim().length > 0) {
    const keys = multi
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (keys.length > 0) return keys;
  }
  const single = process.env.LLM_API_KEY;
  return single && single.trim().length > 0 ? [single.trim()] : [];
}

export function loadProviderConfig(): ProviderConfig {
  const baseURL = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  const keys = loadApiKeys();
  // apiKey 取第一个(向后兼容:ProviderConfig.apiKey 仍是单个 key)。
  // 多 key 轮换由 CredentialPool 在 factory 层接管,见 credential-pool.ts。
  const apiKey = keys[0];
  if (!baseURL || !apiKey || !model) {
    throw new Error(
      "缺少环境变量 LLM_BASE_URL / LLM_API_KEY[S] / LLM_MODEL,请检查 .env 是否已加载",
    );
  }
  return { baseURL, apiKey, model };
}
