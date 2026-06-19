// Provider 共享配置:从环境变量读取 BaseURL / API Key / 模型名。
// Node 22 通过 `node --env-file=.env` 或 `tsx --env-file=.env` 加载 .env。

export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export function loadProviderConfig(): ProviderConfig {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseURL || !apiKey || !model) {
    throw new Error(
      "缺少环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,请检查 .env 是否已加载",
    );
  }
  return { baseURL, apiKey, model };
}
