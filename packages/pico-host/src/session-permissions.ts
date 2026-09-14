import { applySessionPermissionScope as applyHostSessionPermissionScope } from "@pico/pico-host/session-permission-scope";
import { sessionScopeKey } from "@pico/pico-host";
import { SessionPermissionGrants as RuntimeSessionPermissionGrants } from "@pico/runtime/session-permission-policy";
import type { PermissionSessionScope as RuntimePermissionSessionScope } from "@pico/runtime/session-permission-policy";
import {
  setSessionAdditionalDirectories,
  setSessionPermissionMode,
  type PermissionMode,
  type SessionSettings,
} from "@pico/pico-host/input/session-settings";
import type { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

export {
  bypassImmuneSafetyPath,
  formatPermissionSessionScope,
  permissionScopeForCall,
} from "@pico/runtime/session-permission-policy";
export { isSensitiveCredentialPath } from "@pico/runtime/sensitive-path-policy";
export type {
  PermissionAccess,
  PermissionSessionKey,
  PermissionWorkspaceRoots,
} from "@pico/runtime/session-permission-policy";
export type PermissionSessionScope = RuntimePermissionSessionScope;

/** 用 Pico workspace scope 绑定 Runtime 的进程内授权存储。 */
export class SessionPermissionGrants extends RuntimeSessionPermissionGrants {
  constructor() {
    super(sessionScopeKey);
  }
}

export const globalSessionPermissionGrants = new SessionPermissionGrants();

export interface PermissionRuntimeSettings {
  permissionMode: PermissionMode;
  additionalDirectories?: readonly string[];
}

/** @deprecated session 设置/目录授权投影已迁至 @pico/pico-host。 */
export async function applySessionPermissionScope(
  scope: PermissionSessionScope,
  options: {
    sessionId: string;
    workDir: string;
    settings: PermissionRuntimeSettings;
    workspaceRoots: WorkspaceRoots;
    picoHome?: string;
  },
): Promise<void> {
  await applyHostSessionPermissionScope(scope, {
    ...options,
    grants: globalSessionPermissionGrants,
    settingsPort: {
      additionalDirectories: (settings) => settings.additionalDirectories,
      setAdditionalDirectories: (settings, directories) =>
        setSessionAdditionalDirectories(settings as SessionSettings, directories),
      enableAutoEdits: (settings) => setSessionPermissionMode(settings as SessionSettings, "auto"),
    },
  });
}
