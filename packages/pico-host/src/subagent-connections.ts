import type { ModelCapabilityConfig, ProviderProtocol } from "@pico/core";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import {
  SUBAGENT_THINKING_LEVELS,
  type RuntimeSubagentConnection,
  type SubagentThinkingLevel,
} from "@pico/protocol";

export interface SubagentConnectionProviderConfig {
  readonly protocol: ProviderProtocol;
  readonly modelProtocols?: Readonly<Record<string, ProviderProtocol>>;
  readonly models: readonly string[];
  readonly modelCapabilities?: Readonly<Record<string, ModelCapabilityConfig>>;
}

export interface SubagentConnectionsConfig {
  readonly providers: Readonly<Record<string, SubagentConnectionProviderConfig>>;
}

/** Read-only configuration port; credentials and endpoints never cross this boundary. */
export interface SubagentConnectionsConfigSource {
  read(): Promise<{ readonly config: SubagentConnectionsConfig }>;
}

/** Host projection of configured models; no endpoints or credentials cross this boundary. */
export async function listSubagentConnections(
  source: SubagentConnectionsConfigSource,
): Promise<readonly RuntimeSubagentConnection[]> {
  const { config } = await source.read();
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
