import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  listDesktopAgents,
  listDesktopEffectiveSkills,
  listDesktopMcpServers,
  listDesktopSkills,
  listDesktopUserSkills,
} from "./desktop-resource-catalog.js";
import type { DesktopRequestHandlers } from "./desktop-request-router.js";
import {
  isJsonValue,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonValue,
  type RuntimeMcpServerInput,
  type RuntimeScopedMcpServer,
} from "./protocol.js";
import type { PluginRuntimeSnapshotRegistry } from "../plugins/plugin-runtime-snapshot-registry.js";
import type { WorkspaceTrustStore } from "../security/workspace-trust.js";
import type { McpServerConfig } from "../mcp/types.js";
import {
  resolveTrustedEffectiveMcpSources,
  userMcpDefinitions,
  type EffectiveMcpServerDefinition,
} from "../mcp/effective-config.js";
import {
  UserMcpConfigStore,
  UserMcpIdempotencyConflictError,
  UserMcpRevisionConflictError,
} from "../mcp/user-config-store.js";

type Capability = "skills" | "mcp";
type CapabilityScope = "user" | "project";

/** Dependencies retained by the Desktop composition root. */
export interface DesktopCatalogRequestContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly picoHome: string;
  readonly pluginRuntimeSnapshotRegistry: PluginRuntimeSnapshotRegistry;
  readonly trustStore: WorkspaceTrustStore;
  readonly userMcpConfigStore: UserMcpConfigStore;
  readonly requireTrustedWorkspace: (workspacePath: string) => Promise<string>;
  readonly projectCapabilityRevision: (
    capability: Capability,
    scope: CapabilityScope,
    revision: string,
    workspacePath?: string,
  ) => string;
  readonly publishCapabilityConfigUpdated: (
    capability: Capability,
    revision: string,
  ) => Promise<void>;
}

/** Build the catalog and scoped capability-config request boundary. */
export function createDesktopCatalogRequestHandlers(
  context: DesktopCatalogRequestContext,
): Pick<
  DesktopRequestHandlers,
  | "catalog.agents"
  | "catalog.skills"
  | "config.skills"
  | "skills.user.list"
  | "skills.effective.list"
  | "config.mcpServers"
  | "mcp.user.list"
  | "mcp.user.upsert"
  | "mcp.user.delete"
  | "mcp.user.setEnabled"
  | "mcp.effective.list"
