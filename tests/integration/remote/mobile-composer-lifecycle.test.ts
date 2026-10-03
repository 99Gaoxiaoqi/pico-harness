import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { RemoteProtocolError, type RemoteParams } from "@pico/protocol/remote";
import { draftKey } from "../../../apps/mobile/src/conversation/draft.js";

type Props = {
  sessionId: string;
  sessionReady: boolean;
  activeRun: undefined;
  refreshTranscript: () => Promise<void>;
  onSession: (sessionId: string) => void;
};
type Composer = {
  text: string;
  setText: (text: string) => void;
  send: () => Promise<void>;
  frozen: boolean;
  sending: boolean;
  uncertain: boolean;
};
type Slot = { current?: unknown; value?: unknown; deps?: unknown[]; cleanup?: () => void };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

/** Render the real composer and repository with deterministic native/transport ports. */
async function fixture() {
  let hook!: (props: Props) => Composer;
  const rendering: { current?: Hooks } = {};
  class Hooks {
    slots: Slot[] = [];
    effects: (() => void)[] = [];
    cursor = 0;
    dirty = false;
    value!: Composer;
    constructor(public props: Props) {}
    flush() {
      let iterations = 0;
      do {
        this.dirty = false;
        rendering.current = this;
        this.cursor = 0;
        this.value = hook(this.props);
        for (const effect of this.effects.splice(0)) effect();
        assert.ok(++iterations < 30, "composer渲染不能循环");
      } while (this.dirty);
    }
    unmount() {
      for (const slot of this.slots) slot.cleanup?.();
    }
  }
  const storage = new Map<string, string>();
  const sends: {
    params: RemoteParams<"session.send">;
    response: ReturnType<typeof deferred<{ session: { sessionId: string } }>>;
  }[] = [];
  let sequence = 0;
  const native = {
    hooks: {
      useRef(value: unknown) {
        const renderer = rendering.current!;
        return (renderer.slots[renderer.cursor++] ??= { current: value });
      },
      useState(initial: unknown) {
        const renderer = rendering.current!;
        const index = renderer.cursor++;
        const slot = (renderer.slots[index] ??= {
          value: typeof initial === "function" ? (initial as () => unknown)() : initial,
        });
        return [
          slot.value,
          (update: unknown) => {
            slot.value =
              typeof update === "function"
                ? (update as (x: unknown) => unknown)(slot.value)
                : update;
            renderer.dirty = true;
          },
        ];
      },
      useEffect(effect: () => (() => void) | undefined, deps?: unknown[]) {
        const renderer = rendering.current!;
        const index = renderer.cursor++;
        const previous = renderer.slots[index];
        if (!previous || !deps || deps.some((x, i) => !Object.is(x, previous.deps?.[i]))) {
          const slot: Slot = { deps };
          renderer.slots[index] = slot;
          renderer.effects.push(() => {
            previous?.cleanup?.();
            slot.cleanup = effect();
          });
        }
      },
    },
    storage: {
      async getItem(key: string) {
        return storage.get(key) ?? null;
      },
      async setItem(key: string, value: string) {
        storage.set(key, value);
      },
      async removeItem(key: string) {
        storage.delete(key);
      },
    },
    crypto: {
      randomUUID() {
        return `composer-${++sequence}`;
      },
    },
    pico: {
      host: { id: "host" },
      workspace: { id: "workspace" },
      reason() {
        return undefined;
      },
      report() {},
      request(method: string, params: RemoteParams<"session.send">) {
        assert.equal(method, "session.send");
        const response = deferred<{ session: { sessionId: string } }>();
        sends.push({ params, response });
        return response.promise;
      },
    },
  };
  const port = `__picoComposerTest${Date.now()}${Math.random().toString().slice(2)}`;
  (globalThis as unknown as Record<string, unknown>)[port] = native;
  const prefix = `const fixture = globalThis[${JSON.stringify(port)}];`;
  const stubs = new Map([
    ["react", `${prefix} export const {useRef,useState,useEffect}=fixture.hooks;`],
    ["@react-native-async-storage/async-storage", `${prefix} export default fixture.storage;`],
    ["expo-crypto", `${prefix} export const {randomUUID}=fixture.crypto;`],
    [
      "expo-image-picker",
      "export const requestCameraPermissionsAsync=()=>{},launchCameraAsync=()=>{},launchImageLibraryAsync=()=>{};",
    ],
    ["expo-image-manipulator", "export const manipulateAsync=()=>{},SaveFormat={JPEG:'jpeg'};"],
    ["../store", `${prefix} export function usePico(){return fixture.pico;}`],
  ]);
  try {
    const bundle = await build({
      entryPoints: [
        fileURLToPath(
          new URL("../../../apps/mobile/src/conversation/useMessageComposer.ts", import.meta.url),
        ),
      ],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "native-ports",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) =>
              stubs.has(args.path) ? { path: args.path, namespace: "port" } : undefined,
            );
            builder.onLoad({ filter: /.*/, namespace: "port" }, (args) => ({
              contents: stubs.get(args.path)!,
              loader: "js",
            }));
          },
        },
      ],
    });
    ({ useMessageComposer: hook } = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
    ));
  } finally {
    delete (globalThis as unknown as Record<string, unknown>)[port];
  }
  const props = (sessionId: string): Props => ({
    sessionId,
    sessionReady: true,
    activeRun: undefined,
    refreshTranscript: async () => {},
    onSession() {},
  });
  const tick = async (renderer: Hooks) => {
    for (let i = 0; i < 30; ++i) {
      await Promise.resolve();
      if (renderer.dirty) renderer.flush();
    }
  };
  const mount = async (sessionId: string) => {
    const renderer = new Hooks(props(sessionId));
    renderer.flush();
    await tick(renderer);
    return renderer;
  };
  return { mount, props, tick, sends, storage };
}

