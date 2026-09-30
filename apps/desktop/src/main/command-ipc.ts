import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_COMMAND_CHANNEL } from "../preload/command-contract.js";
import type { DesktopResult } from "../preload/contract.js";
import { createDesktopCommandService } from "./command-service.js";
import type { RuntimeClientAdapter } from "./runtime-client-adapter.js";

export function registerCommandIpc(options: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  runtime: Pick<RuntimeClientAdapter, "request">;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  isQuitting: () => boolean;
}) {
  const commands = createDesktopCommandService(options.runtime);
  options.ipcMain.handle(
    DESKTOP_COMMAND_CHANNEL,
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
      try {
        if (options.isQuitting()) throw new Error("Pico 正在退出。");
        return { ok: true, value: await commands.invoke(event.sender.id, value) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "COMMAND_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
      }
    },
  );
  return () => {
    commands.dispose();
    options.ipcMain.removeHandler(DESKTOP_COMMAND_CHANNEL);
  };
}
