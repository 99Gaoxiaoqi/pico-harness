import { session, type BrowserWindow, type Session, WebContentsView } from "electron";
import type {
  DesktopBrowserRect,
  DesktopBrowserState,
} from "../preload/contract.js";
import { normalizeBrowserAddress, normalizeViewport } from "./browser-logic.js";

export const PICO_BROWSER_PARTITION = "persist:pico-browser";

const guardedSessions = new WeakSet<Session>();

export interface EmbeddedBrowserAuthority {
  setActiveSession(sessionId: string | null): void;
  setViewport(
    sessionId: string,
    rect: DesktopBrowserRect | null,
    generation: number,
  ): DesktopBrowserState;
  navigate(sessionId: string, address: string): Promise<DesktopBrowserState>;
  back(sessionId: string): DesktopBrowserState;
  forward(sessionId: string): DesktopBrowserState;
  reload(sessionId: string): DesktopBrowserState;
  stop(sessionId: string): DesktopBrowserState;
  getState(sessionId: string): DesktopBrowserState | null;
  close(sessionId: string): Promise<void>;
  clearData(): Promise<void>;
  dispose(): Promise<void>;
}

interface BrowserEntry {
  readonly view: WebContentsView;
  generation: number;
  visible: boolean;
}

export function createEmbeddedBrowserAuthority(options: {
  readonly getWindow: () => BrowserWindow | undefined;
  readonly onState: (state: DesktopBrowserState) => void;
}): EmbeddedBrowserAuthority {
  const entries = new Map<string, BrowserEntry>();
  let activeSessionId: string | null = null;

  const requireWindow = (): BrowserWindow => {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) throw new Error("Pico 主窗口尚未就绪");
    return window;
  };

  const stateOf = (sessionId: string, entry: BrowserEntry): DesktopBrowserState => {
    const contents = entry.view.webContents;
    const url = contents.isDestroyed() ? "" : contents.getURL();
    return {
      sessionId,
      url,
      title: contents.isDestroyed() ? "" : contents.getTitle(),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      loading: !contents.isDestroyed() && contents.isLoading(),
      secure: url.startsWith("https://"),
      hasPage: url.length > 0 && !url.startsWith("about:"),
      visible: entry.visible && activeSessionId === sessionId,
      generation: entry.generation,
    };
  };

  const emit = (sessionId: string, entry: BrowserEntry): DesktopBrowserState => {
    const state = stateOf(sessionId, entry);
    options.onState(state);
    return state;
  };

  const installPartitionGuards = (target: Session): void => {
    if (guardedSessions.has(target)) return;
    guardedSessions.add(target);
    target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    target.setPermissionCheckHandler(() => false);
    target.on("will-download", (event) => event.preventDefault());
  };

  const getOrCreate = (sessionId: string): BrowserEntry => {
    const existing = entries.get(sessionId);
    if (existing) return existing;
    const window = requireWindow();
    const view = new WebContentsView({
      webPreferences: {
        partition: PICO_BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const entry: BrowserEntry = { view, generation: 0, visible: false };
    entries.set(sessionId, entry);
    window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setBackgroundThrottling(true);
    installPartitionGuards(view.webContents.session);
    const refresh = (): void => {
      if (entries.get(sessionId) === entry && !view.webContents.isDestroyed()) emit(sessionId, entry);
    };
    view.webContents.on("did-start-loading", refresh);
    view.webContents.on("did-stop-loading", refresh);
    view.webContents.on("did-navigate", refresh);
    view.webContents.on("did-navigate-in-page", refresh);
    view.webContents.on("page-title-updated", refresh);
    view.webContents.on("did-fail-load", refresh);
    view.webContents.setWindowOpenHandler(({ url }) => {
      const navigable = normalizeBrowserAddress(url);
      if (navigable) void view.webContents.loadURL(navigable).catch(() => undefined);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (!normalizeBrowserAddress(url)) event.preventDefault();
    });
    return entry;
  };

  const hide = (sessionId: string, entry: BrowserEntry): void => {
    entry.visible = false;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.setBackgroundThrottling(true);
    entry.view.setVisible(false);
    emit(sessionId, entry);
  };

  const authority: EmbeddedBrowserAuthority = {
    setActiveSession(sessionId) {
      activeSessionId = sessionId;
      for (const [id, entry] of entries) {
        if (id !== sessionId) hide(id, entry);
      }
    },

    setViewport(sessionId, rect, generation) {
      const entry = getOrCreate(sessionId);
      if (generation < entry.generation) return stateOf(sessionId, entry);
      entry.generation = generation;
      const bounds = normalizeViewport(rect);
      if (!bounds || activeSessionId !== sessionId) {
        hide(sessionId, entry);
        return stateOf(sessionId, entry);
      }
      entry.visible = true;
      entry.view.setBounds(bounds);
      entry.view.setVisible(true);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.setBackgroundThrottling(false);
      return emit(sessionId, entry);
    },

    async navigate(sessionId, address) {
      if (activeSessionId !== sessionId) throw new Error("浏览器会话当前不可见");
      const url = normalizeBrowserAddress(address);
      if (!url) throw new Error("仅允许打开 HTTP 或 HTTPS 地址");
      const entry = getOrCreate(sessionId);
      await entry.view.webContents.loadURL(url);
      return emit(sessionId, entry);
    },

    back(sessionId) {
      const entry = getOrCreate(sessionId);
      if (entry.view.webContents.navigationHistory.canGoBack()) {
        entry.view.webContents.navigationHistory.goBack();
      }
      return emit(sessionId, entry);
    },

    forward(sessionId) {
      const entry = getOrCreate(sessionId);
      if (entry.view.webContents.navigationHistory.canGoForward()) {
        entry.view.webContents.navigationHistory.goForward();
      }
      return emit(sessionId, entry);
    },

    reload(sessionId) {
      const entry = getOrCreate(sessionId);
      entry.view.webContents.reload();
      return emit(sessionId, entry);
    },

    stop(sessionId) {
      const entry = getOrCreate(sessionId);
      entry.view.webContents.stop();
      return emit(sessionId, entry);
    },

    getState(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? stateOf(sessionId, entry) : null;
    },

    async close(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return;
      entries.delete(sessionId);
      const window = options.getWindow();
      if (window && !window.isDestroyed()) window.contentView.removeChildView(entry.view);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    },

    async clearData() {
      await session.fromPartition(PICO_BROWSER_PARTITION).clearStorageData();
    },

    async dispose() {
      await Promise.all([...entries.keys()].map((sessionId) => authority.close(sessionId)));
    },
  };
  return authority;
}
