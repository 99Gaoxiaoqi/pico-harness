import { MODEL_PRICING } from "../observability/catalog-pricing.js";
import type { ModelProviderConfig } from "../provider/model-router.js";
import { usagePricing as projectUsagePricing } from "@pico/pico-host";
import type { UsagePrice } from "@pico/protocol";

/** Legacy entry point supplying Provider and catalog snapshots to the Host projection. */
export function usagePricing(providers: Record<string, ModelProviderConfig>): UsagePrice[] {
  return projectUsagePricing(providers, MODEL_PRICING);
}
