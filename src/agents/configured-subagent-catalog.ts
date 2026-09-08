import type {
  RuntimeConfiguredSubagent,
  RuntimeSubagentAvailability,
  RuntimeSubagentConnection,
  RuntimeSubagentPreset,
} from "@pico/protocol";

export interface ConfiguredSubagentCatalog {
  list(): Promise<RuntimeConfiguredSubagent[]>;
  resolve(id: string): Promise<RuntimeSubagentPreset & { modelRouteId: string }>;
}

export interface ConfiguredSubagentCatalogDependencies {
  readonly getPresets: () => Promise<readonly RuntimeSubagentPreset[]>;
  readonly getConnections: () => Promise<readonly RuntimeSubagentConnection[]>;
}

/** Read both sources afresh so edits and removed Provider routes take effect at admission. */
export function createConfiguredSubagentCatalog(
  dependencies: ConfiguredSubagentCatalogDependencies,
): ConfiguredSubagentCatalog {
  return {
    async list() {
      const [presets, connections] = await Promise.all([
        dependencies.getPresets(),
        dependencies.getConnections(),
      ]);
      return presets.map((preset) => ({
        ...preset,
        availability: inspectAvailability(preset, connections),
      }));
    },
    async resolve(id) {
      const presets = await dependencies.getPresets();
      const preset = presets.find((item) => item.id === id);
      if (!preset) throw new Error(`Unknown subagent_id "${id}". Call agent_list before spawning.`);
      const availability = inspectAvailability(preset, await dependencies.getConnections());
      if (availability.status === "unavailable") {
        throw new Error(`Subagent preset "${id}" is unavailable: ${availability.reason}.`);
      }
      return { ...preset, modelRouteId: `${preset.connectionSlug}/${preset.model}` };
    },
  };
}

function inspectAvailability(
  preset: RuntimeSubagentPreset,
  connections: readonly RuntimeSubagentConnection[],
): RuntimeSubagentAvailability {
  const connection = connections.find((candidate) => candidate.id === preset.connectionSlug);
  const reason = !preset.enabled
    ? "disabled"
    : !connection
      ? "missing_connection"
      : connection.retired
        ? "provider_retired"
        : !connection.enabled
          ? "connection_disabled"
          : !connection.models.some((model) => model.id === preset.model)
            ? "model_disabled"
            : undefined;
  return reason ? { status: "unavailable", reason } : { status: "available" };
}
