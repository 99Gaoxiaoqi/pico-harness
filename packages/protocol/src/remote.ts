import {
  isJsonObject,
  parseStrictRuntimeParams,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeNotification,
  type RuntimeSessionSubscriptionFrame,
} from "./mobile.js";
import { utf8ByteLength } from "./utf8.js";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_MAX_FRAME_BYTES = 1024 * 1024;
export const REMOTE_PAIRING_TTL_MS = 5 * 60 * 1000;
export const REMOTE_PERMISSIONS = [
  "workspace.read",
  "session.control",
  "workspace.write",
  "terminal.control",
  "host.admin",
] as const;
export type RemotePermission = (typeof REMOTE_PERMISSIONS)[number];
export const REMOTE_DEFAULT_PERMISSIONS: readonly RemotePermission[] = [
  "workspace.read",
  "session.control",
];

// Explicitly reviewed surface: new local methods never become network-accessible implicitly.
const READ_METHODS = [
  "runtime.ping",
  "workspace.status",
  "workspace.trustStatus",
  "session.list",
  "session.get",
  "session.settings.get",
  "session.context.get",
  "session.research.query",
  "session.tasks.query",
  "session.artifacts.query",
  "session.trace.query",
  "session.execution.query",
  "session.execution.summary",
  "session.graph.query",
  "git.review.snapshot",
  "git.review.diff",
  "goal.get",
  "runs.list",
  "changes.list",
  "changes.diff",
  "rewind.list",
  "rewind.preview",
  "rewind.changes",
  "usage.get",
  "catalog.agents",
  "catalog.skills",
  "skills.effective.list",
  "mcp.effective.list",
  "session.subscription.open",
  "session.subscription.close",
  "session.transcript.page",
  "session.transcript.advance",
  "events.subscribe",
  "events.replay",
] as const satisfies readonly RuntimeMethod[];
const CONTROL_METHODS = [
  "session.create",
  "session.archive",
  "session.restore",
  "session.pin",
  "session.unpin",
  "session.delete",
  "session.rename",
  "session.fork",
  "session.compact",
  "session.settings.update",
  "session.send",
  "sideChat.create",
  "sideChat.close",
  "run.start",
  "run.cancel",
  "run.pause",
  "run.resume",
  "run.steer",
  "approval.respond",
  "plan.respond",
  "prompt.respond",
  "prompt.cancel",
  "goal.control",
  "session.tasks.command",
  "session.graph.stop",
  "session.graph.retryWake",
  "changes.review",
] as const satisfies readonly RuntimeMethod[];
const WRITE_METHODS = [
  "changes.apply",
  "rewind.apply",
  "rewind.restoreFile",
  "session.artifacts.command",
] as const satisfies readonly RuntimeMethod[];
const TERMINAL_METHODS = [
  "terminal.create",
  "terminal.list",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.stop",
  "terminal.detach",
] as const satisfies readonly RuntimeMethod[];
const ADMIN_METHODS = [
  "config.get",
  "config.update",
  "config.user.get",
  "config.user.update",
  "config.effective.get",
  "provider.list",
  "provider.test",
  "provider.upsert",
  "provider.delete",
  "provider.credential.status",
  "provider.credential.set",
  "provider.credential.delete",
  "subagents.get",
  "subagents.update",
  "config.skills",
  "config.mcpServers",
  "skills.user.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.setEnabled",
  "mcp.user.delete",
  "hooks.manage",
  "plugin.manage",
  "jobs.list",
  "jobs.create",
  "jobs.update",
  "jobs.delete",
  "jobs.setEnabled",
  "jobs.runNow",
  "jobs.history",
  "memory.list",
  "memory.get",
  "memory.create",
  "memory.update",
  "memory.delete",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
] as const satisfies readonly RuntimeMethod[];
export const REMOTE_METHODS = [
  ...READ_METHODS,
  ...CONTROL_METHODS,
  ...WRITE_METHODS,
  ...TERMINAL_METHODS,
  ...ADMIN_METHODS,
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];
/** Omitted sensitive fields retain the existing server definition; gateway merges before Host validation. */
export type RemoteMcpServerInput = {
  readonly name: string;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabled?: boolean;
  readonly desktopExecution?: boolean;
} & (
  | { readonly transport: "stdio"; readonly command?: string; readonly args?: readonly string[];
      readonly env?: Readonly<Record<string,string>> }
  | { readonly transport: "http" | "sse"; readonly url?: string;
      readonly headers?: Readonly<Record<string,string>> }
);
export type RemoteParams<M extends RemoteMethod> = M extends "mcp.user.upsert"
  ? Omit<RuntimeParams<M>, "workspacePath" | "server"> & { server: RemoteMcpServerInput }
  : Omit<RuntimeParams<M>, "workspacePath">;
