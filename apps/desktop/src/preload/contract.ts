import {
  DESKTOP_RUNTIME_METHODS,
  type DesktopRuntimeMethod,
  type RuntimeEvent,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";

export { DESKTOP_RUNTIME_METHODS, type DesktopRuntimeMethod };

export const DESKTOP_IPC_CHANNELS = {
  runtimeInvoke: "pico:runtime:invoke",
  runtimeSubscribe: "pico:runtime:subscribe",
  runtimeUnsubscribe: "pico:runtime:unsubscribe",
  runtimeEvent: "pico:runtime:event",
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

export interface RuntimeEventSubscription {
  readonly ready: Promise<DesktopResult<RuntimeResult<"events.subscribe">>>;
  dispose(): void;
}

export interface DesktopBridge {
  readonly runtime: DesktopRuntimeApi;
  readonly events: {
    subscribe(
      params: RuntimeParams<"events.subscribe">,
      listener: (event: RuntimeEvent) => void,
    ): RuntimeEventSubscription;
  };
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
