import type { ProviderConfig } from "./config.js";

/** Send Pico's actual identity only to the documented OpenCode Zen and Go endpoints. */
export function openCodeClientHeaders(config: ProviderConfig): Record<string, string> {
  const url = new URL(config.baseURL);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "opencode.ai" ||
    !/^\/zen\/(?:go\/)?v1(?:\/|$)/u.test(url.pathname)
  )
    return {};
  return {
    "User-Agent": "Pico/0.1.0",
    ...(config.sessionId ? { "x-opencode-session": config.sessionId } : {}),
  };
}
