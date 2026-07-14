import { app, BrowserWindow, ipcMain } from "electron";
import { createPlatformServices } from "../platform/index.js";
import { registerDesktopIpcHandlers } from "./ipc.js";
import { DesktopLifecycleController } from "./lifecycle.js";
import { LocalDaemonRuntimeClientAdapter } from "./runtime-client-adapter.js";
import { createDesktopWindow } from "./window.js";
import { configureAutoUpdates } from "./updater.js";
import { installApplicationMenu } from "./menu.js";
import { DesktopDaemonController } from "./daemon-controller.js";

let mainWindow: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
let disposeUpdater: (() => void) | undefined;
const runtime = new LocalDaemonRuntimeClientAdapter();
const daemon = new DesktopDaemonController();
const lifecycle = new DesktopLifecycleController(() => mainWindow);
let daemonStopInProgress = false;
let daemonStopped = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => lifecycle.showWindow());
  app.on("before-quit", (event) => {
    lifecycle.markQuitting();
    if (!daemon.ownsProcess || daemonStopped) return;
    event.preventDefault();
    if (daemonStopInProgress) return;
    daemonStopInProgress = true;
    void daemon.stop().finally(() => {
      daemonStopped = true;
      app.quit();
    });
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

  void app.whenReady().then(async () => {
    if (process.platform === "win32") app.setAppUserModelId("com.squirrel.pico.Pico");
    installApplicationMenu(() => mainWindow);
    await daemon.start();
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
  }).catch((error: unknown) => {
    console.error("Pico desktop failed to start", error);
    app.exit(1);
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
