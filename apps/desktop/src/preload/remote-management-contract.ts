import { REMOTE_PERMISSIONS, type RemotePermission } from "@pico/protocol/remote";
import type { DesktopResult } from "./contract.js";

export const REMOTE_MANAGEMENT_CHANNEL = "pico:remote-management:invoke";
export const REMOTE_MANAGEMENT_ACTIONS = [
  "snapshot",
  "configure",
  "start",
  "stop",
  "offer",
  "approve",
  "reject",
  "revoke",
] as const;
export type RemoteManagementAction = (typeof REMOTE_MANAGEMENT_ACTIONS)[number];
export interface RemoteWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
export interface RemoteConfiguration {
  readonly configured: boolean;
  readonly connectionMode?: "direct" | "relay";
  readonly relayUrl?: string;
  readonly gatewayId?: string;
  readonly workspaces: readonly RemoteWorkspace[];
}
export interface RemoteDevice {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly RemotePermission[];
  readonly workspaceIds: readonly string[];
  readonly revokedAt?: number;
}
export interface RemotePending {
  readonly pairingId: string;
  readonly deviceName: string;
  readonly expiresAt: number;
}
export interface RemoteSupervisionSnapshot {
  readonly backend: "launchd" | "task-scheduler" | "none";
  readonly desiredRunning: boolean;
  readonly registration: "registered" | "missing" | "unsupported";
  readonly phase: "running" | "stopped" | "recovering" | "updating" | "blocked";
  readonly scope: "user-session" | "none";
  readonly registeredBuildId?: string;
  readonly runningBuildId?: string;
  readonly lastExit?: {
    readonly at: number;
    readonly code?: number | null;
    readonly signal?: string | null;
    readonly buildId?: string;
  };
  readonly issueCode?: "installation_missing" | "registration_missing" | "startup_timeout";
}
export interface RemoteManagementSnapshot {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly configuration: RemoteConfiguration;
  readonly supervision?: RemoteSupervisionSnapshot;
  readonly relayState?:
    | "disabled"
    | "connecting"
    | "online"
    | "reconnecting"
    | "unauthorized"
    | "error";
  readonly lastConnectedAt?: number;
  readonly runtimeLastReachableAt?: number;
  readonly issue?: string;
  readonly devices: readonly RemoteDevice[];
  readonly pending: readonly RemotePending[];
}
export interface RemotePairingQr {
  readonly pairingId: string;
  readonly expiresAt: number;
  readonly qrDataUrl: string;
}
export interface RemoteConfigureInput {
  readonly relayUrl: string;
  readonly workspaces: readonly { readonly path: string; readonly name?: string }[];
}
export interface RemoteApproveInput {
  readonly pairingId: string;
  readonly permissions: readonly RemotePermission[];
  readonly workspaceIds: readonly string[];
}
export interface RemoteManagementParams {
  snapshot: Record<string, never>;
  configure: RemoteConfigureInput;
  start: Record<string, never>;
  stop: Record<string, never>;
  offer: Record<string, never>;
  approve: RemoteApproveInput;
  reject: { readonly pairingId: string };
  revoke: { readonly deviceId: string };
}
export interface RemoteManagementResults {
  snapshot: RemoteManagementSnapshot;
  configure: RemoteManagementSnapshot;
  start: RemoteManagementSnapshot;
  stop: RemoteManagementSnapshot;
  offer: RemotePairingQr;
  approve: RemoteManagementSnapshot;
  reject: RemoteManagementSnapshot;
  revoke: RemoteManagementSnapshot;
}
export type DesktopRemoteManagementApi = {
  readonly [Action in RemoteManagementAction]: (
    params: RemoteManagementParams[Action],
  ) => Promise<DesktopResult<RemoteManagementResults[Action]>>;
};

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\0\r\n]/u.test(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const strings = (value: unknown, max: number) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= max &&
  value.every((entry) => text(entry, 4096)) &&
  new Set(value).size === value.length;
export function isRemoteManagementRequest(
  action: unknown,
  params: unknown,
): action is RemoteManagementAction {
  if (
    typeof action !== "string" ||
    !REMOTE_MANAGEMENT_ACTIONS.includes(action as RemoteManagementAction) ||
    !object(params)
  )
    return false;
  if (["snapshot", "start", "stop", "offer"].includes(action)) return keys(params, []);
  if (action === "configure") {
    if (!keys(params, ["relayUrl", "workspaces"]) || !text(params.relayUrl, 2048)) return false;
    try {
      const url = new URL(params.relayUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        url.pathname !== "/"
      )
        return false;
    } catch {
      return false;
    }
    return (
      Array.isArray(params.workspaces) &&
      params.workspaces.length > 0 &&
      params.workspaces.length <= 100 &&
      params.workspaces.every(
        (workspace) =>
          object(workspace) &&
          keys(workspace, ["path", "name"]) &&
          text(workspace.path, 4096) &&
          (workspace.name === undefined || text(workspace.name)),
      )
    );
  }
  if (action === "approve")
    return (
      keys(params, ["pairingId", "permissions", "workspaceIds"]) &&
      text(params.pairingId) &&
      strings(params.workspaceIds, 100) &&
      strings(params.permissions, REMOTE_PERMISSIONS.length) &&
      (params.permissions as string[]).every((permission) =>
        REMOTE_PERMISSIONS.includes(permission as RemotePermission),
      )
    );
  if (action === "reject") return keys(params, ["pairingId"]) && text(params.pairingId);
  return keys(params, ["deviceId"]) && text(params.deviceId);
}
