// Agent, skill, MCP, and plugin capability contracts with their parameter/result rules.
import { isJsonObject } from "./base.js";
import type { EmptyParams, JsonObject, WorkspaceParams } from "./base.js";
import { invalidParams, invalidResult } from "./errors.js";
import {
  assertNestedShape,
  booleanParam,
  boundedNonEmptyStringParam,
  exactParamShape,
  exactResultShape,
  noParams,
  oneOfParam,
  positiveIntegerParam,
  resultArray,
  resultBoolean,
  resultJsonObject,
  resultOneOf,
  resultPositiveInteger,
  resultShape,
  resultString,
  resultStringArray,
  stringArrayParam,
  stringParam,
  stringRecordParam,
  workspaceParams,
} from "./validation.js";
import type { RuntimeParamRule, RuntimeParamValidator, RuntimeResultRule } from "./validation.js";

export type RuntimeCatalogAgent = JsonObject & {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly tools: readonly string[];
  readonly modelRouteId?: string;
};

export type RuntimeCatalogSkill = JsonObject & {
  readonly name: string;
  readonly description: string;
  readonly sourcePath?: string;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
};

export type RuntimeCapabilityScope = "user" | "project" | "plugin";

/** Opaque provenance safe to expose to the sandboxed Renderer. */
export type RuntimeCapabilitySourceMetadata = JsonObject & {
  readonly scope: RuntimeCapabilityScope;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly readOnly: boolean;
  readonly effective: boolean;
  readonly shadowedBy?: string;
};

export type RuntimeScopedSkill = JsonObject & {
  readonly name: string;
  readonly description: string;
  readonly source: RuntimeCapabilitySourceMetadata;
  readonly allowedTools?: readonly string[];
  readonly model?: string;
};

type RuntimeMcpServerCommon = JsonObject & {
  readonly name: string;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabled?: boolean;
};

export type RuntimeMcpServerInput =
  | (RuntimeMcpServerCommon & {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    })
  | (RuntimeMcpServerCommon & {
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    });

type RuntimeScopedMcpServerCommon = JsonObject & {
  readonly name: string;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabled?: boolean;
  readonly source: RuntimeCapabilitySourceMetadata;
};

/** Sanitized MCP projection: secret values are represented only by their key names. */
export type RuntimeScopedMcpServer =
  | (RuntimeScopedMcpServerCommon & {
      readonly transport: "stdio";
      /** Executable basename only; absolute/relative paths never cross the Renderer boundary. */
      readonly commandLabel: string;
      readonly hasArguments: boolean;
      readonly envKeys?: readonly string[];
    })
  | (RuntimeScopedMcpServerCommon & {
      readonly transport: "http" | "sse";
      /** URL origin only; paths can carry credentials and never cross the Renderer boundary. */
      readonly endpointLabel: string;
      readonly headerKeys?: readonly string[];
    });

export type RuntimeCapabilityRevisions = JsonObject & {
  readonly user: string;
  readonly project: string;
};

export type RuntimePluginDiagnostic = {
  readonly pluginId: string;
  readonly sourcePath: string;
  readonly message: string;
  readonly code?: string;
  readonly scope?: "user" | "project" | "local";
  readonly severity?: "error" | "warning" | "info";
  readonly compatibility?: "compatible" | "degraded" | "blocked";
};

const runtimeMcpServerParam: RuntimeParamRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidParams(`${path} 必须是 MCP server 对象`);
  const common = {
    startupTimeoutMs: positiveIntegerParam,
    toolTimeoutMs: positiveIntegerParam,
    enabled: booleanParam,
  } as const;
  if (value["transport"] === "stdio") {
    assertNestedShape(
      value,
      path,
      {
        name: boundedNonEmptyStringParam(256),
        transport: oneOfParam(["stdio"]),
        command: boundedNonEmptyStringParam(4_096),
      },
      { ...common, args: stringArrayParam, env: stringRecordParam },
    );
    return;
  }
  assertNestedShape(
    value,
    path,
    {
      name: boundedNonEmptyStringParam(256),
      transport: oneOfParam(["http", "sse"]),
      url: boundedNonEmptyStringParam(8_192),
    },
    { ...common, headers: stringRecordParam },
  );
};

const capabilitySourceMetadataResult = exactResultShape(
  {
    scope: resultOneOf(["user", "project", "plugin"]),
    sourceId: resultString,
    sourceLabel: resultString,
    readOnly: resultBoolean,
    effective: resultBoolean,
  },
  { shadowedBy: resultString },
);

const runtimeScopedSkillResult = exactResultShape(
  {
    name: resultString,
    description: resultString,
    source: capabilitySourceMetadataResult,
  },
  { allowedTools: resultStringArray, model: resultString },
);

const runtimeCapabilityRevisionsResult = exactResultShape({
  user: resultString,
  project: resultString,
});

