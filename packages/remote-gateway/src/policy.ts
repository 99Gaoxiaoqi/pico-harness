import {
  REMOTE_METHOD_SPECS,
  toRuntimeParams,
  type RemotePermission,
  type RemoteRequest,
} from "@pico/protocol/remote";
import {
  parseRuntimeResult,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import { UserMcpConfigStore } from "@pico/pico-host/user-mcp-config-store";
import { GatewayError } from "./errors.js";
import type { GatewayConfig, GatewayDevice, GatewayWorkspace } from "./state.js";

export interface GatewayRuntimeClient {
  request<M extends RuntimeMethod>(method: M, params: RuntimeParams<M>): Promise<RuntimeResult<M>>;
  subscribe(
    params: RuntimeParams<"events.subscribe">,
    listener: Parameters<
      import("@pico/pico-host/local-runtime-client").RuntimeClient["subscribe"]
    >[1],
  ): ReturnType<import("@pico/pico-host/local-runtime-client").RuntimeClient["subscribe"]>;
  subscribeSessionFrames: import("@pico/pico-host/local-runtime-client").RuntimeClient["subscribeSessionFrames"];
  close(): void;
}
// These legacy methods can run terminal cleanup indirectly, even without terminal permission.
export const SESSION_CLEANUP_METHODS: ReadonlySet<string> = new Set([
  "session.list",
  "session.delete",
  "sideChat.create",
  "sideChat.close",
]);
export function requirePermission(device: GatewayDevice, permission: RemotePermission): void {
  if (device.revokedAt || !device.permissions.includes(permission))
    throw new GatewayError("FORBIDDEN", "此设备没有所需权限", 403);
}
export function resolveDeviceWorkspace(
  config: GatewayConfig,
  device: GatewayDevice,
  workspaceId: string,
): GatewayWorkspace {
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || !device.workspaceIds.includes(workspaceId))
    throw new GatewayError("FORBIDDEN", "工作区未授权", 403);
  return workspace;
}
export async function authorizeRuntimeRequest(
  config: GatewayConfig,
  device: GatewayDevice,
  client: GatewayRuntimeClient,
  request: RemoteRequest,
): Promise<{ params: RuntimeParams<RemoteRequest["method"]>; workspace?: GatewayWorkspace }> {
  const spec = REMOTE_METHOD_SPECS[request.method];
  requirePermission(device, spec.permission);
  const workspace = request.workspaceId
    ? resolveDeviceWorkspace(config, device, request.workspaceId)
    : undefined;
  if (spec.workspaceRequired && !workspace)
    throw new GatewayError("INVALID_PARAMS", "缺少授权工作区");
  if (SESSION_CLEANUP_METHODS.has(request.method)) {
    try {
      const capability = parseRuntimeResult(
        "terminal.ownershipCapabilities",
        await client.request("terminal.ownershipCapabilities", {}),
      );
      if (capability.sessionCleanupIsolation !== true) throw new Error("unsupported");
    } catch {
      throw new GatewayError(
        "UNSUPPORTED_CAPABILITY",
        "电脑 Runtime 不支持远程会话清理隔离，请更新并在本机重启 Pico daemon",
        409,
      );
    }
  }
  if (request.method.startsWith("terminal.")) {
    try {
      const capability = await client.request("terminal.ownershipCapabilities", {});
      if (capability.ownerIsolation !== true) throw new Error("unsupported");
    } catch {
      throw new GatewayError(
        "FORBIDDEN",
        "电脑 Runtime 不支持终端设备隔离，请重启或更新 Pico",
        403,
      );
    }
  }
  let effectiveRequest = request;
  if (request.method === "mcp.user.upsert")
    effectiveRequest = await mergeMcpSecrets(config, client, request);
  if (request.method === "provider.upsert")
    effectiveRequest = await mergeProviderUrl(config, client, request);
  const params = toRuntimeParams(effectiveRequest, workspace?.path);
  const record = params as Record<string, unknown>;
  if (request.method === "session.settings.update" && record["permissionMode"] !== undefined)
    requirePermission(device, "host.admin");
  if (request.method === "session.send") {
    const initial = record["initialSettings"] as Record<string, unknown> | undefined;
    if (initial?.["permissionMode"] !== undefined) requirePermission(device, "host.admin");
  }
  if (request.method === "config.update") {
    const patch = record["patch"] as Record<string, unknown>;
    if (["permissions", "additionalDirectories"].some((key) => key in patch))
      throw new GatewayError("FORBIDDEN", "授权目录只能在电脑修改", 403);
  }
  // Validate linkage before dispatch. The existing Runtime independently rechecks the same ownership.
  for (const sessionKey of ["sessionId", "sourceSessionId"])
    if (workspace && typeof record[sessionKey] === "string" && request.method !== "session.get") {
      const session = parseRuntimeResult(
        "session.get",
        await client.request("session.get", {
          workspacePath: workspace.path,
          sessionId: record[sessionKey] as string,
        }),
      );
      if (session.session.workspacePath !== workspace.path)
        throw new GatewayError("FORBIDDEN", "会话不属于工作区", 403);
    }
  if (workspace && typeof record["runId"] === "string") {
    const runs = parseRuntimeResult(
      "runs.list",
      await client.request("runs.list", { workspacePath: workspace.path }),
    );
    const run = runs.runs.find((candidate) => candidate.runId === record["runId"]);
    if (
      !run ||
      run.workspacePath !== workspace.path ||
      (typeof record["sessionId"] === "string" && run.sessionId !== record["sessionId"])
    )
      throw new GatewayError("FORBIDDEN", "运行不属于授权会话", 403);
  }
  if (
    workspace &&
    request.method.startsWith("terminal.") &&
    typeof record["terminalId"] === "string" &&
    typeof record["sessionId"] === "string"
  ) {
    const terminals = parseRuntimeResult(
      "terminal.list",
      await client.request("terminal.list", {
        workspacePath: workspace.path,
        sessionId: record["sessionId"] as string,
      }),
    );
    const terminal = terminals.terminals.find(
      (candidate) => candidate.terminalId === record["terminalId"],
    );
    if (!terminal) throw new GatewayError("FORBIDDEN", "终端不属于授权会话", 403);
    if (
      !["terminal.attach", "terminal.detach"].includes(request.method) &&
      terminal["terminalOwnerId"] !== `remote:${device.id}`
    )
      throw new GatewayError("FORBIDDEN", "只能控制此设备创建的终端", 403);
  }
  return { params, ...(workspace ? { workspace } : {}) };
}
async function mergeMcpSecrets(
  config: GatewayConfig,
  client: GatewayRuntimeClient,
  request: RemoteRequest,
): Promise<RemoteRequest> {
  const params = request.params as Record<string, unknown>;
  const server = params["server"] as Record<string, unknown> | undefined;
  if (!server || typeof server["name"] !== "string")
    throw new GatewayError("INVALID_PARAMS", "MCP 定义无效");
  const before = parseRuntimeResult("mcp.user.list", await client.request("mcp.user.list", {}));
  if (before.revision !== params["expectedRevision"])
    throw new GatewayError("CONFLICT", "MCP 配置已更改，请刷新后重试", 409);
  const snapshot = await new UserMcpConfigStore({
    ...(config.runtimeHostRootPath ? { picoHome: config.runtimeHostRootPath } : {}),
  }).read();
  const existing = snapshot.config.mcpServers[server["name"]];
  const publicSnapshot = parseRuntimeResult(
    "mcp.user.list",
    await client.request("mcp.user.list", {}),
  );
  if (publicSnapshot.revision !== params["expectedRevision"])
    throw new GatewayError("CONFLICT", "MCP 配置已更改，请刷新后重试", 409);
  const merged: Record<string, unknown> = { ...server };
  if (existing && existing.transport === server["transport"]) {
    for (const key of ["env", "headers", "url", "command", "args"])
      if (merged[key] === undefined && key in existing)
        merged[key] = (existing as unknown as Record<string, unknown>)[key];
  }
  const edits = request.secretEdits;
  for (const field of ["env", "headers"] as const)
    if (edits?.[field]) {
      const target: Record<string, string> = {
        ...((merged[field] ?? {}) as Record<string, string>),
      };
      for (const [key, edit] of Object.entries(edits[field])) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new GatewayError("INVALID_PARAMS", "秘密字段名称无效");
        if (edit.action === "set") target[key] = edit.value;
        else if (edit.action === "remove") delete target[key];
      }
      merged[field] = target;
    }
  if (edits?.url?.action === "set") merged["url"] = edits.url.value;
  else if (edits?.url?.action === "remove") delete merged["url"];
  return { ...request, params: { ...params, server: merged } as RemoteRequest["params"] };
}

