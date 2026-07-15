import { isAbsolute } from "node:path";
import {
  dialog,
  type IpcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  parseDesktopRuntimeResult,
  parseStrictRuntimeParams,
  RuntimeProtocolError,
  type RuntimeMethod,
} from "@pico/protocol";
import type { PlatformServices } from "../platform/index.js";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_RUNTIME_METHODS,
  type DesktopError,
  type DesktopResult,
  type DesktopRuntimeMethod,
} from "../preload/contract.js";
import { RuntimeClientError, type RuntimeClientAdapter } from "./runtime-client-adapter.js";

interface LifecycleControls {
  setBackgroundMode(enabled: boolean): void;
  requestQuit(): void;
}

interface RuntimeSubscription {
  readonly ownerId: number;
  readonly dispose: () => void;
}

const allowedMethods = new Set<RuntimeMethod>(DESKTOP_RUNTIME_METHODS);

export function registerDesktopIpcHandlers(options: {
  readonly ipcMain: IpcMain;
  readonly getTrustedWebContents: () => WebContents | undefined;
  readonly runtime: RuntimeClientAdapter;
  readonly platform: PlatformServices;
  readonly lifecycle: LifecycleControls;
}): () => void {
  const { ipcMain, runtime, platform, lifecycle } = options;
  const subscriptions = new Map<string, RuntimeSubscription>();

  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent): boolean =>
    event.sender === options.getTrustedWebContents() && !event.sender.isDestroyed();

  ipcMain.handle(DESKTOP_IPC_CHANNELS.runtimeInvoke, async (event, value: unknown) => {
    if (!trusted(event)) return unauthorized();
    try {
      const envelope = readInvocation(value);
      const params = parseStrictRuntimeParams(envelope.method, envelope.params);
      const result = parseDesktopRuntimeResult(
        envelope.method,
        await runtime.request(envelope.method, params),
      );
      return success(result);
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.runtimeSubscribe, async (event, value: unknown) => {
    if (!trusted(event)) return unauthorized();
    try {
      const envelope = readSubscription(value);
      const params = parseStrictRuntimeParams("events.subscribe", envelope.params);
      subscriptions.get(envelope.subscriptionId)?.dispose();
      const subscription = await runtime.subscribe(params, (runtimeEvent) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(DESKTOP_IPC_CHANNELS.runtimeEvent, {
            subscriptionId: envelope.subscriptionId,
            event: runtimeEvent,
          });
        }
      });
      subscriptions.set(envelope.subscriptionId, {
        ownerId: event.sender.id,
        dispose: subscription.dispose,
      });
      event.sender.once("destroyed", () =>
        disposeOwnedSubscriptions(subscriptions, event.sender.id),
      );
      return success(parseDesktopRuntimeResult("events.subscribe", subscription.replay));
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.on(DESKTOP_IPC_CHANNELS.runtimeUnsubscribe, (event, value: unknown) => {
    if (!trusted(event)) return;
    const subscriptionId = readSubscriptionId(value);
    if (!subscriptionId) return;
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription || subscription.ownerId !== event.sender.id) return;
    subscription.dispose();
    subscriptions.delete(subscriptionId);
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.chooseWorkspace, async (event) => {
    if (!trusted(event)) return unauthorized();
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择 Pico 工作区",
    });
    return success(result.canceled ? undefined : result.filePaths[0]);
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.showNotification, async (event, value: unknown) => {
    if (!trusted(event)) return unauthorized();
    try {
      const notification = readNotification(value);
      await platform.showNotification(notification);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.openDirectory, async (event, value: unknown) => {
    if (!trusted(event)) return unauthorized();
    try {
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw invalidArgument("目录必须是绝对路径");
      }
      await platform.openDirectory(value);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.getLaunchAtLogin, (event) => {
    if (!trusted(event)) return unauthorized();
    try {
      return success(platform.getLaunchAtLogin());
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.setLaunchAtLogin, (event, value: unknown) => {
    if (!trusted(event)) return unauthorized();
    try {
      if (typeof value !== "boolean") throw invalidArgument("开机启动参数无效");
      platform.setLaunchAtLogin(value);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.setBackgroundMode, (event, value: unknown) => {
    if (!trusted(event)) return unauthorized();
    if (typeof value !== "boolean") return failure(invalidArgument("后台模式参数无效"));
    lifecycle.setBackgroundMode(value);
    return success(undefined);
  });

  ipcMain.handle(DESKTOP_IPC_CHANNELS.quit, (event) => {
    if (!trusted(event)) return unauthorized();
    lifecycle.requestQuit();
    return success(undefined);
  });

  return () => {
    for (const subscription of subscriptions.values()) subscription.dispose();
    subscriptions.clear();
    for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(DESKTOP_IPC_CHANNELS.runtimeUnsubscribe);
  };
}

function readInvocation(value: unknown): {
  readonly method: DesktopRuntimeMethod;
  readonly params: unknown;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["method", "params"]) ||
    !isDesktopRuntimeMethod(value.method)
  ) {
    throw invalidArgument("桌面端 Runtime 调用无效");
  }
  return { method: value.method, params: value.params };
}

function readSubscription(value: unknown): {
  readonly subscriptionId: string;
  readonly params: unknown;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["subscriptionId", "params"]) ||
    !isValidSubscriptionId(value.subscriptionId)
  ) {
    throw invalidArgument("事件订阅参数无效");
  }
  return { subscriptionId: value.subscriptionId, params: value.params };
}

function readSubscriptionId(value: unknown): string | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["subscriptionId"]) ||
    !isValidSubscriptionId(value.subscriptionId)
  )
    return undefined;
  return value.subscriptionId;
}

function isValidSubscriptionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
}

function readNotification(value: unknown): { readonly title: string; readonly body: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["title", "body"]) ||
    typeof value.title !== "string" ||
    value.title.length === 0 ||
    value.title.length > 120 ||
    typeof value.body !== "string" ||
    value.body.length > 1_000
  ) {
    throw invalidArgument("系统通知参数无效");
  }
  return { title: value.title, body: value.body };
}

function isDesktopRuntimeMethod(value: unknown): value is DesktopRuntimeMethod {
  return typeof value === "string" && allowedMethods.has(value as RuntimeMethod);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function disposeOwnedSubscriptions(
  subscriptions: Map<string, RuntimeSubscription>,
  ownerId: number,
): void {
  for (const [id, subscription] of subscriptions) {
    if (subscription.ownerId !== ownerId) continue;
    subscription.dispose();
    subscriptions.delete(id);
  }
}

function success<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function unauthorized(): DesktopResult<never> {
  return {
    ok: false,
    error: { code: "UNAUTHORIZED_RENDERER", message: "已拒绝非受信任页面调用", retryable: false },
  };
}

function failure(error: unknown): DesktopResult<never> {
  const desktopError = toDesktopError(error);
  return { ok: false, error: desktopError };
}

function toDesktopError(error: unknown): DesktopError {
  if (error instanceof RuntimeClientError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof RuntimeProtocolError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof DesktopIpcError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  return {
    code: "DESKTOP_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "桌面端发生未知错误",
    retryable: false,
  };
}

class DesktopIpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DesktopIpcError";
  }
}

function invalidArgument(message: string): DesktopIpcError {
  return new DesktopIpcError("INVALID_ARGUMENT", message);
}
