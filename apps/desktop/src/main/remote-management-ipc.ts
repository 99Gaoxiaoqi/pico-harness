import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  REMOTE_MANAGEMENT_CHANNEL,
  isRemoteManagementRequest,
  type RemoteConfigureInput,
} from "../preload/remote-management-contract.js";
import type { DesktopResult } from "../preload/contract.js";
import type { RemoteManagementService } from "./remote-management-service.js";

export function registerRemoteManagementIpc(options: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly trusted: (event: IpcMainInvokeEvent) => boolean;
  readonly service: RemoteManagementService;
}): () => void {
  options.ipcMain.handle(
    REMOTE_MANAGEMENT_CHANNEL,
    async (event, value: unknown): Promise<DesktopResult<unknown>> => {
      if (!options.trusted(event))
        return {
          ok: false,
          error: {
            code: "UNAUTHORIZED_RENDERER",
            message: "已拒绝非受信任页面调用",
            retryable: false,
          },
        };
      const request = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      if (
        Object.keys(request).some((key) => key !== "action" && key !== "params") ||
        !isRemoteManagementRequest(request.action, request.params)
      )
        return {
          ok: false,
          error: { code: "INVALID_ARGUMENT", message: "手机连接请求参数无效", retryable: false },
        };
      const params = request.params as Record<string, unknown>;
      try {
        let result: unknown;
        switch (request.action) {
          case "snapshot":
            result = await options.service.snapshot();
            break;
          case "configure":
            result = await options.service.configure(params as unknown as RemoteConfigureInput);
            break;
          case "start":
            result = await options.service.start();
            break;
          case "stop":
            result = await options.service.stop();
            break;
          case "offer":
            result = await options.service.offer();
            break;
          case "approve":
            result = await options.service.manage("pair.approve", params);
            break;
          case "reject":
            result = await options.service.manage("pair.reject", params);
            break;
          case "revoke":
            result = await options.service.manage("devices.revoke", params);
            break;
        }
        return { ok: true, value: result };
      } catch {
        // Gateway enrollment/network exceptions may contain an invitation or credential-bearing URL.
        return {
          ok: false,
          error: {
            code: "REMOTE_MANAGEMENT_FAILED",
            message: "手机连接操作失败。请检查服务地址、邀请、项目授权或连接状态后重试。",
            retryable: true,
          },
        };
      }
    },
  );
  return () => options.ipcMain.removeHandler(REMOTE_MANAGEMENT_CHANNEL);
}
