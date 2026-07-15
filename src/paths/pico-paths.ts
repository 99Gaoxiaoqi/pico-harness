import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";

declare const workspaceIdBrand: unique symbol;

export type WorkspaceId = string & { readonly [workspaceIdBrand]: true };

export interface PicoProjectPaths {
  readonly root: string;
  readonly config: string;
  readonly commands: string;
  readonly skills: string;
  readonly agents: string;
  readonly hooks: string;
  readonly mcp: string;
  readonly plugins: string;
}

export interface PicoHomePaths {
  readonly root: string;
  readonly commands: string;
  readonly skills: string;
  readonly agents: string;
  readonly hooks: string;
  readonly plugins: string;
  readonly pluginData: string;
  readonly workspaces: string;
  readonly trustedWorkspaces: string;
  readonly trustedHooks: string;
  readonly fileHistory: string;
  readonly daemonWorkspaces: string;
}

export interface PicoWorkspacePaths {
  readonly id: WorkspaceId;
  readonly root: string;
  readonly runtimeDatabase: string;
  readonly memory: string;
  readonly summaries: string;
  readonly artifacts: string;
  /** Immutable raw tool exchanges removed from Session history by full compaction. */
  readonly evidence: string;
  readonly traces: string;
  readonly tasks: string;
  readonly forkStaging: string;
  readonly storageOperations: string;
  readonly todo: string;
  readonly pluginState: string;
  readonly hookState: string;
  readonly debugLog: string;
}

export interface PicoPaths {
  readonly canonicalWorkDir: string;
  readonly project: PicoProjectPaths;
  readonly home: PicoHomePaths;
  readonly workspace: PicoWorkspacePaths;
}

export interface ResolvePicoPathsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly picoHome?: string;
}

export function resolvePicoHome(options: ResolvePicoPathsOptions = {}): string {
  const configured = options.picoHome ?? (options.env ?? process.env)["PICO_HOME"];
  return resolve(configured?.trim() || join(options.homeDir ?? homedir(), ".pico"));
}

export function canonicalizeWorkspacePath(workDir: string): string {
  const absolute = resolve(workDir);
  let physical = absolute;
  try {
    physical = realpathSync.native(absolute);
  } catch {
    // Callers may prepare paths before creating a fixture. The absolute path remains stable.
  }
  const normalized = normalize(physical);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function workspaceIdForPath(workDir: string): WorkspaceId {
  const canonical = canonicalizeWorkspacePath(workDir);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  const label = basename(canonical)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return `${label || "workspace"}-${hash}` as WorkspaceId;
}

export function resolvePicoPaths(
  workDir: string,
  options: ResolvePicoPathsOptions = {},
): PicoPaths {
  const canonicalWorkDir = canonicalizeWorkspacePath(workDir);
  const picoHome = resolvePicoHome(options);
  const workspaceId = workspaceIdForPath(canonicalWorkDir);
  const projectRoot = join(canonicalWorkDir, ".pico");
  const workspaceRoot = join(picoHome, "workspaces", workspaceId);

  return {
    canonicalWorkDir,
    project: {
      root: projectRoot,
      config: join(projectRoot, "config.json"),
      commands: join(projectRoot, "commands"),
      skills: join(projectRoot, "skills"),
      agents: join(projectRoot, "agents.yaml"),
      hooks: join(projectRoot, "hooks.json"),
      mcp: join(projectRoot, "mcp.json"),
      plugins: join(projectRoot, "plugins"),
    },
    home: {
      root: picoHome,
      commands: join(picoHome, "commands"),
      skills: join(picoHome, "skills"),
      agents: join(picoHome, "agents.yaml"),
      hooks: join(picoHome, "hooks.json"),
      plugins: join(picoHome, "plugins"),
      pluginData: join(picoHome, "plugin-data"),
      workspaces: join(picoHome, "workspaces"),
      trustedWorkspaces: join(picoHome, "trusted-workspaces.json"),
      trustedHooks: join(picoHome, "trusted-hooks.json"),
      fileHistory: join(picoHome, "file-history"),
      daemonWorkspaces: join(picoHome, "daemon-workspaces.json"),
    },
    workspace: {
      id: workspaceId,
      root: workspaceRoot,
      runtimeDatabase: join(workspaceRoot, "runtime.sqlite"),
      memory: join(workspaceRoot, "memory"),
      summaries: join(workspaceRoot, "memory", "summaries"),
      artifacts: join(workspaceRoot, "artifacts"),
      evidence: join(workspaceRoot, "evidence"),
      traces: join(workspaceRoot, "traces"),
      tasks: join(workspaceRoot, "tasks"),
      forkStaging: join(workspaceRoot, "fork-staging"),
      storageOperations: join(workspaceRoot, "storage-operations"),
      todo: join(workspaceRoot, "todo.json"),
      pluginState: join(workspaceRoot, "plugins.json"),
      hookState: join(workspaceRoot, "hooks-state.json"),
      debugLog: join(workspaceRoot, "tui-debug.log"),
    },
  };
}
