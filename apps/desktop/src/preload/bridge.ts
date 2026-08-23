import type { IpcRenderer } from "electron";
import {
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeNotificationBuffer,
  RuntimeProtocolError,
  type RuntimeNotification,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_RUNTIME_METHODS,
  type DesktopBridge,
  type DesktopBrowserRect,
  type DesktopBrowserState,
  type DesktopResult,
  type DesktopRuntimeApi,
} from "./contract.js";

interface RuntimeInvocationEnvelope {
  readonly method: string;
  readonly params: unknown;
}

const MAX_PRELOAD_SEEN_EVENT_IDS = 10_000;

export function createDesktopBridge(ipcRenderer: IpcRenderer): DesktopBridge {
  const runtimeEntries = DESKTOP_RUNTIME_METHODS.map((method) => [
    method,
    async (params: unknown) => {
      try {
        const checkedParams = parseStrictRuntimeParams(method, params);
        return await ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeInvoke, {
          method,
          params: checkedParams,
        } satisfies RuntimeInvocationEnvelope);
      } catch (error) {
        return validationFailure(error);
      }
    },
  ]);
  // The keys originate exclusively from the immutable allowlist above; callers never receive a
  // generic invoke primitive or an ipcRenderer reference.
  const runtime = Object.fromEntries(runtimeEntries) as DesktopRuntimeApi;

  return Object.freeze({
    runtime: Object.freeze(runtime),
    events: Object.freeze({
      subscribe(
        params: RuntimeParams<"events.subscribe">,
        listener: (notification: RuntimeNotification) => void,
      ) {
        let checkedParams: RuntimeParams<"events.subscribe">;
        try {
          checkedParams = parseStrictRuntimeParams("events.subscribe", params);
          if (typeof listener !== "function") throw invalidBridgeParams("事件监听器必须是函数");
        } catch (error) {
          return Object.freeze({
            ready: Promise.resolve(validationFailure(error)),
            dispose() {},
          });
        }
        const subscriptionId = crypto.randomUUID();
        const pendingEvents = new RuntimeNotificationBuffer();
        let pendingOverflow = false;
        const seenEventIds = new Set<string>();
        let readySettled = false;
        let disposed = false;
        const unsubscribe = () => {
          ipcRenderer.send(DESKTOP_IPC_CHANNELS.runtimeUnsubscribe, { subscriptionId });
        };
        const dispatch = (event: RuntimeNotification) => {
          if (disposed) return;
          if (seenEventIds.has(event.eventId)) return;
          seenEventIds.add(event.eventId);
          if (seenEventIds.size > MAX_PRELOAD_SEEN_EVENT_IDS) {
            const oldest = seenEventIds.values().next().value;
            if (oldest !== undefined) seenEventIds.delete(oldest);
          }
          listener(event);
        };
        const onEvent = (_electronEvent: unknown, envelope: unknown) => {
          if (
            !isRuntimeNotificationEnvelope(envelope) ||
            envelope.subscriptionId !== subscriptionId
          )
            return;
          if (readySettled) dispatch(envelope.event);
          else pendingOverflow ||= !pendingEvents.push(envelope.event);
        };
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
        const ready = (
          ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeSubscribe, {
            subscriptionId,
            params: checkedParams,
          }) as Promise<DesktopResult<RuntimeResult<"events.subscribe">>>
        )
          .then((result) => {
            if (pendingOverflow) {
              disposed = true;
              pendingEvents.clear();
              ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
              unsubscribe();
              return validationFailure(
                new RuntimeProtocolError(
                  RUNTIME_ERROR_CODES.FRAME_TOO_LARGE,
                  "Desktop preload durable 事件超过缓冲预算，请重新加载会话",
                ),
              );
            }
            if (!result.ok) {
              disposed = true;
              readySettled = true;
              pendingEvents.clear();
              ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
              unsubscribe();
              return result;
            }
            for (const event of result.value.events) dispatch(event);
            readySettled = true;
            for (const event of pendingEvents.drain()) dispatch(event);
            return result;
          })
          .catch((error: unknown) => {
            disposed = true;
            readySettled = true;
            pendingEvents.clear();
            ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
            unsubscribe();
            return validationFailure(error);
          })
          .finally(() => {
            // dispose() may race ahead of Main finishing runtimeSubscribe. The first
            // unsubscribe then observes no subscription, so repeat it once creation has
            // definitely settled. Main treats unsubscribe as idempotent.
            if (disposed) unsubscribe();
          });
        return Object.freeze({
          ready,
          dispose() {
            if (disposed) return;
            disposed = true;
            pendingEvents.clear();
            ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
            unsubscribe();
          },
        });
      },
    }),
    sessionFrames: Object.freeze({
      subscribe(
        listener: (frame: RuntimeSessionSubscriptionFrame) => void,
        onDisconnect?: () => void,
      ) {
        if (typeof listener !== "function") return Object.freeze({ dispose() {} });
        const onFrame = (_electronEvent: unknown, value: unknown) => {
          if (isSessionSubscriptionFrame(value)) listener(value);
        };
        const onDisconnected = (): void => onDisconnect?.();
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.sessionFrame, onFrame);
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.sessionDisconnected, onDisconnected);
        return Object.freeze({
          dispose() {
            ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.sessionFrame, onFrame);
            ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.sessionDisconnected, onDisconnected);
          },
        });
      },
    }),
    onUnavailable(listener: () => void): () => void {
      if (typeof listener !== "function") return () => undefined;
      const handler = (): void => listener();
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtimeUnavailable, handler);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeUnavailable, handler);
      };
    },
    onRecovered(listener: () => void): () => void {
      if (typeof listener !== "function") return () => undefined;
      const handler = (): void => listener();
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtimeRecovered, handler);
      return () => {
        ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeRecovered, handler);
      };
    },
    platform: Object.freeze({
      chooseWorkspace: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chooseWorkspace),
      showNotification: (input: { readonly title: string; readonly body: string }) => {
        if (!hasExactStringFields(input, ["title", "body"])) {
          return Promise.resolve(validationFailure(invalidBridgeParams("系统通知参数无效")));
        }
        return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showNotification, input);
      },
      openDirectory: (path: string) => {
        if (typeof path !== "string") {
          return Promise.resolve(validationFailure(invalidBridgeParams("目录参数必须是字符串")));
        }
        return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openDirectory, path);
      },
      getLaunchAtLogin: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getLaunchAtLogin),
      setLaunchAtLogin: (enabled: boolean) => {
        if (typeof enabled !== "boolean") {
          return Promise.resolve(
            validationFailure(invalidBridgeParams("开机启动参数必须是布尔值")),
          );
        }
        return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setLaunchAtLogin, enabled);
      },
    }),
    lifecycle: Object.freeze({
      setBackgroundMode: (enabled: boolean) => {
        if (typeof enabled !== "boolean") {
          return Promise.resolve(
            validationFailure(invalidBridgeParams("后台模式参数必须是布尔值")),
          );
        }
        return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setBackgroundMode, enabled);
      },
      quit: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.quit),
    }),
    browser: Object.freeze({
      setActiveSession: (sessionId: string | null) => {
        if (sessionId !== null && !isNonEmptyString(sessionId)) {
          return Promise.resolve(validationFailure(invalidBridgeParams("浏览器会话参数无效")));
        }
        return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.browserSetActiveSession, sessionId);
      },
      setViewport: (input: {
        readonly sessionId: string;
        readonly rect: DesktopBrowserRect | null;
        readonly generation: number;
      }) => {
        if (!isViewportInput(input)) {
          return Promise.resolve(validationFailure(invalidBridgeParams("浏览器视口参数无效")));
        }
        return ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.browserSetViewport, input);
      },
      navigate: (sessionId: string, url: string) =>
        invokeBrowserSession<DesktopBrowserState>(
          ipcRenderer,
          DESKTOP_IPC_CHANNELS.browserNavigate,
          sessionId,
          url,
        ),
      back: (sessionId: string) =>
        invokeBrowserSession<DesktopBrowserState>(
          ipcRenderer,
          DESKTOP_IPC_CHANNELS.browserBack,
          sessionId,
        ),
      forward: (sessionId: string) =>
        invokeBrowserSession<DesktopBrowserState>(
          ipcRenderer,
          DESKTOP_IPC_CHANNELS.browserForward,
          sessionId,
        ),
      reload: (sessionId: string) =>
        invokeBrowserSession<DesktopBrowserState>(
          ipcRenderer,
          DESKTOP_IPC_CHANNELS.browserReload,
          sessionId,
        ),
      stop: (sessionId: string) =>
        invokeBrowserSession<DesktopBrowserState>(
          ipcRenderer,
          DESKTOP_IPC_CHANNELS.browserStop,
          sessionId,
        ),
      getState: (sessionId: string) =>
        invokeBrowserSession<DesktopBrowserState | null>(
          ipcRenderer,
          DESKTOP_IPC_CHANNELS.browserGetState,
          sessionId,
        ),
      close: (sessionId: string) =>
        invokeBrowserSession<void>(ipcRenderer, DESKTOP_IPC_CHANNELS.browserClose, sessionId),
      clearData: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.browserClearData),
      onState(listener: (state: DesktopBrowserState) => void): () => void {
        if (typeof listener !== "function") return () => undefined;
        const handler = (_event: unknown, value: unknown): void => {
          if (isBrowserState(value)) listener(value);
        };
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.browserState, handler);
        return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.browserState, handler);
      },
    }),
  });
}

