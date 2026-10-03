import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";
import * as protocol from "@pico/protocol/remote";
import type { RuntimeNotification } from "@pico/protocol/mobile";
import type { SavedHost } from "../../../apps/mobile/src/core.js";

type StoreView = {
  phase: string;
  connected: boolean;
  generation: number;
  syncRevision: number;
  host?: SavedHost;
  connect(host: SavedHost): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  requestWithSecrets(
    method: string,
    params: Record<string, unknown>,
    secrets: Record<string, unknown>,
  ): Promise<unknown>;
  onNotification(listener: (event: RuntimeNotification) => void): () => void;
};
type Cell = {
  value?: unknown;
  current?: unknown;
  deps?: unknown[];
  cleanup?: (() => void) | undefined;
};
function loadMobile(name: string, dependencies: Record<string, unknown>) {
  const source = new URL(`../../../apps/mobile/src/${name}`, import.meta.url);
  const compiled = transformSync(readFileSync(source, "utf8"), {
    loader: name.endsWith("tsx") ? "tsx" : "ts",
    format: "cjs",
    jsx: "transform",
  }).code;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    setTimeout,
    clearTimeout,
    URL,
    require(name: string) {
      if (!(name in dependencies)) throw new Error(`Unstubbed Provider dependency: ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const host = (id: string): SavedHost => ({
  id,
  name: id,
  baseUrl: `https://${id}.example.invalid`,
  gatewayId: id,
  deviceId: `${id}-device`,
});
const event = (id: string, at: number): RuntimeNotification => ({
  protocolVersion: 2,
  eventId: id,
  resourceVersion: at,
  at,
  topic: "session.settingsUpdated",
  scope: { workspacePath: "/fixture/project-a", sessionId: "session-a" },
  payload: {},
});

/** Drives the actual Provider through its public context and native AppState callbacks. */
function provider() {
  let cells: Cell[] = [],
    cursor = 0,
    dirty = false;
  let effects: Array<() => void> = [];
  const contexts = new Map<symbol, { value: unknown }>();
  const same = (a: unknown[] | undefined, b: unknown[]) =>
    a?.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    createContext(value: unknown) {
      const context = { Provider: Symbol("Provider"), value };
      contexts.set(context.Provider, context);
      return context;
    },
    useContext(context: { value: unknown }) {
      return context.value;
    },
    createElement(type: symbol, props: { value: unknown }) {
      const context = contexts.get(type);
      if (context) context.value = props.value;
      return { type, props };
    },
    useRef(value: unknown) {
      return (cells[cursor++] ??= { current: value });
    },
    useState(initial: unknown) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: initial };
      return [
        cells[i]!.value,
        (value: unknown) => {
          cells[i]!.value = typeof value === "function" ? value(cells[i]!.value) : value;
          dirty = true;
        },
      ];
    },
    useEffect(fn: () => (() => void) | undefined, deps: unknown[]) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i]!.deps, deps))
        effects.push(() => {
          cells[i]?.cleanup?.();
          cells[i] = { deps, cleanup: fn() };
        });
    },
  };
  let appListener: ((state: string) => void) | undefined;
  const storage = new Map<string, string>();
  const pairingCalls: string[] = [];
  const clients: Client[] = [];
  type Replay = { events: RuntimeNotification[] };
  type Subscription = { replay: Replay; dispose(): void };
  class Client {
    readonly subscriptions: Array<{
      listener: (event: RuntimeNotification) => void;
      pending: ReturnType<typeof deferred<Subscription>>;
      disposed: number;
      resolve(events: RuntimeNotification[]): void;
    }> = [];
    readonly requests: string[] = [];
    readonly foreground: boolean[] = [];
    closed = false;
    constructor(readonly options: { gatewayId: string; onState(state: string): void }) {
      clients.push(this);
    }
    static async submitPairing() {
      pairingCalls.push("submit");
      throw new Error("Unexpected pairing");
    }
    static async pairingStatus() {
      pairingCalls.push("status");
      throw new Error("Unexpected pairing");
    }
    static async acknowledgePairing() {
      pairingCalls.push("acknowledge");
      throw new Error("Unexpected pairing");
    }
    async connect() {
      this.options.onState("connected");
    }
    async capabilities() {
      return { methods: ["session.list"], permissions: ["session.read"] };
    }
    async workspaces() {
      return [{ id: "workspace-a", label: this.options.gatewayId }];
    }
    subscribeSessionFrames() {
      return () => {};
    }
    subscribe(_scope: unknown, listener: (event: RuntimeNotification) => void) {
      const pending = deferred<Subscription>();
      const subscription = {
        listener,
        pending,
        disposed: 0,
        resolve: (events: RuntimeNotification[]) =>
          pending.resolve({
            replay: { events },
            dispose: () => {
              subscription.disposed++;
            },
          }),
      };
      this.subscriptions.push(subscription);
      return pending.promise;
    }
    async request(method: string) {
      this.requests.push(method);
      return { sessions: [] };
    }
    setForeground(active: boolean) {
      this.foreground.push(active);
    }
    close() {
      this.closed = true;
    }
  }
  const exports = loadMobile("store.tsx", {
    react,
    "react-native": {
      Alert: { alert() {} },
      Platform: { OS: "ios" },
      AppState: {
        currentState: "active",
        addEventListener(_name: string, listener: typeof appListener) {
          appListener = listener;
          return {
            remove() {
              appListener = undefined;
            },
          };
        },
      },
    },
    "expo-secure-store": {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
      async getItemAsync(key: string) {
        return key.startsWith("pico.remote.") ? "fixture-token" : (storage.get(key) ?? null);
      },
      async setItemAsync(key: string, value: string) {
        storage.set(key, value);
      },
      async deleteItemAsync(key: string) {
        storage.delete(key);
      },
    },
    "@react-native-async-storage/async-storage": {
      async getItem() {
        return null;
      },
      async setItem() {},
    },
    "@pico/remote-client": { RemoteRuntimeClient: Client },
    "@pico/protocol/remote": protocol,
    "./core": loadMobile("core.ts", { "@pico/protocol/remote": protocol }),
    "./pairing": loadMobile("pairing.ts", {}),
    "./connection-errors": loadMobile("connection-errors.ts", {}),
    "./local-data": {
      clearHostLocalData() {
        throw new Error("Data cleanup is outside this sync scenario");
      },
    },
  });
  function render() {
    for (let count = 0; count < 20; count++) {
      cursor = 0;
      dirty = false;
      effects = [];
      (exports.PicoProvider as (props: unknown) => unknown)({ children: null });
      effects.forEach((effect) => effect());
      if (!dirty) return;
    }
    throw new Error("Provider failed to settle");
  }
  render();
  return {
    clients,
    pairingCalls,
    render,
    read: () => (exports.usePico as () => StoreView)(),
    app(state: string) {
      assert.ok(appListener);
      appListener(state);
      render();
    },
    async settle() {
      await delay(0);
      render();
    },
    dispose() {
      for (const cell of cells) cell.cleanup?.();
      cells = [];
    },
  };
}