export function publicEndpoint(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[地址不可展示]";
  }
}
async function mergeProviderUrl(
  config: GatewayConfig,
  client: GatewayRuntimeClient,
  request: RemoteRequest,
): Promise<RemoteRequest> {
  const params = request.params as Record<string, unknown>;
  const submitted = params["provider"] as Record<string, unknown> | undefined;
  if (!submitted || typeof submitted["id"] !== "string" || typeof submitted["baseURL"] !== "string")
    throw new GatewayError("INVALID_PARAMS", "Provider 定义无效");
  const before = parseRuntimeResult("config.user.get", await client.request("config.user.get", {}));
  if (before.revision !== params["expectedRevision"])
    throw new GatewayError("CONFLICT", "Provider 配置已更改，请刷新后重试", 409);
  const snapshot = await new UserConfigStore({
    ...(config.runtimeHostRootPath ? { picoHome: config.runtimeHostRootPath } : {}),
  }).read();
  const after = parseRuntimeResult("config.user.get", await client.request("config.user.get", {}));
  if (after.revision !== params["expectedRevision"])
    throw new GatewayError("CONFLICT", "Provider 配置已更改，请刷新后重试", 409);
  const existing = snapshot.config.providers[submitted["id"]];
  const previous = existing?.baseURL;
  if (typeof previous === "string" && submitted["baseURL"] === publicEndpoint(previous))
    return {
      ...request,
      params: {
        ...params,
        provider: { ...submitted, baseURL: previous },
      } as RemoteRequest["params"],
    };
  return request;
}
