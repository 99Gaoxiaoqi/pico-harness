import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePicoPaths, type ResolvePicoPathsOptions } from "../paths/pico-paths.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";
import { resolvePluginContributions } from "./plugin-resolver.js";
import {
  PLUGIN_SCOPE_ORDER,
  describePluginScopeRegistry,
  inspectPluginInstallPath,
  isPluginPathWithinScope,
  pluginInstallPath,
  resolvePluginScopeRoots,
  scopeRoot,
  type PluginScopeRegistryDescriptor,
  type PluginScopeRoots,
} from "./plugin-scope.js";
import type {
  PluginCompatibility,
  PluginDiagnostic,
  PluginManifest,
  PluginManifestSource,
  PluginResourceFingerprint,
  PluginScope,
} from "./plugin-types.js";

export type { PluginManifest, PluginScope } from "./plugin-types.js";
export {
  describePluginScopeRegistry,
  inspectPluginInstallPath,
  pluginInstallPath,
  resolvePluginScopeRoots,
  selectPluginScopeWinners,
} from "./plugin-scope.js";
export type { PluginScopeRegistryDescriptor, PluginScopeRoots } from "./plugin-scope.js";

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

const SCOPE_ORDER = PLUGIN_SCOPE_ORDER;

export interface PluginManagerOptions {
  statePath?: string;
  /** Optional override for the global user-scope registry, primarily for tests. */
  userStatePath?: string;
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
  private readonly workspaceStatePath: string;
  private readonly userStatePath: string;
  private readonly scopeRoots: PluginScopeRoots;
  private readonly scopeRegistry: PluginScopeRegistryDescriptor;

  constructor(options: PluginManagerOptions = {}) {
    const workDir = options.workDir ?? process.cwd();
    const pathOptions = {
      ...(options.picoHome ? { picoHome: options.picoHome } : {}),
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      ...(options.env ? { env: options.env } : {}),
    } satisfies ResolvePicoPathsOptions;
    const paths = resolvePicoPaths(workDir, pathOptions);
    this.workspaceStatePath = options.statePath ?? paths.workspace.pluginState;
    this.userStatePath =
      options.userStatePath ??
      (options.statePath
        ? join(resolve(options.statePath), "../user-plugins.json")
        : join(paths.home.root, "plugins.json"));
    this.scopeRoots = resolvePluginScopeRoots(workDir, pathOptions);
    const registry = describePluginScopeRegistry(workDir, pathOptions);
    this.scopeRegistry = Object.freeze({
      ...registry,
      userStatePath: this.userStatePath,
      workspaceStatePath: this.workspaceStatePath,
    });
  }

  /** Physical roots and registry ownership consumed by diagnostics and host adapters. */
  getScopeRegistry(): PluginScopeRegistryDescriptor {
    return this.scopeRegistry;
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
    const state = await this.readState(scope);
    const current = state.plugins[manifest.name]?.[scope];
    const destination = pluginInstallPath(scope, manifest.name, this.scopeRoots);
    const sourceRoot = resolution.plugin.root;
    let managedPath: string;
    try {
      managedPath = await this.ensureManagedPluginRoot({
        sourceRoot,
        destination,
        scope,
        pluginId: manifest.name,
        expectedFingerprint: resolution.fingerprint,
        current,
      });
    } catch (error) {
      return {
        success: false,
        message: errorMessage(error),
        pluginId: manifest.name,
        pluginName: manifest.name,
        scope,
      };
    }
    state.plugins[manifest.name] = {
      ...(state.plugins[manifest.name] ?? {}),
      [scope]: {
        installPath: managedPath,
        manifest,
        enabled: current?.enabled ?? false,
        manifestSource: resolution.plugin.manifestSource,
        compatibility: resolution.compatibility,
        diagnostics: resolution.diagnostics,
        resourceFingerprint: resolution.fingerprint,
      },
    };
    await this.writeState(state, scope);

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
    const [workspaceState, userState] = await Promise.all([
      this.readState("project"),
      this.readState("user"),
    ]);
    const byScope = new Map<
      string,
      { readonly id: string; readonly scope: PluginScope; readonly plugin: StoredPlugin }
    >();
    for (const [id, scopes] of Object.entries(workspaceState.plugins)) {
      if (!isRecord(scopes)) continue;
      for (const [rawScope, rawPlugin] of Object.entries(scopes)) {
        if (!isPluginScope(rawScope) || !isStoredPlugin(rawPlugin)) continue;
        const scope = rawScope;
        const plugin = rawPlugin;
        byScope.set(`${scope}\0${id}`, { id, scope, plugin });
      }
    }
    // The global registry is authoritative for user scope and also repairs entries written by
    // older versions that kept all scopes in the workspace registry.
    for (const [id, scopes] of Object.entries(userState.plugins)) {
      if (!isRecord(scopes)) continue;
      for (const [rawScope, rawPlugin] of Object.entries(scopes)) {
        if (rawScope !== "user" || !isStoredPlugin(rawPlugin)) continue;
        const scope = rawScope;
        const plugin = rawPlugin;
        byScope.set(`${scope}\0${id}`, { id, scope, plugin });
      }
    }
    const merged: InstalledPlugin[] = [];
    for (const { id, scope, plugin } of byScope.values()) {
      const pathInspection = await inspectPluginInstallPath(
        scope,
        plugin.installPath,
        this.scopeRoots,
      );
      const diagnostics = pathInspection.diagnostic
        ? Object.freeze([...plugin.diagnostics, pathInspection.diagnostic])
        : plugin.diagnostics;
      merged.push({
        id,
        scope,
        manifest: { ...plugin.manifest },
        installPath: plugin.installPath,
        enabled: plugin.enabled,
        manifestSource: plugin.manifestSource,
        compatibility: pathInspection.valid ? plugin.compatibility : "blocked",
        diagnostics,
        resourceFingerprint: plugin.resourceFingerprint,
      });
    }
    return merged.sort(
      (a, b) => a.id.localeCompare(b.id) || scopeRank(a.scope) - scopeRank(b.scope),
    );
  }

