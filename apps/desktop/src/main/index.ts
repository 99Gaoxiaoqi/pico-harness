import { app, BrowserWindow, ipcMain } from "electron";
import { createPlatformServices } from "../platform/index.js";
import { registerDesktopIpcHandlers } from "./ipc.js";
import { DesktopLifecycleController } from "./lifecycle.js";
import { LocalDaemonRuntimeClientAdapter } from "./runtime-client-adapter.js";
import { createDesktopWindow } from "./window.js";

let mainWindow: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
const runtime = new LocalDaemonRuntimeClientAdapter();
const lifecycle = new DesktopLifecycleController(() => mainWindow);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => lifecycle.showWindow());
  app.on("before-quit", () => lifecycle.markQuitting());
  app.on("will-quit", () => {
    disposeIpc?.();
    runtime.close();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !lifecycle.shouldKeepInBackground()) app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
    else lifecycle.showWindow();
  });

  void app.whenReady().then(async () => {
    const platform = createPlatformServices();
    disposeIpc = registerDesktopIpcHandlers({
      ipcMain,
      getTrustedWebContents: () => mainWindow?.webContents,
      runtime,
      platform,
      lifecycle,
    });
    await openMainWindow();
  });
}

async function openMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    lifecycle.showWindow();
    return;
  }
  mainWindow = await createDesktopWindow({
    userDataPath: app.getPath("userData"),
    shouldKeepInBackground: () => lifecycle.shouldKeepInBackground(),
    onClosed: () => {
      mainWindow = undefined;
    },
  });
}