> {
  const listAgents = async (workspacePath: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const pluginSnapshot = await context.pluginRuntimeSnapshotRegistry.get(canonical);
    const agents = await listDesktopAgents(canonical, {
      env: context.env,
      picoHome: context.picoHome,
      pluginSnapshot,
    });
    return { agents: toJsonValue(agents) };
  };

  const listSkills = async (
    workspacePath: string,
    includeUserResources: boolean,
  ): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const pluginSnapshot = await context.pluginRuntimeSnapshotRegistry.get(canonical);
    const skills = await listDesktopSkills(canonical, includeUserResources, {
      env: context.env,
      picoHome: context.picoHome,
      pluginSnapshot,
    });
    return { skills: toJsonValue(skills) };
  };

  const listUserSkills = async (): Promise<JsonValue> => {
    const catalog = await listDesktopUserSkills({
      env: context.env,
      picoHome: context.picoHome,
    });
    return toJsonValue({
      ...catalog,
      revision: context.projectCapabilityRevision("skills", "user", catalog.revision),
    });
  };

  const listEffectiveSkills = async (workspacePath: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const pluginSnapshot = await context.pluginRuntimeSnapshotRegistry.get(canonical);
    const catalog = await listDesktopEffectiveSkills(canonical, {
      env: context.env,
      picoHome: context.picoHome,
      pluginSnapshot,
    });
    return toJsonValue({
      ...catalog,
      revisions: {
        user: context.projectCapabilityRevision("skills", "user", catalog.revisions.user),
        project: context.projectCapabilityRevision(
          "skills",
          "project",
          catalog.revisions.project,
          canonical,
        ),
      },
    });
  };

  const listUserMcpServers = async (): Promise<JsonValue> => {
    const snapshot = await context.userMcpConfigStore.read();
    return toJsonValue({
      servers: userMcpDefinitions(snapshot).map(projectPublicMcpServer),
      revision: context.projectCapabilityRevision("mcp", "user", snapshot.revision),
    });
  };

  const upsertUserMcpServer = async (params: {
    readonly server: RuntimeMcpServerInput;
    readonly expectedRevision: string;
    readonly idempotencyKey: string;
  }): Promise<JsonValue> => {
    const current = await context.userMcpConfigStore.read();
    const publicCurrent = context.projectCapabilityRevision("mcp", "user", current.revision);
    const expectedRevision =
      params.expectedRevision === publicCurrent ? current.revision : params.expectedRevision;
    try {
      const config = toCoreMcpServer(params.server);
      const result = await context.userMcpConfigStore.upsert(config, {
        expectedRevision,
        idempotencyKey: params.idempotencyKey,
      });
      const definition: EffectiveMcpServerDefinition = {
        name: config.name,
        config,
        scope: "user",
        sourceId: "user",
        sourceLabel: "用户级",
        readOnly: false,
        effective: true,
      };
      const revision = context.projectCapabilityRevision("mcp", "user", result.resultRevision);
      if (!result.replayed) await context.publishCapabilityConfigUpdated("mcp", revision);
      return toJsonValue({ server: projectPublicMcpServer(definition), revision });
    } catch (error) {
      throw publicMcpMutationError(error);
    }
  };

  const deleteUserMcpServer = async (params: {
    readonly serverName: string;
    readonly expectedRevision: string;
    readonly idempotencyKey: string;
  }): Promise<JsonValue> => {
    const current = await context.userMcpConfigStore.read();
    const publicCurrent = context.projectCapabilityRevision("mcp", "user", current.revision);
    const expectedRevision =
      params.expectedRevision === publicCurrent ? current.revision : params.expectedRevision;
    try {
      const result = await context.userMcpConfigStore.delete(params.serverName, {
        expectedRevision,
        idempotencyKey: params.idempotencyKey,
      });
      const revision = context.projectCapabilityRevision("mcp", "user", result.resultRevision);
      if (!result.replayed) await context.publishCapabilityConfigUpdated("mcp", revision);
      return { serverName: params.serverName, deleted: true, revision };
    } catch (error) {
      throw publicMcpMutationError(error);
    }
  };

  const setUserMcpServerEnabled = async (params: {
    readonly serverName: string;
    readonly enabled: boolean;
    readonly expectedRevision: string;
    readonly idempotencyKey: string;
  }): Promise<JsonValue> => {
    const current = await context.userMcpConfigStore.read();
    const definition = userMcpDefinitions(current).find(
      (entry) => entry.name === params.serverName,
    );
    if (!definition) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `用户级 MCP 服务器不存在: ${params.serverName}`,
      );
    }
    const publicCurrent = context.projectCapabilityRevision("mcp", "user", current.revision);
    const expectedRevision =
      params.expectedRevision === publicCurrent ? current.revision : params.expectedRevision;
    try {
      const result = await context.userMcpConfigStore.upsert(
        { ...definition.config, enabled: params.enabled },
        { expectedRevision, idempotencyKey: params.idempotencyKey },
      );
      const revision = context.projectCapabilityRevision("mcp", "user", result.resultRevision);
      if (!result.replayed) await context.publishCapabilityConfigUpdated("mcp", revision);
      return toJsonValue({
        server: projectPublicMcpServer({
          ...definition,
          config: result.snapshot.config.mcpServers[params.serverName] ?? definition.config,
        }),
        revision,
      });
    } catch (error) {
      throw publicMcpMutationError(error);
    }
  };

  const listEffectiveMcpServers = async (workspacePath: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const [resolution, pluginSnapshot] = await Promise.all([
      resolveTrustedEffectiveMcpSources(canonical, {
        picoHome: context.picoHome,
        trustStore: context.trustStore,
        userStore: context.userMcpConfigStore,
      }),
      context.pluginRuntimeSnapshotRegistry.get(canonical),
    ]);
    const occupied = new Map<string, "user" | "project" | "plugin">(
      resolution.definitions
        .filter((definition) => definition.effective)
        .map((definition) => [definition.name, definition.scope] as const),
    );
    const pluginDefinitions = pluginSnapshot.mcpSources.flatMap((source) =>
      Object.entries(source.config?.mcpServers ?? {}).map(([name, config]) => {
        const shadowedBy = occupied.get(name);
        if (!shadowedBy) occupied.set(name, "plugin");
        return {
          name,
          config,
          scope: "plugin" as const,
          sourceId: source.id,
          sourceLabel: pluginMcpSourceLabel(source.id),
          readOnly: true,
          effective: shadowedBy === undefined,
          ...(shadowedBy ? { shadowedBy } : {}),
        };
      }),
    );
    const pluginRevision = createHash("sha256")
      .update(JSON.stringify(pluginSnapshot.mcpSources), "utf8")
      .digest("hex");
    return toJsonValue({
      servers: [...resolution.definitions, ...pluginDefinitions]
        .map(projectPublicMcpServer)
        .sort((left, right) => left.name.localeCompare(right.name)),
      revisions: {
        user: context.projectCapabilityRevision("mcp", "user", resolution.revisions.user),
        project: context.projectCapabilityRevision(
          "mcp",
          "project",
          `${resolution.revisions.project}:${pluginRevision}`,
          canonical,
        ),
      },
    });
  };

  const listMcpServers = async (workspacePath: string): Promise<JsonValue> => {
    const canonical = await context.requireTrustedWorkspace(workspacePath);
    const pluginSnapshot = await context.pluginRuntimeSnapshotRegistry.get(canonical);
    return {
      servers: toJsonValue(
        await listDesktopMcpServers(canonical, {
          env: context.env,
          picoHome: context.picoHome,
          pluginSnapshot,
        }),
      ),
    };
  };

  return {
    "catalog.agents": (request) => listAgents(request.params.workspacePath),
    "catalog.skills": (request) => listSkills(request.params.workspacePath, true),
    "config.skills": (request) => listSkills(request.params.workspacePath, false),
    "skills.user.list": () => listUserSkills(),
    "skills.effective.list": (request) => listEffectiveSkills(request.params.workspacePath),
    "config.mcpServers": (request) => listMcpServers(request.params.workspacePath),
    "mcp.user.list": () => listUserMcpServers(),
    "mcp.user.upsert": (request) => upsertUserMcpServer(request.params),
    "mcp.user.delete": (request) => deleteUserMcpServer(request.params),
    "mcp.user.setEnabled": (request) => setUserMcpServerEnabled(request.params),
    "mcp.effective.list": (request) => listEffectiveMcpServers(request.params.workspacePath),
  };
}

