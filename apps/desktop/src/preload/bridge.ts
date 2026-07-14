import type { IpcRenderer } from "electron";
import type { RuntimeEvent, RuntimeParams } from "@pico/protocol";
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
    (params: unknown) =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeInvoke, {
        method,
        params,
      } satisfies RuntimeInvocationEnvelope),
  ]);
  // The keys originate exclusively from the immutable allowlist above; callers never receive a
  // generic invoke primitive or an ipcRenderer reference.
  const runtime = Object.fromEntries(runtimeEntries) as DesktopRuntimeApi;

  return Object.freeze({
    runtime: Object.freeze(runtime),
    events: Object.freeze({
      subscribe(
        params: RuntimeParams<"events.subscribe">,
        listener: (event: RuntimeEvent) => void,
      ) {
        const subscriptionId = crypto.randomUUID();
        const onEvent = (_electronEvent: unknown, envelope: unknown) => {
          if (!isRuntimeEventEnvelope(envelope) || envelope.subscriptionId !== subscriptionId)
            return;
          listener(envelope.event);
        };
        ipcRenderer.on(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
        const ready = ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.runtimeSubscribe, {
          subscriptionId,
          params,
        }) as Promise<DesktopResult<unknown>>;
        return Object.freeze({
          ready: ready as ReturnType<DesktopBridge["events"]["subscribe"]>["ready"],
          dispose() {
            ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.runtimeEvent, onEvent);
            ipcRenderer.send(DESKTOP_IPC_CHANNELS.runtimeUnsubscribe, { subscriptionId });
          },
        });
      },
    }),
    platform: Object.freeze({
      chooseWorkspace: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.chooseWorkspace),
      showNotification: (input: { readonly title: string; readonly body: string }) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.showNotification, input),
      openDirectory: (path: string) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.openDirectory, path),
      getLaunchAtLogin: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.getLaunchAtLogin),
      setLaunchAtLogin: (enabled: boolean) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setLaunchAtLogin, enabled),
    }),
    lifecycle: Object.freeze({
      setBackgroundMode: (enabled: boolean) =>
        ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.setBackgroundMode, enabled),
      quit: () => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.quit),
    }),
  });
}

interface RuntimeEventEnvelope {
  readonly subscriptionId: string;
  readonly event: RuntimeEvent;
}

function isRuntimeEventEnvelope(value: unknown): value is RuntimeEventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RuntimeEventEnvelope>;
  return (
    typeof candidate.subscriptionId === "string" &&
    typeof candidate.event === "object" &&
    candidate.event !== null
  );
}
