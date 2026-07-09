import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  InstalledPlugin,
  PluginManifest,
  PluginOperationResult,
  PluginScope,
} from "./plugin-types.js";

export type { InstalledPlugin, PluginManifest, PluginOperationResult, PluginScope };

const SCOPE_ORDER: PluginScope[] = ["user", "project", "local"];

interface PluginManagerOptions {
  statePath?: string;
}

interface PluginState {
  plugins: Record<string, Partial<Record<PluginScope, StoredPlugin>>>;
}

interface StoredPlugin {
  installPath: string;
  manifest: PluginManifest;
  enabled: boolean;
}

export class PluginManager {
  private readonly statePath: string;

  constructor(options: PluginManagerOptions = {}) {
    this.statePath = options.statePath ?? resolve(process.cwd(), ".pico", "plugins.json");
  }

  async installFromDirectory(
    directoryPath: string,
    scope: PluginScope,
  ): Promise<PluginOperationResult> {
    const resolvedPath = resolve(directoryPath);
    const manifestResult = await this.loadManifest(resolvedPath);
    if (!manifestResult.success) {
      return {
        success: false,
        message: manifestResult.message,
        scope,
      };
    }

    const manifest = manifestResult.manifest;
    const state = await this.readState();
    const current = state.plugins[manifest.name]?.[scope];
    state.plugins[manifest.name] = {
      ...(state.plugins[manifest.name] ?? {}),
      [scope]: {
        installPath: resolvedPath,
        manifest,
        enabled: current?.enabled ?? false,
      },
    };
    await this.writeState(state);

    return {
      success: true,
      message: `Installed plugin ${manifest.name}@${manifest.version} to ${scope}.`,
      pluginId: manifest.name,
      pluginName: manifest.name,
      scope,
    };
  }

  async enable(id: string, scope: PluginScope): Promise<PluginOperationResult> {
    return this.setEnabled(id, scope, true);
  }

  async disable(id: string, scope: PluginScope): Promise<PluginOperationResult> {
    return this.setEnabled(id, scope, false);
  }

  async list(): Promise<InstalledPlugin[]> {
    const state = await this.readState();
    return Object.entries(state.plugins)
      .flatMap(([id, scopes]) =>
        SCOPE_ORDER.flatMap((scope) => {
          const plugin = scopes[scope];
          if (!plugin) return [];
          return [
            {
              id,
              scope,
              manifest: { ...plugin.manifest },
              installPath: plugin.installPath,
              enabled: plugin.enabled,
            },
          ];
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id) || scopeRank(a.scope) - scopeRank(b.scope));
  }

  private async setEnabled(
    id: string,
    scope: PluginScope,
    enabled: boolean,
  ): Promise<PluginOperationResult> {
    const state = await this.readState();
    const plugin = state.plugins[id]?.[scope];
    if (!plugin) {
      return {
        success: false,
        message: `Plugin ${id} is not installed in ${scope} scope.`,
        pluginId: id,
        scope,
      };
    }

    plugin.enabled = enabled;
    await this.writeState(state);
    return {
      success: true,
      message: `${enabled ? "Enabled" : "Disabled"} plugin ${id} in ${scope}.`,
      pluginId: id,
      pluginName: plugin.manifest.name,
      scope,
    };
  }

  private async loadManifest(
    pluginPath: string,
  ): Promise<{ success: true; manifest: PluginManifest } | { success: false; message: string }> {
    const dir = await stat(pluginPath).catch(() => undefined);
    if (!dir?.isDirectory()) {
      return { success: false, message: `Plugin directory not found: ${pluginPath}` };
    }

    const manifestPath = await findManifestPath(pluginPath);
    if (!manifestPath) {
      return {
        success: false,
        message: `Plugin manifest not found: ${join(pluginPath, ".claude-plugin", "plugin.json")}`,
      };
    }

    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch (error) {
      return { success: false, message: `Failed to read plugin manifest: ${errorMessage(error)}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { success: false, message: `Invalid plugin manifest JSON: ${errorMessage(error)}` };
    }

    if (!isRecord(parsed)) {
      return { success: false, message: "Plugin manifest must be a JSON object." };
    }
    if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
      return { success: false, message: "Plugin manifest requires a non-empty name." };
    }
    if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
      return { success: false, message: "Plugin manifest requires a non-empty version." };
    }

    return {
      success: true,
      manifest: {
        ...parsed,
        name: parsed.name,
        version: parsed.version,
      },
    };
  }

  private async readState(): Promise<PluginState> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch {
      return { plugins: {} };
    }

    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.plugins)) {
        return { plugins: {} };
      }
      return { plugins: parsed.plugins as PluginState["plugins"] };
    } catch {
      return { plugins: {} };
    }
  }

  private async writeState(state: PluginState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

async function findManifestPath(pluginPath: string): Promise<string | undefined> {
  const candidates = [
    join(pluginPath, ".claude-plugin", "plugin.json"),
    join(pluginPath, "plugin.json"),
  ];
  for (const candidate of candidates) {
    const candidateStat = await stat(candidate).catch(() => undefined);
    if (candidateStat?.isFile()) return candidate;
  }
  return undefined;
}

function scopeRank(scope: PluginScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
