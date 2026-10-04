import type { IpcRenderer } from "electron";
import {
  REMOTE_MANAGEMENT_ACTIONS,
  REMOTE_MANAGEMENT_CHANNEL,
  isRemoteManagementRequest,
  type DesktopRemoteManagementApi,
} from "./remote-management-contract.js";
export function createRemoteManagementBridge(
  ipc: Pick<IpcRenderer, "invoke">,
): DesktopRemoteManagementApi {
  return Object.freeze(
    Object.fromEntries(
      REMOTE_MANAGEMENT_ACTIONS.map((action) => [
        action,
        async (params: unknown) => {
          if (!isRemoteManagementRequest(action, params))
            return {
              ok: false,
              error: {
                code: "INVALID_ARGUMENT",
                message: "手机连接请求参数无效",
                retryable: false,
              },
            };
          return ipc.invoke(REMOTE_MANAGEMENT_CHANNEL, { action, params });
        },
      ]),
    ) as unknown as DesktopRemoteManagementApi,
  );
}
