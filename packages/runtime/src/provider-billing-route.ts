import type { ModelRouteCapabilities, ProviderKind } from "@pico/core";
import type { BillingRoute } from "./pricing.js";

/** Minimal, secret-free Provider route shape needed for usage billing. */
export interface ProviderBillingRouteConfig {
  readonly model: string;
  readonly baseURL: string;
  readonly capabilities?: Pick<ModelRouteCapabilities, "cache" | "price">;
}

/**
 * Projects a Provider route into the Runtime billing identity without creating
 * a Provider, reading credentials, or binding a mutable price catalog.
 */
export function billingRouteForProvider(
  kind: ProviderKind,
  config: ProviderBillingRouteConfig,
): BillingRoute | string {
  const price = config.capabilities?.price;
  if (!config.capabilities) return config.model;
  return {
    provider: kind,
    model: config.model,
    baseUrl: config.baseURL,
    cacheSupported: config.capabilities.cache,
    ...(price?.source === "config"
      ? {
          pricing: {
            inputPerMillion: price.inputPerMillion,
            outputPerMillion: price.outputPerMillion,
            cacheReadPerMillion: price.cacheReadPerMillion,
            cacheWritePerMillion: price.cacheWritePerMillion,
            source: "configured",
          },
        }
      : {}),
  };
}