const runtimeScopedMcpServerResult: RuntimeResultRule = (value, path) => {
  if (!isJsonObject(value)) throw invalidResult(`${path} 必须是 MCP server 对象`);
  const common = {
    startupTimeoutMs: resultPositiveInteger,
    toolTimeoutMs: resultPositiveInteger,
    enabled: resultBoolean,
  } as const;
  if (value["transport"] === "stdio") {
    exactResultShape(
      {
        name: resultString,
        transport: resultOneOf(["stdio"]),
        commandLabel: resultCommandLabel,
        hasArguments: resultBoolean,
        source: capabilitySourceMetadataResult,
      },
      { ...common, envKeys: resultStringArray },
    )(value, path);
    return;
  }
  exactResultShape(
    {
      name: resultString,
      transport: resultOneOf(["http", "sse"]),
      endpointLabel: resultEndpointLabel,
      source: capabilitySourceMetadataResult,
    },
    { ...common, headerKeys: resultStringArray },
  )(value, path);
};

const resultCommandLabel: RuntimeResultRule = (value, path) => {
  resultString(value, path);
  const label = value as string;
  if (!label || label === "." || label === ".." || /[\\/]/u.test(label)) {
    throw invalidResult(`${path} 必须是不含路径的可执行文件名`);
  }
};

const resultEndpointLabel: RuntimeResultRule = (value, path) => {
  resultString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    throw invalidResult(`${path} 必须是安全的 HTTP(S) endpoint 摘要`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    throw invalidResult(`${path} 只能包含 HTTP(S) origin`);
  }
};

export const runtimePluginDiagnosticResult = exactResultShape(
  {
    pluginId: resultString,
    sourcePath: resultString,
    message: resultString,
  },
  {
    code: resultString,
    scope: resultOneOf(["user", "project", "local"]),
    severity: resultOneOf(["error", "warning", "info"]),
    compatibility: resultOneOf(["compatible", "degraded", "blocked"]),
  },
);

const runtimeCatalogAgentResult = resultShape(
  {
    name: resultString,
    description: resultString,
    source: resultString,
    sourcePath: resultString,
    tools: resultStringArray,
  },
  { modelRouteId: resultString },
);

const runtimeCatalogSkillResult = resultShape(
  { name: resultString, description: resultString },
  { sourcePath: resultString, allowedTools: resultStringArray, model: resultString },
);

export type CapabilitiesMethodMap = {
  readonly "catalog.agents": {
    readonly params: WorkspaceParams;
    readonly result: { readonly agents: readonly RuntimeCatalogAgent[] };
  };
  readonly "catalog.skills": {
    readonly params: WorkspaceParams;
    readonly result: { readonly skills: readonly RuntimeCatalogSkill[] };
  };
  readonly "config.skills": {
    readonly params: WorkspaceParams;
    readonly result: { readonly skills: readonly JsonObject[] };
  };
  readonly "config.mcpServers": {
    readonly params: WorkspaceParams;
    readonly result: { readonly servers: readonly JsonObject[] };
  };
  readonly "skills.user.list": {
    readonly params: EmptyParams;
    readonly result: { readonly skills: readonly RuntimeScopedSkill[]; readonly revision: string };
  };
  readonly "skills.effective.list": {
    readonly params: WorkspaceParams;
    readonly result: {
      readonly skills: readonly RuntimeScopedSkill[];
      readonly revisions: RuntimeCapabilityRevisions;
    };
  };
  readonly "mcp.user.list": {
    readonly params: EmptyParams;
    readonly result: {
      readonly servers: readonly RuntimeScopedMcpServer[];
      readonly revision: string;
    };
  };
  readonly "mcp.user.upsert": {
    readonly params: {
      readonly server: RuntimeMcpServerInput;
      readonly expectedRevision: string;
      readonly idempotencyKey: string;
    };
    readonly result: { readonly server: RuntimeScopedMcpServer; readonly revision: string };
  };
  readonly "mcp.user.delete": {
    readonly params: {
      readonly serverName: string;
      readonly expectedRevision: string;
      readonly idempotencyKey: string;
    };
    readonly result: {
      readonly serverName: string;
      readonly deleted: true;
      readonly revision: string;
    };
  };
  /** 用户级 MCP 服务器启用开关（3-D BLOCKED 收口：/mcp enable/disable 镜像）。 */
  readonly "mcp.user.setEnabled": {
    readonly params: {
      readonly serverName: string;
      readonly enabled: boolean;
      readonly expectedRevision: string;
      readonly idempotencyKey: string;
    };
    readonly result: {
      readonly server: RuntimeScopedMcpServer;
      readonly revision: string;
    };
  };
  /** Hook 管理面（3-D BLOCKED 收口：/hooks 镜像——list/review/trust/enable/disable/reload）。 */
  readonly "hooks.manage": {
    readonly params: WorkspaceParams & {
      readonly action: "list" | "review" | "trust" | "enable" | "disable" | "reload";
      readonly handlerId?: string;
    };
    readonly result: { readonly result: JsonObject };
  };
  /** 存储操作处置面（3-D BLOCKED 收口：/operations 镜像——list/show/retry/abort）。 */
  readonly "operations.manage": {
    readonly params: WorkspaceParams & {
      readonly action: "list" | "show" | "retry" | "abort";
      readonly operationId?: string;
      readonly expectedVersion?: number;
      readonly reason?: string;
    };
    readonly result: { readonly result: JsonObject };
  };
  /** 插件管理面（BLOCKED 收口：/plugin 镜像——list/inspect/install/trust 两阶段/enable/disable）。 */
  readonly "plugin.manage": {
    readonly params: WorkspaceParams & {
      readonly action:
        | "list"
        | "inspect"
        | "install"
        | "trust.prepare"
        | "trust.confirm"
        | "enable"
        | "disable";
      readonly id?: string;
      readonly scope?: "user" | "project" | "local";
      readonly path?: string;
      readonly confirmId?: string;
      readonly fingerprint?: string;
    };
    readonly result: { readonly result: JsonObject };
  };
  readonly "mcp.effective.list": {
    readonly params: WorkspaceParams;
    readonly result: {
      readonly servers: readonly RuntimeScopedMcpServer[];
      readonly revisions: RuntimeCapabilityRevisions;
    };
  };
};