test("Store 在可读阶段后恰一次交付首批 replay，自动恢复增加同步版本而不改变身份", async (t) => {
  const screen = provider();
  t.after(() => screen.dispose());
  await screen.settle();
  const delivered: Array<{ id: string; connected: boolean; revision: number }> = [];
  const consumerReads: Promise<unknown>[] = [];
  screen.read().onNotification((notification) => {
    const value = screen.read();
    delivered.push({
      id: notification.eventId,
      connected: value.connected,
      revision: value.syncRevision,
    });
    consumerReads.push(value.request("session.list", {}));
  });
  const connecting = screen.read().connect(host("computer-a"));
  await screen.settle();
  const client = screen.clients[0]!;
  const initial = client.subscriptions[0]!;
  assert.equal(screen.read().phase, "syncing");
  await assert.rejects(screen.read().request("session.list", {}), /正在同步/);
  const replay = event("initial-replay", 1);
  initial.resolve([replay]);
  await connecting;
  assert.equal(delivered.length, 0);
  screen.render();
  assert.equal(screen.read().connected, true);
  const generation = screen.read().generation;
  const revision = screen.read().syncRevision;
  await screen.settle();
  await Promise.all(consumerReads);
  assert.deepEqual(delivered, [{ id: "initial-replay", connected: true, revision }]);
  initial.listener(event("live-event", 2));
  assert.equal(delivered.at(-1)?.id, "live-event");

  client.options.onState("reconnecting");
  screen.render();
  assert.equal(screen.read().connected, false);
  initial.listener(event("obsolete-subscription", 3));
  client.options.onState("connected");
  await screen.settle();
  assert.equal(screen.read().phase, "syncing");
  const restored = client.subscriptions[1]!;
  // A newer in-flight resource notification wins over an older replay from the same resource.
  restored.listener(event("latest-buffered", 5));
  restored.resolve([event("older-replay", 4)]);
  await screen.settle();
  assert.equal(screen.read().generation, generation);
  assert.equal(screen.read().syncRevision, revision + 1);
  assert.equal(delivered.length, 2);
  await screen.settle();
  await Promise.all(consumerReads);
  assert.deepEqual(
    delivered.map((item) => item.id),
    ["initial-replay", "live-event", "latest-buffered"],
  );
  assert.ok(delivered.every((item) => item.connected));
  restored.listener(event("after-recovery", 6));
  await Promise.all(consumerReads);
  assert.equal(delivered.at(-1)?.id, "after-recovery");
  assert.deepEqual(screen.pairingCalls, []);
});

