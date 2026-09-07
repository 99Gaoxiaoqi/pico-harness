import { MODEL_PRICING } from "../observability/catalog-pricing.js";
import type { UsagePrice } from "@pico/protocol";
import type { ModelProviderConfig } from "../provider/model-router.js";

/** Display-only snapshot. Never reprice historical calls from today's catalog. */
export function usagePricing(providers: Record<string, ModelProviderConfig>): UsagePrice[] {
  const rows: UsagePrice[] = [];
  const officialOverrides = new Set<string>();
  for (const [provider, config] of Object.entries(providers)) {
    for (const [model, capabilities] of Object.entries(config.modelCapabilities ?? {})) {
      if (!capabilities.price) continue;
      rows.push({ provider, model, source: "configured", ...capabilities.price });
      try {
        if (new URL(config.baseURL).hostname === "api.deepseek.com") officialOverrides.add(model);
      } catch {
        /* Invalid routes are validated by provider configuration. */
      }
    }
  }
  // Verified 2026-09-07 against the official USD table. These are direct API prices,
  // not prices for third-party gateways serving the same model name.
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]) {
    if (officialOverrides.has(model)) continue;
    const pro = model === "deepseek-v4-pro";
    for (const peak of [false, true]) {
      const factor = peak ? 2 : 1;
      rows.push({
        provider: "DeepSeek 官方 API",
        model,
        source: "official_docs_snapshot",
        inputPerMillion: (pro ? 0.66 : 0.22) * factor,
        outputPerMillion: (pro ? 1.98 : 0.66) * factor,
        cacheReadPerMillion: (pro ? 0.022 : 0.007) * factor,
        cacheWritePerMillion: null,
        tier: peak ? "高峰" : "低峰",
        note: "高峰：周一至周五 UTC 01:00–04:00、06:00–10:00；其余为低峰。缓存写入未单列收费。",
        sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
        verifiedAt: "2026-09-07",
      });
    }
  }
  for (const row of MODEL_PRICING) {
    if (row.provider === "deepseek" && row.model.startsWith("deepseek-v4-")) continue;
    if (rows.some((entry) => entry.provider === row.provider && entry.model === row.model))
      continue;
    rows.push({
      provider: row.provider,
      model: row.model,
      inputPerMillion: row.inputPerMillion,
      outputPerMillion: row.outputPerMillion,
      cacheReadPerMillion: row.cacheReadPerMillion,
      cacheWritePerMillion: row.cacheWritePerMillion,
      source: "models_dev_snapshot",
      sourceUrl: "https://models.dev",
      note: "models.dev 构建快照；仅适用于对应厂商路由",
    });
  }
  return rows;
}
