// Provider 共享配置:从环境变量读取 BaseURL / API Key / 模型名。
// Node 22 通过 `node --env-file=.env` 或 `tsx --env-file=.env` 加载 .env。

import type { ReasoningLevel } from "./reasoning-capability.js";
import type { RateLimitInfo } from "./ratelimit.js";
import type { ModelRouteCapabilities } from "./model-capabilities.js";

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Route-owned capability metadata. Legacy/direct callers may omit it. */
  capabilities?: ModelRouteCapabilities;
  /** Stable providerID/modelID identity for diagnostics and usage display. */
  routeId?: string;
  /**
   * 模型原生思考强度(第 N 讲:统一 ThinkingEffort)。
   * 不从环境变量加载 —— 由 CLI/调用方显式传入,保持本接口为纯网络配置 + 显式运行时参数。
   * 路由请求未提供时使用模型 profile 的默认档位；旧直连请求则不发送参数。
   */
  thinkingEffort?: ReasoningLevel;
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
