import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { parseDesktopRuntimeResult } from "@pico/protocol";
import { DESKTOP_IPC_CHANNELS } from "../preload/contract.js";
import { createPlatformServices } from "../platform/index.js";
import { registerDesktopIpcHandlers } from "./ipc.js";
import { DesktopLifecycleController } from "./lifecycle.js";
import { LocalDaemonRuntimeClientAdapter, RuntimeClientError } from "./runtime-client-adapter.js";
import { startRuntimeSupervisor, type RuntimeSupervisorEvent } from "./runtime-supervisor.js";
import { createDesktopWindow } from "./window.js";
import { configureAutoUpdates } from "./updater.js";
import { installApplicationMenu } from "./menu.js";
import { sleepForRetry } from "../../../../src/provider/retry.js";
import { createEmbeddedBrowserAuthority } from "./browser-manager.js";
import { createDesktopTerminalCleanupFence } from "./daemon-controller.js";

let mainWindow: BrowserWindow | undefined;
let disposeIpc: (() => void) | undefined;
let disposeUpdater: (() => void) | undefined;
// 3-B-3 硬切后默认构造走 kernel 承载：首次请求（下方 runtime.ping）经
// connectOrSpawn 自动拉起 detached 常驻 daemon candidate（自持 residency，
// 不随本 app 退出；cron 调度依赖其常驻）。Electron 主进程只做瘦客户端。
const runtime = new LocalDaemonRuntimeClientAdapter(undefined, {
  // The daemon is a separate Vite target beside main.cjs. Supplying its concrete
  // artifact keeps both development and packaged startup independent from
  // import.meta.url rewriting inside the shared client bundle.
  candidateEntrypoint: join(__dirname, "daemon.cjs"),
});
const lifecycle = new DesktopLifecycleController(() => mainWindow);
const browser = createEmbeddedBrowserAuthority({
  getWindow: () => mainWindow,
  onState: (state) => {
    const contents = mainWindow?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.send(DESKTOP_IPC_CHANNELS.browserState, state);
  },
});
const requestDesktopShutdown = (exitCode?: number): void => {
  if (exitCode !== undefined) process.exitCode = exitCode;
  lifecycle.markQuitting();
  app.quit();
};
const stopAllDesktopTerminals = async (): Promise<void> => {
  await runtime.request("terminal.stopAll", {});
};
const terminalCleanupFence = createDesktopTerminalCleanupFence(
  { stopAll: stopAllDesktopTerminals },
  () => app.quit(),
  (error) => console.error("Pico desktop terminal cleanup failed", error),
);
const releaseDesktopTerminalsBestEffort = (): void => {
  void stopAllDesktopTerminals().catch((error: unknown) => {
    console.error("Pico desktop terminal release failed", error);
  });
};

// Runtime 连接监督（3-C 自动恢复）：daemon 中途死亡时 subscription 重连只在
// 主进程进行，渲染进程无感知，会停在"看似就绪但所有操作都失败"的界面。监督器
// 周期 ping（自带 5s 假死超时），连续失败达阈值广播 runtimeUnavailable（渲染层
// 降级到恢复屏）；降级后探活重新成功广播 runtimeRecovered（渲染层自动
// re-bootstrap，消除 fail-stuck）。不自动重启 daemon——kernel 承载下幂等 ping
// 的重试窗口本身就会尝试重生，重启循环只会掩盖配置错误。
let stopRuntimeProbe: (() => void) | undefined;
function startRuntimeProbe(): () => void {
  const notify = (event: RuntimeSupervisorEvent): void => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(
      event === "unavailable"
        ? DESKTOP_IPC_CHANNELS.runtimeUnavailable
        : DESKTOP_IPC_CHANNELS.runtimeRecovered,
    );
  };
  return startRuntimeSupervisor({
    ping: async () =>
      parseDesktopRuntimeResult("runtime.ping", await runtime.request("runtime.ping", {})),
    notify,
  });
}
if (!app.requestSingleInstanceLock()) {
  requestDesktopShutdown();
} else {
  app.on("second-instance", () => lifecycle.showWindow());
  app.on("before-quit", (event) => {
    // daemon 由 kernel 承载独立常驻（cron 调度依赖），本 app 不拥有其生命周期，
    // 但 Workbar Terminal 不跨 Desktop 重启恢复，必须先释放其进程组。
    lifecycle.markQuitting();
    terminalCleanupFence(event);
  });
  app.on("will-quit", () => {
    stopRuntimeProbe?.();
    disposeIpc?.();
    disposeUpdater?.();
    runtime.close();
    void browser.dispose();
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
      // 首次 ping 触发 connectOrSpawn：拉起或连上常驻 daemon 后返回。冷启动时
      // daemon 的 recover 窗口（reconcile 注册工作区 + 启动 cron，可达秒级）内
      // 操作会被 host 以 host_not_ready 拒绝（RUNTIME_UNAVAILABLE，可重试）——
      // 有限退避重试覆盖该窗口，避免把正常的冷启动误报成启动失败。
      parseDesktopRuntimeResult("runtime.ping", await pingUntilReady());
      if (lifecycle.isQuitting()) return;
      const platform = createPlatformServices();
      disposeIpc = registerDesktopIpcHandlers({
        ipcMain,
        getTrustedWebContents: () => mainWindow?.webContents,
        runtime,
        platform,
        lifecycle,
        browser,
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
      if (!lifecycle.isQuitting()) releaseDesktopTerminalsBestEffort();
    },
    onRendererGone: releaseDesktopTerminalsBestEffort,
  });
}

const FIRST_PING_DEADLINE_MS = 30_000;
const FIRST_PING_RETRY_DELAY_MS = 500;
async function pingUntilReady(): Promise<unknown> {
  const deadline = Date.now() + FIRST_PING_DEADLINE_MS;
  for (;;) {
    try {
      return await runtime.request("runtime.ping", {});
    } catch (error) {
      if (
        error instanceof RuntimeClientError &&
        error.retryable &&
        Date.now() + FIRST_PING_RETRY_DELAY_MS < deadline
      ) {
        await sleepForRetry(FIRST_PING_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
}
