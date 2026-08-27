import {
  DESKTOP_RUNTIME_METHODS,
  type DesktopRuntimeMethod,
  type RuntimeNotification,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";

export { DESKTOP_RUNTIME_METHODS, type DesktopRuntimeMethod };

export const DESKTOP_IPC_CHANNELS = {
  runtimeInvoke: "pico:runtime:invoke",
  runtimeSubscribe: "pico:runtime:subscribe",
  runtimeUnsubscribe: "pico:runtime:unsubscribe",
  runtimeEvent: "pico:runtime:event",
  sessionFrame: "pico:runtime:session-frame",
  sessionDisconnected: "pico:runtime:session-disconnected",
  runtimeUnavailable: "pico:runtime:unavailable",
  runtimeRecovered: "pico:runtime:recovered",
  chooseWorkspace: "pico:platform:choose-workspace",
  showNotification: "pico:platform:show-notification",
  openDirectory: "pico:platform:open-directory",
  getLaunchAtLogin: "pico:platform:get-launch-at-login",
  setLaunchAtLogin: "pico:platform:set-launch-at-login",
  getBackgroundMode: "pico:lifecycle:get-background-mode",
  setBackgroundMode: "pico:lifecycle:set-background-mode",
  quit: "pico:lifecycle:quit",
  browserAcquireViewport: "pico:browser:acquire-viewport",
  browserSetActiveSession: "pico:browser:set-active-session",
  browserSetViewport: "pico:browser:set-viewport",
  browserNavigate: "pico:browser:navigate",
  browserBack: "pico:browser:back",
  browserForward: "pico:browser:forward",
  browserReload: "pico:browser:reload",
  browserStop: "pico:browser:stop",
  browserGetState: "pico:browser:get-state",
  browserClearPage: "pico:browser:clear-page",
  browserClose: "pico:browser:close",
  browserClearData: "pico:browser:clear-data",
  browserClick: "pico:browser:click",
  browserType: "pico:browser:type",
  browserState: "pico:browser:state",
} as const;

export interface DesktopBrowserRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopBrowserState {
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
  readonly secure: boolean;
  readonly hasPage: boolean;
  readonly visible: boolean;
  readonly generation: number;
}

export interface DesktopBrowserElementResult {
  readonly state: DesktopBrowserState;
  readonly selector: string;
  readonly tagName: string;
}

export interface DesktopError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type DesktopResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DesktopError };

export type DesktopRuntimeApi = {
  readonly [Method in DesktopRuntimeMethod]: (
    params: RuntimeParams<Method>,
  ) => Promise<DesktopResult<RuntimeResult<Method>>>;
};

export interface RuntimeNotificationSubscription {
  readonly ready: Promise<DesktopResult<RuntimeResult<"events.subscribe">>>;
  dispose(): void;
}

export interface DesktopBridge {
  readonly runtime: DesktopRuntimeApi;
  readonly events: {
    subscribe(
      params: RuntimeParams<"events.subscribe">,
      listener: (notification: RuntimeNotification) => void,
    ): RuntimeNotificationSubscription;
  };
  readonly sessionFrames: {
    subscribe(
      listener: (frame: RuntimeSessionSubscriptionFrame) => void,
      onDisconnect?: () => void,
    ): { dispose(): void };
  };
  /** 主进程探活判定 Runtime 永久不可达时通过此通道通知渲染进程。 */
  onUnavailable(listener: () => void): () => void;
  /**
   * 主进程监督器在降级后重新探活成功时通知渲染进程（3-C 自动恢复）：
   * 渲染层据此自动 re-bootstrap，不再永久停在错误页。
   */
  onRecovered(listener: () => void): () => void;
  readonly platform: {
    chooseWorkspace(): Promise<DesktopResult<string | undefined>>;
    showNotification(input: {
      readonly title: string;
      readonly body: string;
    }): Promise<DesktopResult<void>>;
    openDirectory(path: string): Promise<DesktopResult<void>>;
    getLaunchAtLogin(): Promise<DesktopResult<boolean>>;
    setLaunchAtLogin(enabled: boolean): Promise<DesktopResult<void>>;
  };
  readonly lifecycle: {
    getBackgroundMode(): Promise<DesktopResult<boolean>>;
    setBackgroundMode(enabled: boolean): Promise<DesktopResult<void>>;
    quit(): Promise<DesktopResult<void>>;
  };
  readonly browser: {
    acquireViewport(sessionId: string): Promise<DesktopResult<number>>;
    setActiveSession(sessionId: string | null): Promise<DesktopResult<void>>;
    setViewport(input: {
      readonly sessionId: string;
      readonly rect: DesktopBrowserRect | null;
      readonly generation: number;
    }): Promise<DesktopResult<DesktopBrowserState>>;
    navigate(sessionId: string, url: string): Promise<DesktopResult<DesktopBrowserState>>;
    back(sessionId: string): Promise<DesktopResult<DesktopBrowserState>>;
    forward(sessionId: string): Promise<DesktopResult<DesktopBrowserState>>;
    reload(sessionId: string): Promise<DesktopResult<DesktopBrowserState>>;
    stop(sessionId: string): Promise<DesktopResult<DesktopBrowserState>>;
    getState(sessionId: string): Promise<DesktopResult<DesktopBrowserState | null>>;
    clearPage(sessionId: string): Promise<DesktopResult<DesktopBrowserState>>;
    close(sessionId: string): Promise<DesktopResult<void>>;
    clearData(): Promise<DesktopResult<void>>;
    click(sessionId: string, selector: string): Promise<DesktopResult<DesktopBrowserElementResult>>;
    type(
      sessionId: string,
      selector: string,
      text: string,
      clear?: boolean,
    ): Promise<DesktopResult<DesktopBrowserElementResult>>;
    onState(listener: (state: DesktopBrowserState) => void): () => void;
  };
}