  private async setEnabled(
    id: string,
    scope: PluginScope,
    enabled: boolean,
  ): Promise<PluginOperationResult> {
    const state = await this.readState(scope);
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
    await this.writeState(state, scope);
    return {
      success: true,
      message: `${enabled ? "Enabled" : "Disabled"} plugin ${id} in ${scope}.`,
      pluginId: id,
      pluginName: plugin.manifest.name,
      scope,
    };
  }

  private async readState(scope: PluginScope): Promise<PluginState> {
    const statePath = scope === "user" ? this.userStatePath : this.workspaceStatePath;
    let raw: string;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { plugins: {} };
      throw error;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.plugins)) {
        return { plugins: {} };
      }
      return { plugins: parsed.plugins as PluginState["plugins"] };
    } catch (error) {
      throw new Error(`Plugin state ${statePath} is invalid`, { cause: error });
    }
  }

  private async writeState(state: PluginState, scope: PluginScope): Promise<void> {
    await writeJsonAtomic(scope === "user" ? this.userStatePath : this.workspaceStatePath, state);
  }

  private async ensureManagedPluginRoot(options: {
    readonly sourceRoot: string;
    readonly destination: string;
    readonly scope: PluginScope;
    readonly pluginId: string;
    readonly expectedFingerprint: PluginResourceFingerprint;
    readonly current: StoredPlugin | undefined;
  }): Promise<string> {
    const { sourceRoot, destination, scope, pluginId, expectedFingerprint, current } = options;
    const source = resolve(sourceRoot);
    const managed = resolve(destination);
    if (!isPluginPathWithinScope(scope, managed, this.scopeRoots)) {
      throw new Error(
        `plugin_scope_root_violation: ${scope} install destination must remain inside ${scopeRoot(scope, this.scopeRoots)}`,
      );
    }
    const sourceReal = await realpath(source);
    // Re-registering an already managed directory is how inspect/trust observes an in-place
    // edit.  Do not reject it before the new fingerprint is written to the registry.
    if (sourceReal === managed) {
      return managed;
    }
    if (current && !sameFingerprint(current.resourceFingerprint, expectedFingerprint)) {
      throw new Error(
        `plugin_scope_conflict: ${pluginId} already has a different fingerprint in ${scope}; disable/remove it before replacing the managed copy`,
      );
    }

    await mkdir(scopeRoot(scope, this.scopeRoots), { recursive: true, mode: 0o700 });
    const existing = await lstat(managed).catch(() => undefined);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(
          `plugin_scope_destination_invalid: managed plugin destination is not a real directory: ${managed}`,
        );
      }
      const existingResolution = await resolvePluginContributions(managed);
      if (
        existingResolution.compatibility === "blocked" ||
        !existingResolution.fingerprint ||
        !sameFingerprint(existingResolution.fingerprint, expectedFingerprint)
      ) {
        throw new Error(
          `plugin_scope_conflict: managed destination ${managed} contains a different or invalid fingerprint`,
        );
      }
      return managed;
    }

    const stagingParent = await mkdtemp(join(scopeRoot(scope, this.scopeRoots), ".incoming-"));
    const staging = join(stagingParent, "plugin");
    let moved = false;
    try {
      await cp(sourceReal, staging, {
        recursive: true,
        dereference: true,
        filter: (entry) => !entry.split(/[\\/]/u).includes(".git"),
      });
      const staged = await resolvePluginContributions(staging);
      if (
        staged.plugin.id !== pluginId ||
        staged.compatibility === "blocked" ||
        !staged.fingerprint ||
        !sameFingerprint(staged.fingerprint, expectedFingerprint)
      ) {
        throw new Error(
          "plugin_scope_copy_verification_failed: copied plugin fingerprint mismatch",
        );
      }
      await rename(staging, managed);
      moved = true;
      return managed;
    } finally {
      if (!moved) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function scopeRank(scope: PluginScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

function sameFingerprint(
  left: PluginResourceFingerprint,
  right: PluginResourceFingerprint,
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.digest === right.digest &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginScope(value: string): value is PluginScope {
  return value === "user" || value === "project" || value === "local";
}

function isStoredPlugin(value: unknown): value is StoredPlugin {
  return (
    isRecord(value) &&
    typeof value.installPath === "string" &&
    isRecord(value.manifest) &&
    typeof value.enabled === "boolean" &&
    typeof value.manifestSource === "string" &&
    (value.compatibility === "compatible" ||
      value.compatibility === "degraded" ||
      value.compatibility === "blocked") &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isPluginDiagnostic) &&
    isRecord(value.resourceFingerprint) &&
    value.resourceFingerprint.algorithm === "sha256" &&
    typeof value.resourceFingerprint.digest === "string" &&
    typeof value.resourceFingerprint.fileCount === "number" &&
    typeof value.resourceFingerprint.totalBytes === "number"
  );
}

function isPluginDiagnostic(value: unknown): value is PluginDiagnostic {
  return (
    isRecord(value) &&
    (value.severity === "info" || value.severity === "warning" || value.severity === "error") &&
    (value.compatibility === "compatible" ||
      value.compatibility === "degraded" ||
      value.compatibility === "blocked") &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.component === undefined || typeof value.component === "string")
  );
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
