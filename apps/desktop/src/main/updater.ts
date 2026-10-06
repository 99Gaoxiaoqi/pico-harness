import { app, autoUpdater, dialog } from "electron";

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
declare const __PICO_UPDATE_FEED_URL__: string | null;

/**
 * Enables the signed Squirrel update path only for packaged builds with an explicit HTTPS feed.
 * Missing release infrastructure is a disabled capability, never a successful fake check.
 */
export function configureAutoUpdates(
  onBeforeQuit: () => void,
  prepareForUpdate: () => Promise<void>,
  feedUrl = __PICO_UPDATE_FEED_URL__,
): () => void {
  if (!app.isPackaged || !isHttpsUrl(feedUrl)) return () => undefined;

  autoUpdater.setFeedURL({ url: feedUrl });
  const check = () => {
    autoUpdater.checkForUpdates();
  };
  const initialTimer = setTimeout(check, INITIAL_CHECK_DELAY_MS);
  const interval = setInterval(check, CHECK_INTERVAL_MS);
  const onDownloaded = (_event: Electron.Event, _releaseNotes: string, releaseName: string) => {
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["重新启动并更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
        title: "Pico 更新已就绪",
        message: releaseName ? `版本 ${releaseName} 已下载` : "新版本已下载",
        detail: "确认后先停止手机连接，再重新启动并安装；选择稍后保留当前版本。",
      })
      .then(({ response }) => {
        if (response === 0) {
          return prepareForUpdate().then(() => {
            onBeforeQuit();
            autoUpdater.quitAndInstall();
          });
        }
        return undefined;
      })
      .catch((error: unknown) => {
        process.stderr.write(`Pico 更新准备失败: ${safeErrorMessage(error)}\n`);
        void dialog.showMessageBox({
          type: "error",
          title: "暂时无法安装更新",
          message: "手机连接尚未完成停止，请稍后重试更新。",
        });
      });
  };
  const onError = (error: Error) => {
    process.stderr.write(`Pico 自动更新失败: ${safeErrorMessage(error)}\n`);
  };
  autoUpdater.on("update-downloaded", onDownloaded);
  autoUpdater.on("error", onError);
  autoUpdater.on("before-quit-for-update", onBeforeQuit);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
    autoUpdater.off("update-downloaded", onDownloaded);
    autoUpdater.off("error", onError);
    autoUpdater.off("before-quit-for-update", onBeforeQuit);
  };
}

function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
}
