// Provider 共享配置:从环境变量读取 BaseURL / API Key / 模型名。
// Node 22 通过 `node --env-file=.env` 或 `tsx --env-file=.env` 加载 .env。

import type { ThinkingEffort } from "./thinking.js";

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * 模型原生思考强度(第 N 讲:统一 ThinkingEffort)。
   * 不从环境变量加载 —— 由 CLI/调用方显式传入,保持本接口为纯网络配置 + 显式运行时参数。
   * 未提供(off)时 provider 不发送任何 reasoning/thinking 参数,与旧行为一致。
   */
  thinkingEffort?: ThinkingEffort;
}

export function loadProviderConfig(): ProviderConfig {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseURL || !apiKey || !model) {
    throw new Error("缺少环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,请检查 .env 是否已加载");
  }
  return { baseURL, apiKey, model };
}