function invokeBrowserSession<T>(
  ipcRenderer: IpcRenderer,
  channel: string,
  sessionId: string,
  extra?: string,
): Promise<DesktopResult<T>> {
  if (!isNonEmptyString(sessionId) || (extra !== undefined && typeof extra !== "string")) {
    return Promise.resolve(validationFailure(invalidBridgeParams("浏览器操作参数无效")));
  }
  return ipcRenderer.invoke(channel, sessionId, extra) as Promise<DesktopResult<T>>;
}

function isViewportInput(value: unknown): value is {
  readonly sessionId: string;
  readonly rect: DesktopBrowserRect | null;
  readonly generation: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!isNonEmptyString(input["sessionId"]) || !Number.isSafeInteger(input["generation"])) {
    return false;
  }
  if (input["rect"] === null) return true;
  if (!input["rect"] || typeof input["rect"] !== "object" || Array.isArray(input["rect"])) {
    return false;
  }
  const rect = input["rect"] as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof rect[key] === "number" && Number.isFinite(rect[key]),
  );
}

function isBrowserState(value: unknown): value is DesktopBrowserState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    isNonEmptyString(state["sessionId"]) &&
    typeof state["url"] === "string" &&
    typeof state["title"] === "string" &&
    typeof state["canGoBack"] === "boolean" &&
    typeof state["canGoForward"] === "boolean" &&
    typeof state["loading"] === "boolean" &&
    typeof state["secure"] === "boolean" &&
    typeof state["hasPage"] === "boolean" &&
    typeof state["visible"] === "boolean" &&
    Number.isSafeInteger(state["generation"])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSessionSubscriptionFrame(value: unknown): value is RuntimeSessionSubscriptionFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return (
    typeof frame["hostEpoch"] === "string" &&
    frame["hostEpoch"].length > 0 &&
    typeof frame["subscriptionId"] === "string" &&
    frame["subscriptionId"].length > 0 &&
    typeof frame["sessionId"] === "string" &&
    frame["sessionId"].length > 0 &&
    typeof frame["sequence"] === "number" &&
    Number.isSafeInteger(frame["sequence"]) &&
    frame["sequence"] > 0 &&
    typeof frame["type"] === "string" &&
    [
      "subscription.session_delta",
      "subscription.tool_event",
      "subscription.subagent_update",
      "subscription.run_state",
      "subscription.transcript_advanced",
      "subscription.continuity_degraded",
      "subscription.closed",
    ].includes(frame["type"])
  );
}

interface RuntimeNotificationEnvelope {
  readonly subscriptionId: string;
  readonly event: RuntimeNotification;
}

function isRuntimeNotificationEnvelope(value: unknown): value is RuntimeNotificationEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeNotificationEnvelope>;
  return (
    typeof candidate.subscriptionId === "string" &&
    typeof candidate.event === "object" &&
    candidate.event !== null
  );
}

function validationFailure(error: unknown): DesktopResult<never> {
  return {
    ok: false,
    error: {
      code: error instanceof RuntimeProtocolError ? error.code : RUNTIME_ERROR_CODES.INVALID_PARAMS,
      message: error instanceof Error ? error.message : "Desktop bridge 参数无效",
      retryable: false,
    },
  };
}

function invalidBridgeParams(message: string): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, message);
}

function hasExactStringFields(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(record, field) && typeof record[field] === "string")
  );
}
