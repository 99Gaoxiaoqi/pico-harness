import { describe, expect, it, vi } from "vitest";
import type { IpcRenderer } from "electron";
import { createDesktopBridge } from "./bridge.js";
import { DESKTOP_IPC_CHANNELS, DESKTOP_RUNTIME_METHODS } from "./contract.js";

function createIpcRendererMock() {
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  return {
    invoke: vi.fn().mockResolvedValue({
      ok: true,
      value: { subscribed: true, events: [] },
    }),
    on: vi.fn((channel: string, listener: (...args: readonly unknown[]) => void) => {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: readonly unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
    send: vi.fn(),
    emit(channel: string, ...args: readonly unknown[]) {
      for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
    },
  };
}

describe("createDesktopBridge", () => {
  it("only exposes fixed runtime methods and never exposes ipcRenderer", () => {
    const mock = createIpcRendererMock();
    const bridge = createDesktopBridge(mock as unknown as IpcRenderer);

    expect(Object.keys(bridge.runtime)).toEqual(DESKTOP_RUNTIME_METHODS);
    expect("invoke" in bridge).toBe(false);
    expect("ipcRenderer" in bridge).toBe(false);
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.isFrozen(bridge.runtime)).toBe(true);
  });

  it("binds every runtime call to its allowlisted method", async () => {
    const mock = createIpcRendererMock();
    const bridge = createDesktopBridge(mock as unknown as IpcRenderer);

    await bridge.runtime["runtime.ping"]({});
    await bridge.runtime["diagnostics.run"]({ workspacePath: "/workspace" });
    await bridge.runtime["session.rename"]({
      workspacePath: "/workspace",
      sessionId: "session-1",
      title: "Renamed",
    });
    await bridge.runtime["session.settings.update"]({
      workspacePath: "/workspace",
      sessionId: "session-1",
      permissions: "plan",
    });

    expect(mock.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.runtimeInvoke, {
      method: "runtime.ping",
      params: {},
    });
    expect(mock.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.runtimeInvoke, {
      method: "diagnostics.run",
      params: { workspacePath: "/workspace" },
    });
    expect(mock.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.runtimeInvoke, {
      method: "session.rename",
      params: { workspacePath: "/workspace", sessionId: "session-1", title: "Renamed" },
    });
    expect(mock.invoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.runtimeInvoke, {
      method: "session.settings.update",
      params: { workspacePath: "/workspace", sessionId: "session-1", permissions: "plan" },
    });
  });

  it("removes event listeners and notifies main on dispose", () => {
    const mock = createIpcRendererMock();
    const bridge = createDesktopBridge(mock as unknown as IpcRenderer);
    const listener = vi.fn();

    const subscription = bridge.events.subscribe({}, listener);
    subscription.dispose();

    expect(mock.removeListener).toHaveBeenCalledOnce();
    expect(mock.send).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.runtimeUnsubscribe,
      expect.objectContaining({ subscriptionId: expect.any(String) }),
    );
  });

  it("delivers replay before buffered live events and removes duplicates", async () => {
    const mock = createIpcRendererMock();
    let resolveReady: ((value: unknown) => void) | undefined;
    mock.invoke.mockImplementationOnce(() => new Promise((resolve) => (resolveReady = resolve)));
    const bridge = createDesktopBridge(mock as unknown as IpcRenderer);
    const received: string[] = [];
    const event = (eventId: string, resourceVersion: number) => ({
      protocolVersion: 1 as const,
      eventId,
      topic: "run.timeline" as const,
      scope: { workspacePath: "/workspace" },
      resourceVersion,
      at: resourceVersion,
      payload: {},
    });

    const subscription = bridge.events.subscribe({}, (value) => received.push(value.eventId));
    const subscriptionId = (mock.invoke.mock.calls[0]?.[1] as { readonly subscriptionId: string })
      .subscriptionId;
    mock.emit(DESKTOP_IPC_CHANNELS.runtimeEvent, {
      subscriptionId,
      event: event("live", 2),
    });
    resolveReady?.({
      ok: true,
      value: { subscribed: true, events: [event("replay", 1), event("live", 2)] },
    });

    await subscription.ready;
    expect(received).toEqual(["replay", "live"]);
  });
});