export const capabilitiesParamValidators = {
  "hooks.manage": exactParamShape(
    {
      workspacePath: stringParam,
      action: oneOfParam(["list", "review", "trust", "enable", "disable", "reload"] as const),
    },
    { handlerId: boundedNonEmptyStringParam(256) },
  ),
  "operations.manage": exactParamShape(
    {
      workspacePath: stringParam,
      action: oneOfParam(["list", "show", "retry", "abort"] as const),
    },
    {
      operationId: boundedNonEmptyStringParam(256),
      expectedVersion: positiveIntegerParam,
      reason: boundedNonEmptyStringParam(4_096),
    },
  ),
  "plugin.manage": exactParamShape(
    {
      workspacePath: stringParam,
      action: oneOfParam([
        "list",
        "inspect",
        "install",
        "trust.prepare",
        "trust.confirm",
        "enable",
        "disable",
      ] as const),
    },
    {
      id: boundedNonEmptyStringParam(256),
      scope: oneOfParam(["user", "project", "local"] as const),
      path: boundedNonEmptyStringParam(4_096),
      confirmId: boundedNonEmptyStringParam(256),
      fingerprint: boundedNonEmptyStringParam(512),
    },
  ),
  "catalog.agents": workspaceParams,
  "catalog.skills": workspaceParams,
  "config.skills": workspaceParams,
  "config.mcpServers": workspaceParams,
  "skills.user.list": noParams,
  "skills.effective.list": workspaceParams,
  "mcp.user.list": noParams,
  "mcp.user.upsert": exactParamShape({
    server: runtimeMcpServerParam,
    expectedRevision: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "mcp.user.delete": exactParamShape({
    serverName: boundedNonEmptyStringParam(256),
    expectedRevision: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "mcp.user.setEnabled": exactParamShape({
    serverName: boundedNonEmptyStringParam(256),
    enabled: booleanParam,
    expectedRevision: boundedNonEmptyStringParam(512),
    idempotencyKey: boundedNonEmptyStringParam(512),
  }),
  "mcp.effective.list": workspaceParams,
} satisfies Readonly<Record<keyof CapabilitiesMethodMap, RuntimeParamValidator>>;

export const capabilitiesResultValidators = {
  "hooks.manage": exactResultShape({ result: resultJsonObject }),
  "operations.manage": exactResultShape({ result: resultJsonObject }),
  "plugin.manage": exactResultShape({ result: resultJsonObject }),
  "catalog.agents": exactResultShape({ agents: resultArray(runtimeCatalogAgentResult) }),
  "catalog.skills": exactResultShape({ skills: resultArray(runtimeCatalogSkillResult) }),
  "config.skills": exactResultShape({ skills: resultArray(resultJsonObject) }),
  "config.mcpServers": exactResultShape({ servers: resultArray(resultJsonObject) }),
  "skills.user.list": exactResultShape({
    skills: resultArray(runtimeScopedSkillResult),
    revision: resultString,
  }),
  "skills.effective.list": exactResultShape({
    skills: resultArray(runtimeScopedSkillResult),
    revisions: runtimeCapabilityRevisionsResult,
  }),
  "mcp.user.list": exactResultShape({
    servers: resultArray(runtimeScopedMcpServerResult),
    revision: resultString,
  }),
  "mcp.user.upsert": exactResultShape({
    server: runtimeScopedMcpServerResult,
    revision: resultString,
  }),
  "mcp.user.delete": exactResultShape({
    serverName: resultString,
    deleted: resultOneOf([true]),
    revision: resultString,
  }),
  "mcp.user.setEnabled": exactResultShape({
    server: runtimeScopedMcpServerResult,
    revision: resultString,
  }),
  "mcp.effective.list": exactResultShape({
    servers: resultArray(runtimeScopedMcpServerResult),
    revisions: runtimeCapabilityRevisionsResult,
  }),
} satisfies Readonly<Record<keyof CapabilitiesMethodMap, RuntimeResultRule>>;
