import type { ProviderConfigView } from "./model.js";
import { isRecord, stringValue } from "./runtime-projections/values.js";

/** Only the runtime's resolved capability establishes native search support. */
export function defaultModelWebSearch(config: ProviderConfigView): {
  readonly available: boolean;
  readonly detail: string;
} {
  const routeId = config.userDefaults.modelRouteId ?? config.defaultModelRouteId;
  if (!routeId) return { available: false, detail: "未选择用户默认模型，请先在模型设置中选择。" };
  const provider = config.providers.find((item) => routeId.startsWith(`${item.id}/`));
  const model = provider ? routeId.slice(provider.id.length + 1) : "";
  const capabilities = provider?.resolvedModelCapabilities?.[model];
  const native = isRecord(capabilities) ? capabilities.nativeWebSearch : undefined;
  if (!isRecord(native) || typeof native.available !== "boolean") {
    return { available: false, detail: `${routeId}：尚未取得原生搜索能力，当前不可用。` };
  }
  return {
    available: native.available,
    detail: `${routeId}：${stringValue(native.reason, native.available ? "支持原生搜索" : "不支持原生搜索")}`,
  };
}
