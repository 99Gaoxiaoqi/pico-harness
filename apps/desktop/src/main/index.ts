import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { parseDesktopRuntimeResult } from "@pico/protocol";
import { DESKTOP_IPC_CHANNELS } from "../preload/contract.js";
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

// 探活：daemon 中途死亡时 subscription 重连只在主进程进行，渲染进程无感知，
// 会停在"看似就绪但所有操作都失败"的界面。周期 ping，连续失败达阈值则通知
// 渲染进程降级到连接错误页；不自动重启 daemon（避免重启循环掩盖配置错误）。
const RUNTIME_PROBE_INTERVAL_MS = 10_000;
const RUNTIME_PROBE_MAX_FAILURES = 3;
let stopRuntimeProbe: (() => void) | undefined;
function startRuntimeProbe(): () => void {
  let consecutiveFailures = 0;
  let stopped = false;
  const handleFailure = (): void => {
    if (stopped) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= RUNTIME_PROBE_MAX_FAILURES) {
      // 不做一次性去重：daemon 抖动（复活窗口 < 一个探活 tick）下，去重标志只能由
      // 探活自身采到的成功 ping 复位，会在 renderer 重连成功后 daemon 再次死亡时
      // 静默不再广播。每次达阈值都 send，renderer 收到首个通知后即摘除监听，
      // 后续冗余 send 命中零 listener，代价可忽略。
      const window = mainWindow;
      if (window && !window.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC_CHANNELS.runtimeUnavailable);
      }
    }
  };
  const timer = setInterval(() => {
    if (stopped) return;
    runtime
      .request("runtime.ping", {})
      .then((result) => {
        parseDesktopRuntimeResult("runtime.ping", result);
        consecutiveFailures = 0;
      })
      .catch(() => handleFailure());
  }, RUNTIME_PROBE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
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
    stopRuntimeProbe?.();
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
      stopRuntimeProbe = startRuntimeProbe();
    })
    .catch(async (error: unknown) => {
      console.error("Pico desktop failed to start", error);
      if (app.isPackaged) {
        const detail = error instanceof Error ? error.message : String(error);
        await dialog
          .showMessageBox({
            type: "error",
            title: "Pico 启动失败",
            message: "本地 Runtime 无法启动，请稍后重试或重新安装。",
            detail: detail.length > 500 ? `${detail.slice(0, 500)}…` : detail,
            buttons: ["退出"],
            defaultId: 0,
            cancelId: 0,
          })
          .catch(() => undefined);
      }
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
