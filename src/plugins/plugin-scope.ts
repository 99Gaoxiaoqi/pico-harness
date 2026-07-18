import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolvePicoPaths, type ResolvePicoPathsOptions } from "../paths/pico-paths.js";
import type { PluginDiagnostic, PluginScope } from "./plugin-types.js";

/**
 * Scope priority is deliberately owned by one module.  Resource catalogs may use a different
 * numeric range for their own merge algorithm; this value only answers the plugin winner
 * question (`local > project > user`).
 */
export const PLUGIN_SCOPE_ORDER = Object.freeze([
  "user",
  "project",
  "local",
] as const satisfies readonly PluginScope[]);

export interface PluginScopeRoots {
  readonly user: string;
  readonly project: string;
  readonly local: string;
}

export interface PluginScopeRegistryDescriptor {
  readonly roots: PluginScopeRoots;
  /** User plugins are globally installed under PICO_HOME. */
  readonly userStatePath: string;
  /** Project/local entries are scoped to this workspace registry. */
  readonly workspaceStatePath: string;
  readonly workspacePath: string;
  readonly workspaceId: string;
}

export interface PluginScopePathInspection {
  readonly scope: PluginScope;
  readonly root: string;
  readonly path: string;
  readonly resolvedPath?: string;
  readonly valid: boolean;
  readonly diagnostic?: PluginDiagnostic;
}

/** Resolve the physical roots for all three plugin scopes. */
export function resolvePluginScopeRoots(
  workDir: string,
  options: ResolvePicoPathsOptions = {},
): PluginScopeRoots {
  const paths = resolvePicoPaths(workDir, options);
  return Object.freeze({
    user: paths.home.plugins,
    project: paths.project.plugins,
    // Local is intentionally outside .pico so it remains an explicit, workspace-local override.
    local: join(paths.canonicalWorkDir, ".claw", "plugins"),
  });
}

/** Describe which registry owns each scope; callers should not infer this from a path alone. */
export function describePluginScopeRegistry(
  workDir: string,
  options: ResolvePicoPathsOptions = {},
): PluginScopeRegistryDescriptor {
  const paths = resolvePicoPaths(workDir, options);
  return Object.freeze({
    roots: resolvePluginScopeRoots(workDir, options),
    userStatePath: join(paths.home.root, "plugins.json"),
    workspaceStatePath: paths.workspace.pluginState,
    workspacePath: paths.canonicalWorkDir,
    workspaceId: paths.workspace.id,
  });
}

/** Stable relative priority used for deterministic winner selection. */
export function pluginScopePriority(scope: PluginScope): number {
  return scope === "local" ? 3 : scope === "project" ? 2 : 1;
}

export function comparePluginScopes(left: PluginScope, right: PluginScope): number {
  return pluginScopePriority(left) - pluginScopePriority(right);
}

/** Return a deterministic managed directory name for a validated plugin id. */
export function pluginInstallDirectoryName(pluginId: string): string {
  const safe = pluginId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (safe === pluginId && safe.length > 0) return safe;
  const digest = createHash("sha256").update(pluginId).digest("hex").slice(0, 12);
  return `${safe || "plugin"}-${digest}`;
}

export function pluginInstallPath(
  scope: PluginScope,
  pluginId: string,
  roots: PluginScopeRoots,
): string {
  return join(scopeRoot(scope, roots), pluginInstallDirectoryName(pluginId));
}

export function scopeRoot(scope: PluginScope, roots: PluginScopeRoots): string {
  return roots[scope];
}

/**
 * Check both the lexical boundary and the real path boundary.  The latter rejects a managed
 * entry that is a symlink escaping its declared scope root.
 */
export async function inspectPluginInstallPath(
  scope: PluginScope,
  installPath: string,
  roots: PluginScopeRoots,
): Promise<PluginScopePathInspection> {
  const lexicalRoot = resolve(scopeRoot(scope, roots));
  const root = await realpath(lexicalRoot).catch(() => lexicalRoot);
  const path = resolve(installPath);
  if (!isWithin(lexicalRoot, path) && !isWithin(root, path)) {
    return scopeViolation(scope, root, path);
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch (error) {
    return {
      ...scopeViolation(scope, root, path),
      diagnostic: scopeDiagnostic(
        path,
        "plugin_scope_path_missing",
        `Plugin install path is missing: ${path}: ${errorMessage(error)}`,
      ),
    };
  }
  if (!isWithin(root, resolvedPath)) {
    return {
      ...scopeViolation(scope, root, path),
      resolvedPath,
      diagnostic: scopeDiagnostic(
        path,
        "plugin_scope_symlink_escape",
        `Plugin install path escapes its ${scope} scope root: ${path} -> ${resolvedPath}`,
      ),
    };
  }
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory()) {
    return {
      ...scopeViolation(scope, root, path),
      resolvedPath,
      diagnostic: scopeDiagnostic(
        path,
        "plugin_scope_path_not_directory",
        `Plugin install path is not a directory: ${path}`,
      ),
    };
  }
  return Object.freeze({ scope, root, path, resolvedPath, valid: true });
}

/** Fast lexical check used before creating a managed destination. */
export function isPluginPathWithinScope(
  scope: PluginScope,
  path: string,
  roots: PluginScopeRoots,
): boolean {
  return isWithin(resolve(scopeRoot(scope, roots)), resolve(path));
}

/** Choose one enabled winner per plugin id with stable id ordering. */
export function selectPluginScopeWinners<
  T extends { readonly id: string; readonly scope: PluginScope },
>(plugins: readonly T[]): readonly T[] {
  const winners = new Map<string, T>();
  for (const plugin of plugins) {
    const current = winners.get(plugin.id);
    if (!current || comparePluginScopes(plugin.scope, current.scope) > 0) {
      winners.set(plugin.id, plugin);
    }
  }
  return [...winners.values()].sort(
    (left, right) =>
      left.id.localeCompare(right.id) || comparePluginScopes(left.scope, right.scope),
  );
}

function scopeViolation(scope: PluginScope, root: string, path: string): PluginScopePathInspection {
  return Object.freeze({
    scope,
    root,
    path,
    valid: false,
    diagnostic: scopeDiagnostic(
      path,
      "plugin_scope_root_violation",
      `Plugin install path must remain inside the ${scope} scope root ${root}: ${path}`,
    ),
  });
}

function scopeDiagnostic(path: string, code: string, message: string): PluginDiagnostic {
  return Object.freeze({
    severity: "error",
    compatibility: "blocked",
    code,
    message,
    path,
    component: "resources",
  });
}

function isWithin(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
