import { toCanonicalUsage, type CanonicalUsage, type Usage } from "@pico/core";

export type BillingMode = "metered" | "subscription_included";
export type CostSource =
  | "models_dev_snapshot"
  | "official_docs_snapshot"
  | "configured"
  | "included";
export type CostStatus = "estimated" | "included" | "unknown";

export interface BillingRoute {
  readonly provider: string;
  readonly model: string;
  /** Route identity only; the optional catalog resolver decides endpoint-specific prices. */
  readonly baseUrl?: string;
  readonly cacheSupported?: boolean | "unknown";
  readonly billingMode?: BillingMode;
  /** null explicitly disables all implicit price tables for this routed model. */
  readonly pricing?: PricingEntry | null;
}

export interface PricingEntry {
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly cacheReadPerMillion: number | null;
  readonly cacheWritePerMillion: number | null;
  readonly source: CostSource;
}

export interface CostResult {
  readonly status: CostStatus;
  readonly usage: CanonicalUsage;
  readonly costUSD: number;
  readonly costCNY: number;
  readonly pricing: PricingEntry | null;
}

/** An outer catalog supplies endpoint-specific prices without making Runtime own the dataset. */
export type CatalogPricingResolver = (route: BillingRoute, at?: number) => PricingEntry | null;

const USD_TO_CNY = 7.2;

const INCLUDED_PRICING: PricingEntry = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
  source: "included",
};

const OFFICIAL_PRICING: Readonly<Record<string, PricingEntry>> = {
  "glm-5.2": {
    inputPerMillion: 0.5,
    outputPerMillion: 0.5,
    cacheReadPerMillion: 0.05,
    cacheWritePerMillion: 0.5,
    source: "official_docs_snapshot",
  },
  "glm-4.5-air": {
    inputPerMillion: 0.15,
    outputPerMillion: 0.15,
    cacheReadPerMillion: 0.015,
    cacheWritePerMillion: 0.15,
    source: "official_docs_snapshot",
  },
  "kimi-k2.5": {
    inputPerMillion: 0.6,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.06,
    cacheWritePerMillion: 0.6,
    source: "official_docs_snapshot",
  },
  "claude-3-5-sonnet": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    source: "official_docs_snapshot",
  },
};

export function getPricingEntry(
  route: BillingRoute,
  catalogPricing?: CatalogPricingResolver,
): PricingEntry | null {
  if (route.billingMode === "subscription_included") return INCLUDED_PRICING;
  if (Object.hasOwn(route, "pricing")) return route.pricing ?? null;
  if (route.baseUrl && catalogPricing) return catalogPricing(route);
  return OFFICIAL_PRICING[normalizeModelName(route.model)] ?? null;
}

export function estimateCost(
  routeOrModel: BillingRoute | string,
  usage: Usage,
  catalogPricing?: CatalogPricingResolver,
): CostResult {
  const route =
    typeof routeOrModel === "string" ? { provider: "unknown", model: routeOrModel } : routeOrModel;
  const canonical = toCanonicalUsage(usage);
  const pricing = getPricingEntry(route, catalogPricing);
  if (!pricing || hasUnknownActivePrice(pricing, canonical)) {
    return {
      status: "unknown",
      usage: canonical,
      costUSD: 0,
      costCNY: 0,
      pricing: null,
    };
  }

  const status: CostStatus = pricing.source === "included" ? "included" : "estimated";
  const input = canonical.inputTokens * (pricing.inputPerMillion ?? 0);
  const output =
    (canonical.outputTokens + canonical.reasoningTokens) * (pricing.outputPerMillion ?? 0);
  const cacheRead = canonical.cacheReadTokens * (pricing.cacheReadPerMillion ?? 0);
  const cacheWrite = canonical.cacheWriteTokens * (pricing.cacheWritePerMillion ?? 0);
  const costUSD = (input + output + cacheRead + cacheWrite) / 1_000_000;
  return {
    status,
    usage: canonical,
    costUSD,
    costCNY: costUSD * USD_TO_CNY,
    pricing,
  };
}

export function isFreeTierModel(model: string): boolean {
  const normalized = normalizeModelName(model);
  const pricing = OFFICIAL_PRICING[normalized];
  return (
    normalized.endsWith(":free") ||
    (pricing !== undefined &&
      pricing.inputPerMillion === 0 &&
      pricing.outputPerMillion === 0 &&
      pricing.cacheReadPerMillion === 0 &&
      pricing.cacheWritePerMillion === 0)
  );
}

function hasUnknownActivePrice(pricing: PricingEntry, usage: CanonicalUsage): boolean {
  return (
    (usage.inputTokens > 0 && pricing.inputPerMillion === null) ||
    (usage.outputTokens + usage.reasoningTokens > 0 && pricing.outputPerMillion === null) ||
    (usage.cacheReadTokens > 0 && pricing.cacheReadPerMillion === null) ||
    (usage.cacheWriteTokens > 0 && pricing.cacheWritePerMillion === null)
  );
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}
