import { join } from "node:path";
import { BrowserWindow, session } from "electron";
import { createWindowState, WindowStateStore } from "./window-state.js";

export interface DesktopWindowOptions {
  readonly userDataPath: string;
  readonly onClosed: () => void;
  readonly shouldKeepInBackground: () => boolean;
}

export async function createDesktopWindow(options: DesktopWindowOptions): Promise<BrowserWindow> {
  const stateStore = new WindowStateStore(options.userDataPath);
  const state = await stateStore.read();
  const preloadPath = join(import.meta.dirname, "preload.js");
  const window = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Pico",
    backgroundColor: "#141719",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });

  if (state.maximized) window.maximize();
  configureWebContentsSecurity(window);

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (options.shouldKeepInBackground()) {
      event.preventDefault();
      window.hide();
      return;
    }
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    void stateStore.write(createWindowState(bounds, window.isMaximized())).catch(() => undefined);
  });
  window.once("closed", options.onClosed);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(
      join(import.meta.dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  return window;
}

export function isAllowedNavigation(target: string, current: string): boolean {
  try {
    const targetUrl = new URL(target);
    const currentUrl = new URL(current);
    if (currentUrl.protocol === "file:") {
      return targetUrl.protocol === "file:" && targetUrl.pathname === currentUrl.pathname;
    }
    return targetUrl.origin === currentUrl.origin;
  } catch {
    return false;
  }
}

function configureWebContentsSecurity(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedNavigation(target, window.webContents.getURL())) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", () => {
    if (!window.isDestroyed()) window.hide();
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}
