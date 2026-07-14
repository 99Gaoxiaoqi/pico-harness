import { app, autoUpdater, dialog } from "electron";

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/**
 * Enables the signed Squirrel update path only for packaged builds with an explicit HTTPS feed.
 * Missing release infrastructure is a disabled capability, never a successful fake check.
 */
export function configureAutoUpdates(
  onBeforeQuit: () => void,
  feedUrl = process.env.PICO_UPDATE_FEED_URL,
): () => void {
  if (!app.isPackaged || !isHttpsUrl(feedUrl)) return () => undefined;

  autoUpdater.setFeedURL({ url: feedUrl });
  const check = () => {
    autoUpdater.checkForUpdates();
  };
  const initialTimer = setTimeout(check, INITIAL_CHECK_DELAY_MS);
  const interval = setInterval(check, CHECK_INTERVAL_MS);
  const onDownloaded = (
    _event: Electron.Event,
    _releaseNotes: string,
    releaseName: string,
  ) => {
    void dialog
      .showMessageBox({
        type: "info",
        buttons: ["重新启动并更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
        title: "Pico 更新已就绪",
        message: releaseName ? `版本 ${releaseName} 已下载` : "新版本已下载",
        detail: "重新启动后安装；选择稍后会在下次退出 Pico 时应用。",
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
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

function isHttpsUrl(value: string | undefined): value is string {
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
