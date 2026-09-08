import {
  SUBAGENT_THINKING_LEVELS,
  type RuntimeSubagentConnection,
  type SubagentThinkingLevel,
} from "@pico/protocol";
import type { UserConfigStore } from "../input/user-config-store.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";

/** Host projection of configured models; no endpoints or credentials cross this boundary. */
export async function listSubagentConnections(
  store: UserConfigStore,
): Promise<readonly RuntimeSubagentConnection[]> {
  const { config } = await store.read();
  return Object.entries(config.providers).map(([id, provider]) => ({
    id,
    name: id,
    enabled: true,
    models: provider.models.map((model) => {
      const capabilities = resolveModelRouteCapabilities(
        provider.modelProtocols?.[model] ?? provider.protocol,
        model,
        provider.modelCapabilities?.[model],
      );
      const levels = capabilities.reasoningProfile.levels.map((level) =>
        level === "none" || level === "nothink" ? "off" : level,
      );
      return {
        id: model,
        offerable: true,
        thinkingLevels: [...new Set(levels)].filter((level): level is SubagentThinkingLevel =>
          (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(level),
        ),
      };
    }),
  }));
}
