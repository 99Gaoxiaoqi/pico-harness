import { MODEL_PRICING } from "./model-pricing.generated.js";
import type { BillingRoute, PricingEntry } from "./pricing.js";

export { MODEL_PRICING };
function normalizeEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    if (
      ["https://api.openai.com", "https://api.anthropic.com"].includes(url.origin) &&
      (path === "" || path === "/v1")
    )
      return `${url.origin}/v1`;
    return url.origin + path;
  } catch {
    return undefined;
  }
}
const routePrices = new Map<string, (typeof MODEL_PRICING)[number] | null>();
for (const row of MODEL_PRICING) {
  const endpoint = row.api && normalizeEndpoint(row.api);
  if (!endpoint) continue;
  const key = JSON.stringify([endpoint, row.model]);
  const prior = routePrices.get(key);
  if (prior === null) continue;
  if (
    prior &&
    ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"].some(
      (field) => prior[field as keyof typeof prior] !== row[field as keyof typeof row],
    )
  ) {
    routePrices.set(key, null); // Ambiguous access paths require an explicit price override.
  } else routePrices.set(key, row);
}
export function catalogPricing(route: BillingRoute, at = Date.now()): PricingEntry | null {
  if (!route.baseUrl) return null;
  const endpoint = normalizeEndpoint(route.baseUrl);
  if (!endpoint) return null;
  // Official DeepSeek pricing is time dependent and takes precedence over the catalog.
  if (
    [
      "https://api.deepseek.com",
      "https://api.deepseek.com/v1",
      "https://api.deepseek.com/anthropic",
    ].includes(endpoint) &&
    ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"].includes(route.model)
  ) {
    const date = new Date(at),
      day = date.getUTCDay(),
      hour = date.getUTCHours();
    const peak = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    const factor = peak ? 2 : 1,
      pro = route.model === "deepseek-v4-pro";
    return {
      inputPerMillion: (pro ? 0.66 : 0.22) * factor,
      outputPerMillion: (pro ? 1.98 : 0.66) * factor,
      cacheReadPerMillion: (pro ? 0.022 : 0.007) * factor,
      cacheWritePerMillion: null,
      source: "official_docs_snapshot",
    };
  }
  const row = routePrices.get(JSON.stringify([endpoint, route.model]));
  if (!row) return null;
  return {
    inputPerMillion: row.inputPerMillion,
    outputPerMillion: row.outputPerMillion,
    cacheReadPerMillion: row.cacheReadPerMillion,
    cacheWritePerMillion: row.cacheWritePerMillion,
    source: "models_dev_snapshot",
  };
}
