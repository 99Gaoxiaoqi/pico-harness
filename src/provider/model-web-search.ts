import type { ProviderKind } from "./factory.js";

const OPENAI_SEARCH_MODELS: ReadonlySet<string> = new Set([
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
  "o3",
  "o4-mini",
]);
const ANTHROPIC_SEARCH_MODELS: ReadonlySet<string> = new Set([
  "claude-sonnet-4",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-haiku-4-5",
]);

export interface NativeWebSearchCapability {
  available: boolean;
  reason: string;
  adapter?: "openai-web-search" | "anthropic-web-search";
}

/** Only HTTPS endpoints with an exact official authority receive automatic capabilities. */
export function isOfficialEndpoint(baseURL: string | undefined, hostname: string): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return (
      url.protocol === "https:" &&
      url.hostname === hostname &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

export function resolveNativeWebSearchCapability(input: {
  provider: ProviderKind;
  model: string;
  baseURL?: string;
  webSearch?: boolean;
}): NativeWebSearchCapability {
  const { provider, model, baseURL, webSearch } = input;
  if (webSearch === false) return { available: false, reason: "模型配置已禁用原生联网搜索" };
  if (provider === "responses" && isOfficialEndpoint(baseURL, "api.deepseek.com")) {
    return {
      available: false,
      reason:
        "DeepSeek Responses 当前不支持 web_search，且 Open Responses 适配器会过滤原生搜索工具",
    };
  }
  if (provider === "openai") {
    return { available: false, reason: "当前 Chat Completions 协议不支持原生搜索工具" };
  }
  const adapter = provider === "responses" ? "openai-web-search" : "anthropic-web-search";
  if (webSearch === true)
    return { available: true, adapter, reason: "模型配置已明确确认原生联网搜索能力" };
  const officialOpenAI =
    provider === "responses" &&
    isOfficialEndpoint(baseURL, "api.openai.com") &&
    OPENAI_SEARCH_MODELS.has(model.replace(/-\d{4}-\d{2}-\d{2}$/u, ""));
  const officialAnthropic =
    provider === "claude" &&
    isOfficialEndpoint(baseURL, "api.anthropic.com") &&
    ANTHROPIC_SEARCH_MODELS.has(model.replace(/-\d{8}$/u, ""));
  if (officialOpenAI || officialAnthropic) {
    return { available: true, adapter, reason: "官方端点及已知模型族支持原生联网搜索" };
  }
  return { available: false, reason: "当前端点或模型的原生联网搜索能力未经确认" };
}