test("切换电脑及真实后台回调后，旧 subscribe 与待交付 replay 均不得复活", async (t) => {
  const screen = provider();
  t.after(() => screen.dispose());
  await screen.settle();
  const delivered: string[] = [];
  screen.read().onNotification((notification) => delivered.push(notification.eventId));
  const connectingA = screen.read().connect(host("computer-a"));
  await screen.settle();
  const clientA = screen.clients[0]!;
  const pendingA = clientA.subscriptions[0]!;
  const connectingB = screen.read().connect(host("computer-b"));
  await screen.settle();
  const clientB = screen.clients[1]!;
  pendingA.resolve([event("late-a-replay", 1)]);
  pendingA.listener(event("late-a-event", 2));
  await connectingA;
  assert.equal(pendingA.disposed, 1);
  assert.equal(clientA.closed, true);
  const pendingB = clientB.subscriptions[0]!;
  pendingB.resolve([event("b-replay-before-background", 3)]);
  await connectingB;
  screen.render(); // Connected commit schedules replay, then the real AppState callback cancels it.
  screen.app("background");
  pendingB.listener(event("background-event", 4));
  await screen.settle();
  assert.equal(screen.read().phase, "background");
  assert.equal(pendingB.disposed, 1);
  assert.equal(delivered.length, 0);
  const notExecuted = (error: unknown) =>
    error instanceof protocol.RemoteProtocolError && error.outcome === "not_executed";
  await assert.rejects(screen.read().request("session.list", {}), notExecuted);
  await assert.rejects(screen.read().requestWithSecrets("mcp.user.upsert", {}, {}), notExecuted);
  assert.equal(clientB.requests.length, 0);

  screen.app("active");
  await screen.settle();
  const recoveringB = clientB.subscriptions[1]!;
  screen.app("background"); // Also reject an old subscribe response arriving while backgrounded.
  recoveringB.resolve([event("late-background-replay", 5)]);
  recoveringB.listener(event("late-background-event", 6));
  await screen.settle();
  assert.equal(recoveringB.disposed, 1);
  assert.equal(delivered.length, 0);
  screen.app("active");
  await screen.settle();
  const currentB = clientB.subscriptions[2]!;
  currentB.resolve([event("current-b-replay", 7)]);
  await screen.settle();
  await screen.settle();
  assert.equal(screen.read().host?.id, "computer-b");
  assert.equal(screen.read().connected, true);
  assert.deepEqual(delivered, ["current-b-replay"]);
  currentB.listener(event("current-b-live", 8));
  assert.deepEqual(delivered, ["current-b-replay", "current-b-live"]);
  assert.deepEqual(screen.pairingCalls, []);
});
