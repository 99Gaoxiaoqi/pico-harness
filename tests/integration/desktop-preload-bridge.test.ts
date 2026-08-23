import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IpcRenderer } from "electron";
import { createDesktopBridge } from "../../apps/desktop/src/preload/bridge.js";
import { DESKTOP_IPC_CHANNELS } from "../../apps/desktop/src/preload/contract.js";

test("Desktop preload releases a failed Runtime subscription", async () => {
  const ipc = new EventEmitter() as EventEmitter & {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
  };
  const sent: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];
  ipc.invoke = async (channel) => {
    assert.equal(channel, DESKTOP_IPC_CHANNELS.runtimeSubscribe);
    throw new Error("main process unavailable");
  };
  ipc.send = (channel, ...args) => sent.push({ channel, args });
  const bridge = createDesktopBridge(ipc as unknown as IpcRenderer);

  const subscription = bridge.events.subscribe({ workspacePath: "/workspace" }, () => undefined);
  const ready = await subscription.ready;

  assert.equal(ready.ok, false);
  assert.match(ready.ok ? "" : ready.error.message, /main process unavailable/u);
  assert.equal(ipc.listenerCount(DESKTOP_IPC_CHANNELS.runtimeEvent), 0);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every(({ channel }) => channel === DESKTOP_IPC_CHANNELS.runtimeUnsubscribe));
  assert.ok(
    sent.every(({ args }) => {
      const envelope = args[0] as { readonly subscriptionId?: unknown } | undefined;
      return typeof envelope?.subscriptionId === "string";
    }),
  );
});

test("Desktop preload releases a Runtime subscription that resolves with failure", async () => {
  const ipc = new EventEmitter() as EventEmitter & {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
  };
  const sent: string[] = [];
  ipc.invoke = async () => ({
    ok: false,
    error: { code: "conflict", message: "subscription refused", retryable: false },
  });
  ipc.send = (channel) => sent.push(channel);
  const bridge = createDesktopBridge(ipc as unknown as IpcRenderer);

  const ready = await bridge.events.subscribe({ workspacePath: "/workspace" }, () => undefined)
    .ready;

  assert.equal(ready.ok, false);
  assert.equal(ipc.listenerCount(DESKTOP_IPC_CHANNELS.runtimeEvent), 0);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((channel) => channel === DESKTOP_IPC_CHANNELS.runtimeUnsubscribe));
});

test("Desktop preload exposes Main-owned Browser viewport generations and page clear", async () => {
  const ipc = new EventEmitter() as EventEmitter & {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
  };
  const calls: Array<{ readonly channel: string; readonly args: readonly unknown[] }> = [];
  ipc.invoke = async (channel, ...args) => {
    calls.push({ channel, args });
    return channel === DESKTOP_IPC_CHANNELS.browserAcquireViewport
      ? { ok: true, value: 9 }
      : {
          ok: true,
          value: {
            sessionId: "session-a",
            url: "",
            title: "",
            canGoBack: false,
            canGoForward: false,
            loading: false,
            secure: false,
            hasPage: false,
            visible: true,
            generation: 9,
          },
        };
  };
  ipc.send = () => undefined;
  const bridge = createDesktopBridge(ipc as unknown as IpcRenderer);

  assert.deepEqual(await bridge.browser.acquireViewport("session-a"), { ok: true, value: 9 });
  const cleared = await bridge.browser.clearPage("session-a");
  assert.equal(cleared.ok && cleared.value.visible, true);
  assert.deepEqual(calls, [
    { channel: DESKTOP_IPC_CHANNELS.browserAcquireViewport, args: ["session-a", undefined] },
    { channel: DESKTOP_IPC_CHANNELS.browserClearPage, args: ["session-a", undefined] },
  ]);
});
