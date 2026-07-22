import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { WorkspaceTrustStore } from "../security/workspace-trust.js";
import { resolveProjectMcpConfigPath } from "./config-path.js";
import { parseMcpConfig } from "./config-parser.js";
import type { McpConfigSource } from "./manager.js";
import type { McpConfig, McpServerConfig } from "./types.js";
import {
  EMPTY_USER_MCP_REVISION,
  UserMcpConfigStore,
  type UserMcpConfigSnapshot,
} from "./user-config-store.js";

export type EffectiveMcpDefinitionScope = "user" | "project";

export interface EffectiveMcpServerDefinition {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly scope: EffectiveMcpDefinitionScope;
  readonly sourceId: "user" | "project" | "project-legacy";
  readonly sourceLabel: string;
  readonly readOnly: boolean;
  readonly effective: boolean;
  readonly shadowedBy?: "project";
}

export interface EffectiveMcpSourceResolution {
  readonly workspacePath: string;
  /** Collision-free inputs for McpConnectionManager. Plugin sources may be appended by the host. */
  readonly sources: readonly McpConfigSource[];
  /** Includes shadowed user definitions for management diagnostics. */
  readonly definitions: readonly EffectiveMcpServerDefinition[];
  readonly revisions: { readonly user: string; readonly project: string };
}

export interface EffectiveMcpSourceOptions {
  readonly picoHome: string;
  readonly trustStore: Pick<WorkspaceTrustStore, "canonicalize" | "isTrusted">;
  readonly userStore?: UserMcpConfigStore;
}

export class McpWorkspaceNotTrustedError extends Error {
  readonly code = "MCP_WORKSPACE_NOT_TRUSTED" as const;

  constructor(readonly workspacePath: string) {
    super(`工作区尚未信任，不会读取项目 MCP 配置: ${workspacePath}`);
    this.name = "McpWorkspaceNotTrustedError";
  }
}

/** Resolve user + project definitions without spawning or connecting an MCP client. */
export async function resolveTrustedEffectiveMcpSources(
  workspacePath: string,
  options: EffectiveMcpSourceOptions,
): Promise<EffectiveMcpSourceResolution> {
  const canonical = await options.trustStore.canonicalize(workspacePath);
  if (!(await options.trustStore.isTrusted(canonical))) {
    throw new McpWorkspaceNotTrustedError(canonical);
  }

  const userStore = options.userStore ?? new UserMcpConfigStore({ picoHome: options.picoHome });
  const [user, project] = await Promise.all([userStore.read(), readProjectConfig(canonical)]);
  const projectNames = new Set(Object.keys(project.config.mcpServers));
  const effectiveUserServers = Object.fromEntries(
    Object.entries(user.config.mcpServers).filter(([name]) => !projectNames.has(name)),
  );
  const sources: McpConfigSource[] = [];
  if (Object.keys(effectiveUserServers).length > 0) {
    sources.push({ id: "user", config: { mcpServers: effectiveUserServers } });
  }
  if (Object.keys(project.config.mcpServers).length > 0) {
    sources.push({ id: project.sourceId, config: project.config });
  }

  const definitions: EffectiveMcpServerDefinition[] = [
    ...Object.entries(user.config.mcpServers).map(([name, config]) => ({
      name,
      config,
      scope: "user" as const,
      sourceId: "user" as const,
      sourceLabel: "用户级",
      readOnly: false,
      effective: !projectNames.has(name),
      ...(projectNames.has(name) ? { shadowedBy: "project" as const } : {}),
    })),
    ...Object.entries(project.config.mcpServers).map(([name, config]) => ({
      name,
      config,
      scope: "project" as const,
      sourceId: project.sourceId,
      sourceLabel: project.sourceId === "project" ? "项目级" : "项目级（旧版兼容）",
      readOnly: project.sourceId === "project-legacy",
      effective: true,
    })),
  ].sort(
    (left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope),
  );

  return {
    workspacePath: canonical,
    sources,
    definitions,
    revisions: { user: user.revision, project: project.revision },
  };
}

async function readProjectConfig(workspacePath: string): Promise<{
  readonly config: McpConfig;
  readonly revision: string;
  readonly sourceId: "project" | "project-legacy";
}> {
  const resolution = await resolveProjectMcpConfigPath(workspacePath);
  if (!resolution.exists) {
    return {
      config: { mcpServers: {} },
      revision: EMPTY_USER_MCP_REVISION,
      sourceId: "project",
    };
  }
  const raw = await readFile(resolution.path, "utf8");
  return {
    config: parseMcpConfig(JSON.parse(raw) as unknown, resolution.path),
    revision: createHash("sha256").update(raw).digest("hex"),
    sourceId: resolution.source === "pico" ? "project" : "project-legacy",
  };
}

/** Pure helper used by host adapters that only need the user-level catalog. */
export function userMcpDefinitions(
  snapshot: UserMcpConfigSnapshot,
): readonly EffectiveMcpServerDefinition[] {
  return Object.entries(snapshot.config.mcpServers)
    .map(([name, config]) => ({
      name,
      config,
      scope: "user" as const,
      sourceId: "user" as const,
      sourceLabel: "用户级",
      readOnly: false,
      effective: true,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Apply the same host-first precedence used by the management catalog before Runtime connects.
 * Plugin sources are data-only snapshots, so filtering never reads files or starts a client.
 */
export function filterPluginMcpSources(
  sources: readonly McpConfigSource[],
  occupiedServerNames: ReadonlySet<string>,
): readonly McpConfigSource[] {
  const occupied = new Set(occupiedServerNames);
  return sources.flatMap((source) => {
    if (!source.config) return [source];
    const mcpServers = Object.fromEntries(
      Object.entries(source.config.mcpServers).filter(([name]) => {
        if (occupied.has(name)) return false;
        occupied.add(name);
        return true;
      }),
    );
    return Object.keys(mcpServers).length > 0
      ? [{ ...source, config: { mcpServers } } satisfies McpConfigSource]
      : [];
  });
}

export function configuredMcpServerNames(sources: readonly McpConfigSource[]): ReadonlySet<string> {
  return new Set(sources.flatMap((source) => Object.keys(source.config?.mcpServers ?? {})));
}