export type RemoteResult<M extends RemoteMethod> = RuntimeResult<M>;
export interface RemoteMethodSpec {
  permission: RemotePermission;
  workspaceRequired: boolean;
  mode: "query" | "command";
}
const GLOBAL_METHODS: ReadonlySet<RemoteMethod> = new Set([
  "runtime.ping",
  "config.user.get",
  "config.user.update",
  "provider.list",
  "provider.test",
  "provider.upsert",
  "provider.delete",
  "provider.credential.status",
  "provider.credential.set",
  "provider.credential.delete",
  "subagents.get",
  "subagents.update",
  "skills.user.list",
  "mcp.user.list",
  "mcp.user.upsert",
  "mcp.user.setEnabled",
  "mcp.user.delete",
]);
const ADMIN_QUERIES: ReadonlySet<RemoteMethod> = new Set([
  "config.get",
  "config.user.get",
  "config.effective.get",
  "provider.list",
  "provider.credential.status",
  "subagents.get",
  "config.skills",
  "config.mcpServers",
  "skills.user.list",
  "mcp.user.list",
  "jobs.list",
  "jobs.history",
  "memory.list",
  "memory.get",
  "memory.settings.get",
  "memory.context.preview",
]);
export const REMOTE_METHOD_SPECS: Readonly<Record<RemoteMethod, RemoteMethodSpec>> = Object.freeze(
  Object.fromEntries([
    ...READ_METHODS.map((method) => [
      method,
      {
        permission: "workspace.read",
        workspaceRequired: !GLOBAL_METHODS.has(method),
        mode: "query",
      },
    ]),
    ...CONTROL_METHODS.map((method) => [
      method,
      { permission: "session.control", workspaceRequired: true, mode: "command" },
    ]),
    ...WRITE_METHODS.map((method) => [
      method,
      { permission: "workspace.write", workspaceRequired: true, mode: "command" },
    ]),
    ...TERMINAL_METHODS.map((method) => [
      method,
      {
        permission: "terminal.control",
        workspaceRequired: true,
        mode: ["terminal.list", "terminal.attach"].includes(method) ? "query" : "command",
      },
    ]),
    ...ADMIN_METHODS.map((method) => [
      method,
      {
        permission: "host.admin",
        workspaceRequired: !GLOBAL_METHODS.has(method),
        mode: ADMIN_QUERIES.has(method) ? "query" : "command",
      },
    ]),
  ]) as Record<RemoteMethod, RemoteMethodSpec>,
);
export function isRemoteMethod(value: unknown): value is RemoteMethod {
  return typeof value === "string" && Object.hasOwn(REMOTE_METHOD_SPECS, value);
}
export function getRemoteMethodSpec(method: RemoteMethod): RemoteMethodSpec {
  return REMOTE_METHOD_SPECS[method];
}
export type RemoteSecretEdit = { action: "keep" | "remove" } | { action: "set"; value: string };
export interface RemoteSecretEdits {
  env?: Readonly<Record<string, RemoteSecretEdit>>;
  headers?: Readonly<Record<string, RemoteSecretEdit>>;
  url?: RemoteSecretEdit;
}
export type RemoteRequest<M extends RemoteMethod = RemoteMethod> = {
  version: 1;
  requestId: string;
  workspaceId?: string;
  method: M;
  params: RemoteParams<M>;
  secretEdits?: RemoteSecretEdits;
};
export interface RemoteError {
  code: string;
  message: string;
  retryable: boolean;
  outcome?: "not_executed" | "unknown";
}
export type RemoteResponse<T = unknown> =
  | { requestId: string; ok: true; value: T }
  | { requestId: string; ok: false; error: RemoteError };
export class RemoteProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcome?: "not_executed" | "unknown",
  ) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}
