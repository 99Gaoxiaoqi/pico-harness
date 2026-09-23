import { dialog, shell, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { DESKTOP_ARTIFACT_CHANNELS, isArtifactReference } from "../preload/artifact-contract.js";
import type { DesktopResult } from "../preload/contract.js";
import type { RuntimeClientAdapter } from "./runtime-client-adapter.js";
import { createArtifactExporter } from "./artifact-export.js";

export function registerArtifactIpcHandlers(options: {
  readonly ipcMain: IpcMain;
  readonly runtime: Pick<RuntimeClientAdapter, "request">;
  readonly trusted: (event: IpcMainInvokeEvent) => boolean;
}): () => void {
  const exporter = createArtifactExporter({
    query: (params) => options.runtime.request("session.artifacts.query", params),
    chooseSavePath: async (name) => {
      const result = await dialog.showSaveDialog({ title: "另存生成文件", defaultPath: name });
      return result.canceled ? undefined : result.filePath;
    },
    revealFile: (path) => shell.showItemInFolder(path),
    openDefaultApp: async (path) => {
      const error = await shell.openPath(path);
      if (error) throw new Error(error);
    },
  });
  for (const action of ["open", "openInDefaultApp", "saveAs"] as const) {
    options.ipcMain.handle(
      DESKTOP_ARTIFACT_CHANNELS[action],
      async (event, value: unknown): Promise<DesktopResult<void>> => {
        if (!options.trusted(event))
          return {
            ok: false,
            error: {
              code: "UNAUTHORIZED_RENDERER",
              message: "已拒绝非受信任页面调用",
              retryable: false,
            },
          };
        if (!isArtifactReference(value))
          return {
            ok: false,
            error: { code: "INVALID_ARGUMENT", message: "生成文件引用无效", retryable: false },
          };
        try {
          await exporter.export(value, action);
          return { ok: true, value: undefined };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "ARTIFACT_EXPORT_FAILED",
              message: error instanceof Error ? error.message : "生成文件导出失败",
              retryable: false,
            },
          };
        }
      },
    );
  }
  return () => {
    for (const channel of Object.values(DESKTOP_ARTIFACT_CHANNELS))
      options.ipcMain.removeHandler(channel);
    void exporter
      .dispose()
      .catch((error: unknown) => console.error("生成文件临时目录清理失败", error));
  };
}
