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
  setBackgroundMode: "pico:lifecycle:set-background-mode",
  quit: "pico:lifecycle:quit",
} as const;

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
    setBackgroundMode(enabled: boolean): Promise<DesktopResult<void>>;
    quit(): Promise<DesktopResult<void>>;
  };
}
