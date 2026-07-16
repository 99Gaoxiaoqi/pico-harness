import { app, BrowserWindow, ipcMain } from "electron";
import { parseDesktopRuntimeResult } from "@pico/protocol";
import { createPlatformServices } from "../platform/index.js";
import { registerDesktopIpcHandlers } from "./ipc.js";
import { DesktopLifecycleController } from "./lifecycle.js";
import { LocalDaemonRuntimeClientAdapter } from "./runtime-client-adapter.js";
import { createDesktopWindow } from "./window.js";
import { configureAutoUpdates } from "./updater.js";
import { installApplicationMenu } from "./menu.js";
import { createDesktopDaemonShutdownFence, DesktopDaemonController } from "./daemon-controller.js";

let mainWindow: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
let disposeUpdater: (() => void) | undefined;
const runtime = new LocalDaemonRuntimeClientAdapter();
const daemon = new DesktopDaemonController();
const lifecycle = new DesktopLifecycleController(() => mainWindow);
const requestDesktopShutdown = (exitCode?: number): void => {
  if (exitCode !== undefined) process.exitCode = exitCode;
  lifecycle.markQuitting();
  app.quit();
};
const stopOwnedDaemonBeforeQuit = createDesktopDaemonShutdownFence(
  daemon,
  () => requestDesktopShutdown(),
  (error) => console.error("Pico desktop daemon failed to stop cleanly", error),
);

if (!app.requestSingleInstanceLock()) {
  requestDesktopShutdown();
} else {
  app.on("second-instance", () => lifecycle.showWindow());
  app.on("before-quit", (event) => {
    lifecycle.markQuitting();
    stopOwnedDaemonBeforeQuit(event);
  });
  app.on("will-quit", () => {
    disposeIpc?.();
    disposeUpdater?.();
    runtime.close();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !lifecycle.shouldKeepInBackground()) app.quit();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
    else lifecycle.showWindow();
  });

  void app
    .whenReady()
    .then(async () => {
      if (process.platform === "win32") app.setAppUserModelId("com.squirrel.pico.Pico");
      installApplicationMenu(() => mainWindow);
      await daemon.start();
      if (lifecycle.isQuitting()) return;
      parseDesktopRuntimeResult("runtime.ping", await runtime.request("runtime.ping", {}));
      if (lifecycle.isQuitting()) return;
      const platform = createPlatformServices();
      disposeIpc = registerDesktopIpcHandlers({
        ipcMain,
        getTrustedWebContents: () => mainWindow?.webContents,
        runtime,
        platform,
        lifecycle,
      });
      disposeUpdater = configureAutoUpdates(() => lifecycle.markQuitting());
      await openMainWindow();
    })
    .catch((error: unknown) => {
      console.error("Pico desktop failed to start", error);
      requestDesktopShutdown(1);
    });
}

async function openMainWindow(): Promise<void> {
  if (lifecycle.isQuitting()) return;
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
