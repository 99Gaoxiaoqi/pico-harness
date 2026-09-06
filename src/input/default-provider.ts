import type { ModelProviderConfig } from "../provider/model-router.js";

export const OPENCODE_FREE_PROVIDER_ID = "opencode-free";
export const OPENCODE_FREE_MODEL = "nemotron-3-ultra-free";
export const OPENCODE_FREE_ROUTE_ID = `${OPENCODE_FREE_PROVIDER_ID}/${OPENCODE_FREE_MODEL}`;

/** Static free Chat Completions allowlist; never discover the mixed paid Zen catalog. */
export const OPENCODE_FREE_PROVIDER: ModelProviderConfig = Object.freeze({
  protocol: "openai",
  baseURL: "https://opencode.ai/zen/v1",
  auth: "none",
  apiKeyEnv: "OPENCODE_API_KEY",
  models: Object.freeze([OPENCODE_FREE_MODEL]),
  discoverModels: false,
});

export function hasExplicitModelEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return [
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_MODELS",
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_API_KEYS",
  ].some((name) => Boolean(env[name]?.trim()));
}
