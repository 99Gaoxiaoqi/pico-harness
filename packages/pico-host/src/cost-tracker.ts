import { CostTracker as RuntimeCostTracker } from "@pico/runtime/cost-tracker";
import { catalogPricing } from "./catalog-pricing.js";
import { logger } from "./logger.js";
export * from "@pico/runtime/cost-tracker";
export class CostTracker extends RuntimeCostTracker {
  constructor(...args: ConstructorParameters<typeof RuntimeCostTracker>) {
    super(args[0], args[1], args[2], {
      ...args[3],
      catalogPricing: args[3]?.catalogPricing ?? catalogPricing,
      diagnostics: args[3]?.diagnostics ?? logger,
    });
  }
}
