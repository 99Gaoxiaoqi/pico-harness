import type { ModelProviderConfig } from "@pico/pico-host/provider/model-router";

export const OPENCODE_FREE_PROVIDER_ID = "opencode-free";
export const OPENCODE_FREE_MODEL = "nemotron-3-ultra-free";
export const OPENCODE_FREE_ROUTE_ID = `${OPENCODE_FREE_PROVIDER_ID}/${OPENCODE_FREE_MODEL}`;

/** Legacy route fixture. Tests replace the endpoint with local HTTP. */
export const OPENCODE_FREE_PROVIDER: ModelProviderConfig = Object.freeze({
  protocol: "openai",
  baseURL: "https://opencode.ai/zen/v1",
  auth: "none",
  apiKeyEnv: "OPENCODE_API_KEY",
  models: Object.freeze([OPENCODE_FREE_MODEL]),
  discoverModels: false,
});