type PublicMcpDefinition = Omit<
  EffectiveMcpServerDefinition,
  "scope" | "sourceId" | "shadowedBy"
> & {
  readonly scope: "user" | "project" | "plugin";
  readonly sourceId: string;
  readonly shadowedBy?: string;
};

/** Project MCP metadata without exposing credentials, arguments, or full local paths. */
function projectPublicMcpServer(definition: PublicMcpDefinition): RuntimeScopedMcpServer {
  const common = {
    name: definition.name,
    ...(definition.config.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: definition.config.startupTimeoutMs }),
    ...(definition.config.toolTimeoutMs === undefined
      ? {}
      : { toolTimeoutMs: definition.config.toolTimeoutMs }),
    ...(definition.config.enabled === undefined ? {} : { enabled: definition.config.enabled }),
    source: {
      scope: definition.scope,
      sourceId: definition.sourceId,
      sourceLabel: definition.sourceLabel,
      readOnly: definition.readOnly,
      effective: definition.effective,
      ...(definition.shadowedBy ? { shadowedBy: definition.shadowedBy } : {}),
    },
  };
  if (definition.config.transport === "stdio") {
    return {
      ...common,
      transport: "stdio",
      commandLabel: safeMcpCommandLabel(definition.config.command),
      hasArguments: (definition.config.args?.length ?? 0) > 0,
      ...(definition.config.env && Object.keys(definition.config.env).length > 0
        ? { envKeys: Object.keys(definition.config.env).sort() }
        : {}),
    };
  }
  return {
    ...common,
    transport: definition.config.transport,
    endpointLabel: safeMcpEndpointLabel(definition.config.url),
    ...(definition.config.headers && Object.keys(definition.config.headers).length > 0
      ? { headerKeys: Object.keys(definition.config.headers).sort() }
      : {}),
  };
}

function safeMcpCommandLabel(command: string | undefined): string {
  const label = basename(command ?? "").trim();
  return /^[a-z0-9._+-]+$/iu.test(label) ? label : "configured-command";
}

function safeMcpEndpointLabel(rawUrl: string | undefined): string {
  if (!rawUrl) return "https://invalid.invalid";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "https://invalid.invalid";
    }
    return parsed.origin;
  } catch {
    return "https://invalid.invalid";
  }
}

function toCoreMcpServer(server: RuntimeMcpServerInput): McpServerConfig {
  const common = {
    name: server.name,
    transport: server.transport,
    ...(server.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: server.startupTimeoutMs }),
    ...(server.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: server.toolTimeoutMs }),
    ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
  };
  if (server.transport === "stdio") {
    return {
      ...common,
      command: server.command,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(server.env ? { env: { ...server.env } } : {}),
    };
  }
  return {
    ...common,
    url: server.url,
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

function publicMcpMutationError(error: unknown): Error {
  if (error instanceof UserMcpRevisionConflictError) {
    return new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "用户 MCP 配置已更改，请刷新后重试",
    );
  }
  if (error instanceof UserMcpIdempotencyConflictError) {
    return new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "MCP 幂等键已用于不同请求");
  }
  return error instanceof Error
    ? error
    : new RuntimeProtocolError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, "用户 MCP 配置更新失败");
}

function pluginMcpSourceLabel(sourceId: string): string {
  const pluginId = sourceId.match(/^plugin:([^:]+)/)?.[1] ?? sourceId;
  return `Plugin · ${pluginId}`;
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Value cannot be represented as JSON");
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonValue(parsed)) throw new Error("Value cannot be represented as Runtime JSON");
  return parsed;
}