export function parseRemoteRequest(value: unknown): RemoteRequest {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(
      (k) =>
        !["version", "requestId", "workspaceId", "method", "params", "secretEdits"].includes(k),
    )
  )
    throw new RemoteProtocolError("INVALID_REQUEST", "远程请求格式无效");
  if (value.version !== 1) throw new RemoteProtocolError("VERSION_MISMATCH", "远程协议版本不兼容");
  if (
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    !isRemoteMethod(value.method) ||
    !isJsonObject(value.params)
  )
    throw new RemoteProtocolError("INVALID_REQUEST", "请求标识、方法或参数无效");
  if (
    "workspacePath" in value.params ||
    "PICO_HOME" in value.params ||
    "terminalOwnerId" in value.params ||
    "ownerId" in value.params
  )
    throw new RemoteProtocolError("FORBIDDEN", "手机不能指定本机路径或调用主体");
  if (
    value.workspaceId !== undefined &&
    (typeof value.workspaceId !== "string" ||
      value.workspaceId.length < 1 ||
      value.workspaceId.length > 256)
  )
    throw new RemoteProtocolError("INVALID_REQUEST", "工作区标识无效");
  if (REMOTE_METHOD_SPECS[value.method].workspaceRequired && !value.workspaceId)
    throw new RemoteProtocolError("INVALID_REQUEST", "缺少授权工作区");
  if (utf8ByteLength(JSON.stringify(value)) > REMOTE_MAX_FRAME_BYTES)
    throw new RemoteProtocolError("FRAME_TOO_LARGE", "远程请求超过预算");
  if (value.secretEdits !== undefined) {
    if (
      value.method !== "mcp.user.upsert" ||
      !isJsonObject(value.secretEdits) ||
      Object.keys(value.secretEdits).some((k) => !["env", "headers", "url"].includes(k))
    )
      throw new RemoteProtocolError("INVALID_REQUEST", "秘密编辑只适用于 MCP 配置");
    for (const [key, edits] of Object.entries(value.secretEdits)) {
      const records =
        key === "url" ? [edits] : isJsonObject(edits) ? Object.values(edits) : undefined;
      if (!records || records.length > 128)
        throw new RemoteProtocolError("INVALID_REQUEST", "秘密编辑格式无效");
      for (const edit of records)
        if (
          !isJsonObject(edit) ||
          !["keep", "remove", "set"].includes(String(edit.action)) ||
          Object.keys(edit).some((k) => !["action", "value"].includes(k)) ||
          (edit.action === "set"
            ? typeof edit.value !== "string" || edit.value.length > 16384
            : edit.value !== undefined)
        )
          throw new RemoteProtocolError("INVALID_REQUEST", "秘密编辑格式无效");
    }
  }
  return value as unknown as RemoteRequest;
}
export function toRuntimeParams<M extends RemoteMethod>(
  request: RemoteRequest<M>,
  workspacePath?: string,
): RuntimeParams<M> {
  const params = {
    ...request.params,
    ...(REMOTE_METHOD_SPECS[request.method].workspaceRequired ? { workspacePath } : {}),
  };
  return parseStrictRuntimeParams(request.method, params);
}
export interface RemoteWorkspace {
  id: string;
  label: string;
  mode?: "folder" | "git";
}
export interface RemoteCapabilities {
  version: 1;
  gatewayId: string;
  platform: string;
  permissions: readonly RemotePermission[];
  methods: readonly RemoteMethod[];
  maxFrameBytes: number;
  features: Readonly<Record<string, { available: boolean; reason?: string }>>;
}
export interface RemotePairingOffer {
  version: 1;
  publicUrl: string;
  gatewayId: string;
  secret: string;
  expiresAt: number;
}
export interface RemotePairingSubmission {
  version: 1;
  gatewayId: string;
  secret: string;
  deviceName: string;
  platform: "ios" | "android";
}
export interface RemotePairingSubmitted {
  pairingId: string;
  pairingToken: string;
  expiresAt: number;
}
export interface RemotePairedDevice {
  deviceId: string;
  deviceToken: string;
  publicUrl: string;
  gatewayId: string;
  permissions: readonly RemotePermission[];
  workspaceIds: readonly string[];
}
export type RemotePairingStatus =
  | { status: "pending" | "rejected" | "expired" }
  | ({ status: "approved" } & RemotePairedDevice);
export type RemoteClientMessage =
  | { type: "subscribe"; subscriptionId: string; workspaceId: string; afterEventId?: string }
  | { type: "unsubscribe"; subscriptionId: string };
export type RemoteServerMessage =
  | { type: "ready"; version: 1; gatewayId: string; connectionId: string }
  | {
      type: "notification";
      subscriptionId: string;
      workspaceId: string;
      event: RuntimeNotification;
    }
  | { type: "session_frame"; workspaceId?: string; frame: RuntimeSessionSubscriptionFrame }
  | {
      type: "subscribed";
      subscriptionId: string;
      workspaceId: string;
      replay: RuntimeResult<"events.subscribe">;
    }
  | { type: "disconnected"; reason: string }
  | { type: "error"; subscriptionId?: string; error: RemoteError };
export function parsePairingOffer(value: unknown): RemotePairingOffer {
  if (
    !isJsonObject(value) ||
    value.version !== 1 ||
    typeof value.publicUrl !== "string" ||
    typeof value.gatewayId !== "string" ||
    !value.gatewayId ||
    typeof value.secret !== "string" ||
    value.secret.length < 32 ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  )
    throw new RemoteProtocolError("INVALID_PAIRING", "配对二维码无效");
  const url = new URL(value.publicUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new RemoteProtocolError("INVALID_PAIRING", "配对地址必须是 HTTPS origin");
  if (value.expiresAt <= Date.now())
    throw new RemoteProtocolError("PAIRING_EXPIRED", "配对二维码已过期");
  return value as unknown as RemotePairingOffer;
}
