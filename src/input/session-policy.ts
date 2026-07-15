import { globalSessionPermissionGrants } from "../approval/session-permissions.js";
import { forgetSessionSettings } from "./session-settings.js";

/** 清理一个未发布 Session 的进程内设置与临时授权。 */
export function forgetSessionPolicyState(sessionId: string, cwd?: string, picoHome?: string): void {
  forgetSessionSettings(sessionId, cwd, picoHome);
  globalSessionPermissionGrants.clear(sessionId, cwd, picoHome);
}