test("手机 A-B-A 切换和重挂载共享发送锁，原 RPC 成功后当前输入自动清空解冻", async () => {
  const { mount, props, tick, sends, storage } = await fixture();
  const first = await mount("a");
  first.value.setText("切换时仍在发送的草稿");
  await tick(first);
  const sending = first.value.send();
  await tick(first);
  assert.equal(sends.length, 1);
  first.props = props("b");
  first.flush();
  await tick(first);
  first.props = props("a");
  first.flush();
  await tick(first);
  assert.equal(first.value.frozen, true);
  assert.equal(first.value.sending, true, "返回原会话仍能看到仓库中的活跃发送");
  await first.value.send();
  assert.equal(sends.length, 1, "A-B-A 不并行重试仍在进行的原 RPC");
  first.unmount();
  const current = await mount("a");
  assert.equal(current.value.sending, true);
  sends[0]!.response.resolve({ session: { sessionId: "a" } });
  await sending;
  await tick(current);
  assert.equal(current.value.text, "");
  assert.equal(current.value.frozen, false);
  assert.equal(current.value.sending, false);
  assert.equal(current.value.uncertain, false);
  assert.equal(
    storage.has(draftKey({ hostId: "host", workspaceId: "workspace", sessionId: "a" })),
    false,
  );
  current.unmount();
});

test("手机未知请求重试被拒绝时保留原 pending，导航恢复后仍只能确认原请求", async () => {
  const { mount, tick, sends, storage } = await fixture();
  const composer = await mount("unknown");
  composer.value.setText("原逻辑消息");
  await tick(composer);
  const first = composer.value.send();
  await tick(composer);
  const original = sends[0]!.params;
  sends[0]!.response.reject(new RemoteProtocolError("DISCONNECTED", "响应未知", true, "unknown"));
  await first;
  await tick(composer);
  const retry = composer.value.send();
  await tick(composer);
  assert.deepEqual(sends[1]!.params, original);
  sends[1]!.response.reject(
    new RemoteProtocolError("UNAUTHORIZED", "本次重试未执行", false, "not_executed"),
  );
  await retry;
  await tick(composer);
  assert.equal(composer.value.frozen, true);
  assert.equal(composer.value.uncertain, true);
  assert.equal(composer.value.text, "原逻辑消息");
  const key = draftKey({ hostId: "host", workspaceId: "workspace", sessionId: "unknown" });
  assert.deepEqual(JSON.parse(storage.get(key)!).draft.pending, original);
  composer.unmount();
  const restored = await mount("unknown");
  assert.equal(restored.value.frozen, true);
  assert.equal(restored.value.uncertain, true);
  const confirmed = restored.value.send();
  await tick(restored);
  assert.deepEqual(sends[2]!.params, original);
  sends[2]!.response.resolve({ session: { sessionId: "unknown" } });
  await confirmed;
  await tick(restored);
  assert.equal(restored.value.text, "");
  assert.equal(storage.has(key), false);
  restored.unmount();
});
