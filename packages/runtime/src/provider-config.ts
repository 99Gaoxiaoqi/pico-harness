import type { ModelRouteCapabilities, ReasoningLevel } from "@pico/core";
import type { RateLimitInfo } from "./rate-limit.js";

/** Provider network configuration owned by the model runtime boundary. */
export interface ProviderConfig {
  baseURL: string;
  apiKey: string;
  auth?: "api-key" | "none";
  /** Opaque host session identity for endpoints that require client attribution. */
  sessionId?: string;
  model: string;
  /** Route-owned capability metadata. Explicit test/host callers may omit it. */
  capabilities?: ModelRouteCapabilities;
  /** Stable providerID/modelID identity for diagnostics and usage display. */
  routeId?: string;
  /** Native reasoning effort selected by the caller or model profile. */
  thinkingEffort?: ReasoningLevel;
  /** Optional callback for normalized provider rate-limit observations. */
  onRateLimitInfo?: (info: RateLimitInfo) => void;
}
