import type { IpcRenderer } from "electron";
import {
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeNotification,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_RUNTIME_METHODS,
  type DesktopBridge,
  type DesktopResult,
  type DesktopRuntimeApi,
} from "./contract.js";

interface RuntimeInvocationEnvelope {
  readonly method: string;
  readonly params: unknown;
}

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
        const pendingEvents: RuntimeNotification[] = [];
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
          listener(event);
        };
        const onEvent = (_electronEvent: unknown, envelope: unknown) => {
          if (
            !isRuntimeNotificationEnvelope(envelope) ||
            envelope.subscriptionId !== subscriptionId
          )
            return;
          if (readySettled) dispatch(envelope.event);
          else pendingEvents.push(envelope.event);
        };
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
        const ready = (
          ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeSubscribe, {
            subscriptionId,
            params: checkedParams,
          }) as Promise<DesktopResult<RuntimeResult<"events.subscribe">>>
        )
          .then((result) => {
            if (result.ok) {
              for (const event of result.value.events) dispatch(event);
            }
            readySettled = true;
            for (const event of pendingEvents.splice(0)) dispatch(event);
            return result;
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
            pendingEvents.splice(0);
            ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
            unsubscribe();
          },
        });
      },
    }),
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
  });
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
