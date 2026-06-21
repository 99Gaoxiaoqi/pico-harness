import { toCanonicalUsage, type CanonicalUsage, type Usage } from "../schema/message.js";

export type BillingMode = "metered" | "subscription_included";
export type CostSource = "official_docs_snapshot" | "included";
export type CostStatus = "estimated" | "included" | "unknown";

export interface BillingRoute {
  provider: string;
  model: string;
  baseUrl?: string;
  billingMode?: BillingMode;
}

export interface PricingEntry {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  source: CostSource;
}

export interface CostResult {
  status: CostStatus;
  usage: CanonicalUsage;
  costUSD: number;
  costCNY: number;
  pricing: PricingEntry | null;
}

const USD_TO_CNY = 7.2;

const INCLUDED_PRICING: PricingEntry = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
  source: "included",
};

const OFFICIAL_PRICING: Record<string, PricingEntry> = {
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

export function getPricingEntry(route: BillingRoute): PricingEntry | null {
  if (route.billingMode === "subscription_included") {
    return INCLUDED_PRICING;
  }
  return OFFICIAL_PRICING[normalizeModelName(route.model)] ?? null;
}

export function estimateCost(routeOrModel: BillingRoute | string, usage: Usage): CostResult {
  const route =
    typeof routeOrModel === "string"
      ? { provider: "unknown", model: routeOrModel }
      : routeOrModel;
  const canonical = toCanonicalUsage(usage);
  const pricing = getPricingEntry(route);
  if (!pricing) {
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

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}
