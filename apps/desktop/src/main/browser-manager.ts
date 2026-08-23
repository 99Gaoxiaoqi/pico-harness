import { session, type BrowserWindow, type Session, WebContentsView } from "electron";
import type {
  DesktopBrowserElementResult,
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
  click(sessionId: string, selector: string): Promise<DesktopBrowserElementResult>;
  type(
    sessionId: string,
    selector: string,
    text: string,
    clear: boolean,
  ): Promise<DesktopBrowserElementResult>;
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
      if (entries.get(sessionId) === entry && !view.webContents.isDestroyed())
        emit(sessionId, entry);
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

  const requireVisible = (sessionId: string): BrowserEntry => {
    const entry = entries.get(sessionId);
    if (activeSessionId !== sessionId || !entry?.visible) {
      throw new Error("浏览器会话当前不可见");
    }
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
      if (!entry.view.webContents.isDestroyed())
        entry.view.webContents.setBackgroundThrottling(false);
      return emit(sessionId, entry);
    },

    async navigate(sessionId, address) {
      const url = normalizeBrowserAddress(address);
      if (!url) throw new Error("仅允许打开 HTTP 或 HTTPS 地址");
      const entry = requireVisible(sessionId);
      await entry.view.webContents.loadURL(url);
      return emit(sessionId, entry);
    },

    back(sessionId) {
      const entry = requireVisible(sessionId);
      if (entry.view.webContents.navigationHistory.canGoBack()) {
        entry.view.webContents.navigationHistory.goBack();
      }
      return emit(sessionId, entry);
    },

    forward(sessionId) {
      const entry = requireVisible(sessionId);
      if (entry.view.webContents.navigationHistory.canGoForward()) {
        entry.view.webContents.navigationHistory.goForward();
      }
      return emit(sessionId, entry);
    },

    reload(sessionId) {
      const entry = requireVisible(sessionId);
      entry.view.webContents.reload();
      return emit(sessionId, entry);
    },

    stop(sessionId) {
      const entry = requireVisible(sessionId);
      entry.view.webContents.stop();
      return emit(sessionId, entry);
    },

    getState(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? stateOf(sessionId, entry) : null;
    },

    async click(sessionId, selector) {
      const entry = requireVisible(sessionId);
      const tagName = await withDocumentNode(entry, selector, async (nodeId) => {
        await entry.view.webContents.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", {
          nodeId,
        });
        const result = await entry.view.webContents.debugger.sendCommand("DOM.getBoxModel", {
          nodeId,
        });
        const quad = readQuad(result);
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
        });
        await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        return readNodeName(
          await entry.view.webContents.debugger.sendCommand("DOM.describeNode", { nodeId }),
        );
      });
      return { state: emit(sessionId, entry), selector, tagName };
    },

    async type(sessionId, selector, text, clear) {
      const entry = requireVisible(sessionId);
      const tagName = await withDocumentNode(entry, selector, async (nodeId) => {
        await entry.view.webContents.debugger.sendCommand("DOM.focus", { nodeId });
        if (clear) {
          const modifier = process.platform === "darwin" ? 4 : 2;
          await entry.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            modifiers: modifier,
          });
          await entry.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "a",
            code: "KeyA",
            modifiers: modifier,
          });
          await entry.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Backspace",
            code: "Backspace",
          });
          await entry.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Backspace",
            code: "Backspace",
          });
        }
        if (text.length > 0) {
          await entry.view.webContents.debugger.sendCommand("Input.insertText", { text });
        }
        return readNodeName(
          await entry.view.webContents.debugger.sendCommand("DOM.describeNode", { nodeId }),
        );
      });
      return { state: emit(sessionId, entry), selector, tagName };
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

async function withDocumentNode<T>(
  entry: BrowserEntry,
  selector: string,
  operation: (nodeId: number) => Promise<T>,
): Promise<T> {
  const contents = entry.view.webContents;
  if (contents.isDestroyed()) throw new Error("浏览器页面已经关闭");
  const attachedHere = !contents.debugger.isAttached();
  if (attachedHere) contents.debugger.attach("1.3");
  try {
    const document = await contents.debugger.sendCommand("DOM.getDocument", { depth: 0 });
    const rootNodeId = readNodeId(document);
    const match = await contents.debugger.sendCommand("DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    });
    const nodeId = readNodeId(match);
    if (nodeId === 0) throw new Error(`网页中找不到元素: ${selector}`);
    return await operation(nodeId);
  } finally {
    if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

function readNodeId(value: unknown): number {
  if (!value || typeof value !== "object") throw new Error("浏览器 DOM 响应无效");
  const direct = (value as { nodeId?: unknown }).nodeId;
  if (typeof direct === "number" && Number.isSafeInteger(direct)) return direct;
  const root = (value as { root?: { nodeId?: unknown } }).root?.nodeId;
  if (typeof root === "number" && Number.isSafeInteger(root)) return root;
  throw new Error("浏览器 DOM 节点响应无效");
}

function readNodeName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const nodeName = (value as { node?: { nodeName?: unknown } }).node?.nodeName;
  return typeof nodeName === "string" ? nodeName.toLowerCase() : "";
}

function readQuad(
  value: unknown,
): readonly [number, number, number, number, number, number, number, number] {
  if (!value || typeof value !== "object") throw new Error("网页元素当前不可见");
  const model = (value as { model?: { border?: unknown } }).model;
  const border = model?.border;
  if (!Array.isArray(border) || border.length !== 8 || !border.every(Number.isFinite)) {
    throw new Error("网页元素当前不可见或没有可点击区域");
  }
  return border as [number, number, number, number, number, number, number, number];
}
