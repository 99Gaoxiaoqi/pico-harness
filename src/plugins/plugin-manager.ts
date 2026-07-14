import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { resolvePluginContributions } from "./plugin-resolver.js";
import type {
  PluginCompatibility,
  PluginDiagnostic,
  PluginManifest,
  PluginManifestSource,
  PluginResourceFingerprint,
  PluginScope,
} from "./plugin-types.js";

export type { PluginManifest, PluginScope } from "./plugin-types.js";

export interface PluginOperationResult {
  success: boolean;
  message: string;
  pluginId?: string;
  pluginName?: string;
  scope?: PluginScope;
}

export interface InstalledPlugin {
  id: string;
  scope: PluginScope;
  manifest: PluginManifest;
  installPath: string;
  enabled: boolean;
  manifestSource: PluginManifestSource;
  compatibility: PluginCompatibility;
  diagnostics: readonly PluginDiagnostic[];
  resourceFingerprint: PluginResourceFingerprint;
}

const SCOPE_ORDER: PluginScope[] = ["user", "project", "local"];

export interface PluginManagerOptions {
  statePath?: string;
  workDir?: string;
  picoHome?: string;
  homeDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

interface PluginState {
  plugins: Record<string, Partial<Record<PluginScope, StoredPlugin>>>;
}

interface StoredPlugin {
  installPath: string;
  manifest: PluginManifest;
  enabled: boolean;
  manifestSource: PluginManifestSource;
  compatibility: PluginCompatibility;
  diagnostics: readonly PluginDiagnostic[];
  resourceFingerprint: PluginResourceFingerprint;
}

export class PluginManager {
  private readonly statePath: string;

  constructor(options: PluginManagerOptions = {}) {
    this.statePath =
      options.statePath ??
      resolvePicoPaths(options.workDir ?? process.cwd(), {
        ...(options.picoHome ? { picoHome: options.picoHome } : {}),
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.env ? { env: options.env } : {}),
      }).workspace.pluginState;
  }

  async installFromDirectory(
    directoryPath: string,
    scope: PluginScope,
  ): Promise<PluginOperationResult> {
    const resolution = await resolvePluginContributions(directoryPath);
    if (resolution.compatibility === "blocked" || !resolution.fingerprint) {
      return {
        success: false,
        message:
          resolution.diagnostics.find((item) => item.compatibility === "blocked")?.message ??
          `Plugin ${directoryPath} could not be resolved.`,
        scope,
      };
    }

    const manifest = resolution.manifest;
    const state = await this.readState();
    const current = state.plugins[manifest.name]?.[scope];
    state.plugins[manifest.name] = {
      ...(state.plugins[manifest.name] ?? {}),
      [scope]: {
        installPath: resolution.plugin.root,
        manifest,
        enabled: current?.enabled ?? false,
        manifestSource: resolution.plugin.manifestSource,
        compatibility: resolution.compatibility,
        diagnostics: resolution.diagnostics,
        resourceFingerprint: resolution.fingerprint,
      },
    };
    await this.writeState(state);

    return {
      success: true,
      message: `Installed plugin ${manifest.name}${manifest.version ? `@${manifest.version}` : ""} to ${scope}.`,
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
              manifestSource: plugin.manifestSource,
              compatibility: plugin.compatibility,
              diagnostics: plugin.diagnostics,
              resourceFingerprint: plugin.resourceFingerprint,
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

function scopeRank(scope: PluginScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
