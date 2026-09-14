import { catalogPricing } from "./catalog-pricing.js";
import {
  estimateCost as estimateCostFromRuntime,
  getPricingEntry as getPricingEntryFromRuntime,
  isFreeTierModel,
  type BillingRoute,
  type CostResult,
  type PricingEntry,
} from "@pico/runtime/pricing";
import type { Usage } from "@pico/core";

export type {
  BillingMode,
  BillingRoute,
  CatalogPricingResolver,
  CostResult,
  CostSource,
  CostStatus,
  PricingEntry,
} from "@pico/runtime/pricing";

/** @deprecated 成本计算策略已迁入 @pico/runtime；此入口继续绑定本地价格快照。 */
export function getPricingEntry(route: BillingRoute): PricingEntry | null {
  return getPricingEntryFromRuntime(route, catalogPricing);
}

/** @deprecated 成本计算策略已迁入 @pico/runtime；此入口继续绑定本地价格快照。 */
export function estimateCost(routeOrModel: BillingRoute | string, usage: Usage): CostResult {
  return estimateCostFromRuntime(routeOrModel, usage, catalogPricing);
}

export { isFreeTierModel };
