import {
  REMOTE_METHOD_SPECS,
  toRuntimeParams,
  type RemotePermission,
  type RemoteRequest,
} from "@pico/protocol/remote";
import {
  parseRuntimeResult,
  CONFIG_SECRET_PATCH_RUNTIME_CAPABILITY,
  RUN_POINT_LOOKUP_RUNTIME_CAPABILITY,
  publicProviderEndpoint,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import { gatewayAuthorizationMetrics } from "./access-metrics.js";
import { GatewayError } from "./errors.js";
import type { GatewayWorkspace } from "./state.js";
import type { RuntimeAccessConfig, RuntimeAccessPrincipal } from "./access-types.js";

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
export function requirePermission(
  device: Pick<RuntimeAccessPrincipal, "permissions" | "revokedAt">,
  permission: RemotePermission,
): void {
  if (device.revokedAt || !device.permissions.includes(permission))
    throw new GatewayError("FORBIDDEN", "此设备没有所需权限", 403);
}
export function resolveDeviceWorkspace(
  config: RuntimeAccessConfig,
  device: Pick<RuntimeAccessPrincipal, "workspaceIds">,
  workspaceId: string,
): GatewayWorkspace {
  const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace || !device.workspaceIds.includes(workspaceId))
    throw new GatewayError("FORBIDDEN", "工作区未授权", 403);
  return workspace;
}
export async function authorizeRuntimeRequest(
  config: RuntimeAccessConfig,
  device: RuntimeAccessPrincipal,
  client: GatewayRuntimeClient,
  request: RemoteRequest,
): Promise<{ params: RuntimeParams<RemoteRequest["method"]>; workspace?: GatewayWorkspace }> {
  const authorizationStarted = performance.now();
  try {
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
    if (request.method === "mcp.user.upsert" || request.method === "provider.upsert") {
      let supported = false;
      try {
        supported = parseRuntimeResult(
          "runtime.ping",
          await client.request("runtime.ping", {}),
        ).capabilities.includes(CONFIG_SECRET_PATCH_RUNTIME_CAPABILITY);
      } catch {
        /* Never fall back to reading local secrets. */
      }
      if (!supported)
        throw new GatewayError(
          "UNSUPPORTED_CAPABILITY",
          "电脑 Runtime 尚未支持安全配置编辑，请更新并重启 Pico daemon",
          409,
          false,
          "not_executed",
        );
    }
    const params = toRuntimeParams(request, workspace?.path);
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
      const lookupStarted = performance.now();
      try {
        const capabilities = parseRuntimeResult(
          "runtime.ping",
          await client.request("runtime.ping", {}),
        ).capabilities;
        let run;
        if (capabilities.includes(RUN_POINT_LOOKUP_RUNTIME_CAPABILITY)) {
          // A failed point lookup is an authorization failure; never bypass or downgrade it.
          const result = parseRuntimeResult(
            "run.get",
            await client.request("run.get", {
              workspacePath: workspace.path,
              runId: record["runId"] as string,
            }),
          );
          run = result.run;
          gatewayAuthorizationMetrics.runCount.record(run ? 1 : 0);
        } else {
          const runs = parseRuntimeResult(
            "runs.list",
            await client.request("runs.list", { workspacePath: workspace.path }),
          );
          gatewayAuthorizationMetrics.runCount.record(runs.runs.length);
          run = runs.runs.find((candidate) => candidate.runId === record["runId"]);
        }
        if (
          !run ||
          run.workspacePath !== workspace.path ||
          (typeof record["sessionId"] === "string" && run.sessionId !== record["sessionId"])
        )
          throw new GatewayError("FORBIDDEN", "运行不属于授权会话", 403);
      } finally {
        gatewayAuthorizationMetrics.lookupMs.record(performance.now() - lookupStarted);
      }
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
        terminal["terminalOwnerId"] !== device.terminalOwnerId
      )
        throw new GatewayError("FORBIDDEN", "只能控制此设备创建的终端", 403);
    }
    return { params, ...(workspace ? { workspace } : {}) };
  } finally {
    gatewayAuthorizationMetrics.authorizationMs.record(performance.now() - authorizationStarted);
  }
}
// Keep the projection import stable while Host and Gateway share its definition.
export const publicEndpoint = publicProviderEndpoint;
