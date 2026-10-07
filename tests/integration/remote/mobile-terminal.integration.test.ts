import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { color, terminalTheme } from "../../../apps/mobile/src/palette.js";
import { TerminalOutputQueue } from "../../../apps/mobile/src/terminal-output.js";
import { terminalInputChunks } from "../../../apps/mobile/src/terminal-input.js";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const terminal = (epoch = "epoch-a", sequence = 1, status = "running") => ({
  terminalId: "terminal-a",
  resourceEpoch: epoch,
  sequence,
  status,
  controlAllowed: true,
  capability: "pty",
  resizeSupported: true,
});
const snapshot = (sequence: number, text: string, epoch = "epoch-a") => ({
  terminal: terminal(epoch, sequence),
  resourceEpoch: epoch,
  sequence,
  snapshot: text,
  truncated: false,
});
type Frame = Record<string, unknown>;
function fixture(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  capabilities = ["terminal-stream-v1"],
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const errors: unknown[] = [];
  const listeners: ((frame: Frame) => void)[] = [];
  const messages: Record<string, unknown>[] = [];
  let foreground!: (state: string) => void;
  let subscriptions = 0;
  let uuid = 0;
  let acknowledge = true;
  const listedTerminals = [terminal()];
  const pico = {
    generation: 1,
    syncRevision: 1,
    connected: true,
    client: {
      subscribeTerminalFrames(listener: (frame: Frame) => void) {
        subscriptions++;
        listeners.push(listener);
        return {
          dispose() {
            subscriptions--;
          },
        };
      },
    },
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "terminal.attach") assert.equal(subscriptions, 1, "先监听再挂接");
      if (method === "terminal.list") return { terminals: listedTerminals };
      if (method === "runtime.ping") return { capabilities };
      return request(method, params);
    },
    reason: () => undefined,
    report: (error: unknown) => errors.push(error),
    perform: async (task: () => Promise<unknown>) => {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    },
  };
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/Terminal.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Text", "View", "ScrollView"]),
        Alert: { alert() {} },
        AppState: {
          currentState: "active",
          addEventListener: (_: string, callback: (state: string) => void) => {
            foreground = callback;
            return { remove() {} };
          },
        },
      },
      "react-native-webview": { WebView: "WebView" },
      "expo-crypto": { randomUUID: () => `terminal-stream-${++uuid}` },
      "@pico/protocol/mobile": { TERMINAL_STREAM_RUNTIME_CAPABILITY: "terminal-stream-v1" },
      "./store": { usePico: () => pico },
      "./ui": { ...mobileTags(["Button", "Card", "Label"]), s: {}, color },
      "./palette": { terminalTheme },
      "./terminal-output": { TerminalOutputQueue },
      "./terminal-input": { terminalInputChunks },
      "./terminal.generated": { default: "<html>terminal</html>" },
    },
  );
  const render = () => screen.render("TerminalPanel", { sessionId: "session-a" });
  const message = (value: unknown) => {
    const webview = screen.nodes("WebView")[0]!;
    (webview.props.onMessage as (event: unknown) => void)({
      nativeEvent: { data: JSON.stringify(value) },
    });
  };
  const emit = (sequence: number, body: Frame = {}, listener = listeners.at(-1)!) =>
    listener({
      type: "terminal.event",
      terminalId: "terminal-a",
      sessionId: "session-a",
      resourceEpoch: "epoch-a",
      streamId: calls.filter((call) => call.method === "terminal.attach").at(-1)?.params.streamId,
      sequence,
      at: sequence,
      kind: "output",
      data: `output-${sequence}`,
      ...body,
    });
  async function mount() {
    render();
    await settleScreen();
    render();
    (
      screen.nodes("Button").find((node) => node.props.title === "terminal · running")!.props
        .onPress as () => void
    )();
    render();
    const webview = screen.nodes("WebView")[0]!;
    (webview.props.ref as { current: unknown }).current = {
      postMessage(data: string) {
        const value = JSON.parse(data);
        messages.push(value);
        if (value.type === "output" && acknowledge)
          queueMicrotask(() => message({ type: "written", id: value.id }));
      },
    };
    message({ type: "ready" });
    render();
    await settleScreen();
    render();
  }
  return {
    screen,
    pico,
    calls,
    errors,
    listeners,
    messages,
    render,
    message,
    emit,
    mount,
    listedTerminals,
    acknowledge: (value: boolean) => {
      acknowledge = value;
    },
    foreground: (state: string) => foreground(state),
  };
}

test("手机终端推送与初始快照连续消费，输出和状态共序号，缺口按需补齐", async (t) => {
  const first = deferred<ReturnType<typeof snapshot>>();
  const recovery = deferred<ReturnType<typeof snapshot>>();
  let attaches = 0;
  const f = fixture(async (method) =>
    method === "terminal.attach"
      ? ++attaches === 1
        ? first.promise
        : recovery.promise
      : { accepted: true },
  );
  t.after(() => f.screen.dispose());
  await f.mount();
  f.emit(2, { data: "\x1b[32mpushed\x1b[0m\r\n" });
  f.emit(3, { kind: "status", status: "exited", exitCode: 0 });
  first.resolve(snapshot(1, "initial\r\n"));
  await settleScreen();
  f.render();
  assert.deepEqual(
    f.messages.filter((value) => value.type === "output").map((value) => value.data),
    ["initial\r\n", "\x1b[32mpushed\x1b[0m\r\n"],
  );
  assert.ok(f.screen.nodes("Button").some((node) => node.props.title === "terminal · exited"));
  f.emit(2, { data: "duplicate" });
  f.emit(5, { data: "already in snapshot" });
  assert.equal(
    f.calls.filter((call) => call.method === "terminal.attach")[1]!.params.afterSequence,
    3,
  );
  recovery.resolve(snapshot(5, "gap recovered\r\n"));
  await settleScreen();
  f.render();
  f.emit(6, { data: "live after recovery\r\n" });
  await settleScreen();
  assert.deepEqual(
    f.messages.filter((value) => value.type === "output").map((value) => value.data),
    ["initial\r\n", "\x1b[32mpushed\x1b[0m\r\n", "gap recovered\r\n", "live after recovery\r\n"],
  );
  const paste = `${"中文🙂".repeat(8000)}\x1b[A\n`;
  f.message({ type: "input", data: paste });
  await settleScreen();
  const chunks = f.calls
    .filter((call) => call.method === "terminal.input")
    .map((call) => call.params.data as string);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), paste);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 64 * 1024));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(attaches, 2, "空闲期间不轮询attach");
  assert.equal(f.errors.length, 0);
  assert.equal(
    (f.screen.nodes("WebView")[0]!.props.style as { backgroundColor: string }).backgroundColor,
    color.bg,
  );
  assert.equal(f.messages.find((value) => value.type === "theme")!.theme instanceof Object, true);
});

test("原始按键串行传递，后台与epoch切换丢弃旧控制，未知输入不重发且持续阻断resize", async (t) => {
  const input = deferred<unknown>();
  let epoch = "epoch-a";
  const f = fixture(async (method) =>
    method === "terminal.attach"
      ? snapshot(1, "tail", epoch)
      : method === "terminal.input"
        ? input.promise
        : {},
  );
  t.after(() => f.screen.dispose());
  await f.mount();
  const raw = "中文粘贴\t\x1b[A\x03";
  f.message({ type: "input", data: raw });
  f.message({ type: "input", data: "must not replay" });
  f.message({ type: "resize", cols: 100, rows: 40 });
  await settleScreen();
  assert.deepEqual(
    f.calls.filter((call) => call.method === "terminal.input").map((call) => call.params.data),
    [raw],
  );
  f.foreground("background");
  f.message({ type: "input", data: "background" });
  f.message({ type: "resize", cols: 101, rows: 41 });
  f.render();
  input.reject(new Error("响应丢失"));
  await settleScreen();
  f.render();
  assert.ok(f.screen.nodes("Button").some((node) => node.props.title === "已检查输出，恢复输入"));
  f.foreground("active");
  f.render();
  await settleScreen();
  f.render();
  f.message({ type: "resize", cols: 102, rows: 42 });
  assert.equal(f.calls.filter((call) => call.method === "terminal.resize").length, 0);
  assert.equal(f.calls.filter((call) => call.method === "terminal.input").length, 1);
  epoch = "epoch-b";
  f.emit(1, { resourceEpoch: epoch, data: "new epoch" });
  await settleScreen();
  f.render();
  assert.equal(
    f.calls.filter((call) => call.method === "terminal.attach").at(-1)!.params.afterSequence,
    undefined,
  );
  const before = f.messages.length;
  f.emit(50, { data: "late old epoch" });
  assert.equal(f.messages.length, before);
  assert.ok(f.screen.nodes("Button").some((node) => node.props.title === "已检查输出，恢复输入"));
  (
    f.screen.nodes("Button").find((node) => node.props.title === "已检查输出，恢复输入")!.props
      .onPress as () => void
  )();
  f.render();
  await settleScreen();
  assert.equal(
    f.calls.filter((call) => call.method === "terminal.resize").length,
    1,
    "恢复输入后应用最近的屏幕尺寸",
  );
  assert.equal(f.calls.filter((call) => call.method === "terminal.input").length, 1);
  f.foreground("background");
  f.render();
  f.foreground("active");
  f.render();
  await settleScreen();
  f.render();
  const attachCount = f.calls.filter((call) => call.method === "terminal.attach").length;
  f.emit(51, { data: "old epoch after reconnect" });
  await settleScreen();
  f.render();
  assert.equal(f.calls.filter((call) => call.method === "terminal.attach").length, attachCount + 1);
  f.emit(2, { resourceEpoch: epoch, data: "current epoch remains live" });
  await settleScreen();
  assert.ok(
    f.messages.some(
      (value) => value.type === "output" && value.data === "current epoch remains live",
    ),
  );
});

test("旧Host明确提示升级重连，不挂接或退回轮询", async (t) => {
  const f = fixture(async () => ({}), []);
  t.after(() => f.screen.dispose());
  await f.mount();
  assert.equal(f.calls.filter((call) => call.method === "terminal.attach").length, 0);
  assert.ok(f.errors.some((error) => /更新电脑端并重新连接/.test(String(error))));
});

test("终端退出后立即只读，丢弃排队按键且不产生错误输入阻断", async (t) => {
  const inFlight = deferred<unknown>();
  const f = fixture(async (method) =>
    method === "terminal.attach" ? snapshot(1, "tail") : inFlight.promise,
  );
  t.after(() => f.screen.dispose());
  await f.mount();
  f.message({ type: "input", data: "in flight" });
  f.message({ type: "input", data: "queued before exit" });
  await settleScreen();
  f.emit(2, { kind: "status", status: "exited", exitCode: 0 });
  f.render();
  f.message({ type: "input", data: "after exit" });
  (
    f.screen.nodes("Button").find((node) => node.props.title === "↑")!.props.onPress as () => void
  )();
  assert.equal(
    f.screen.nodes("Button").find((node) => node.props.title === "键盘")!.props.reason,
    "终端进程未在运行",
  );
  assert.equal(f.messages.filter((message) => message.type === "readonly").at(-1)!.value, true);
  inFlight.reject(new Error("not_running"));
  await settleScreen();
  f.render();
  assert.deepEqual(
    f.calls.filter((call) => call.method === "terminal.input").map((call) => call.params.data),
    ["in flight"],
  );
  assert.equal(f.errors.length, 0);
  assert.equal(
    f.screen.nodes("Button").some((node) => node.props.title === "已检查输出，恢复输入"),
    false,
  );
});

test("重连时迟到列表不能回退已确认的退出状态或epoch", async (t) => {
  for (const epoch of ["epoch-a", "epoch-b"]) {
    let reconnecting = false;
    const f = fixture(async (method) =>
      method === "terminal.attach"
        ? {
            ...snapshot(reconnecting ? 2 : 1, "tail", reconnecting ? epoch : "epoch-a"),
            terminal: terminal(
              reconnecting ? epoch : "epoch-a",
              reconnecting ? 2 : 1,
              reconnecting ? "exited" : "running",
            ),
          }
        : {},
    );
    t.after(() => f.screen.dispose());
    await f.mount();
    const lateList = deferred<unknown>();
    const request = f.pico.request;
    f.pico.request = async (method, params) => {
      if (method === "terminal.list") {
        f.calls.push({ method, params });
        return lateList.promise;
      }
      return request(method, params);
    };
    reconnecting = true;
    f.pico.syncRevision++;
    f.render();
    await settleScreen();
    f.render();
    assert.equal(f.messages.filter((message) => message.type === "readonly").at(-1)!.value, true);
    lateList.resolve({ terminals: [terminal("epoch-a", 1, "running")] });
    await settleScreen();
    f.render();
    f.emit(2, { resourceEpoch: epoch, kind: "status", status: "exited", exitCode: 0 });
    f.message({ type: "input", data: "after stale list" });
    await settleScreen();
    f.render();
    assert.ok(f.screen.nodes("Button").some((node) => node.props.title === "terminal · exited"));
    assert.equal(
      f.screen.nodes("Button").find((node) => node.props.title === "键盘")!.props.reason,
      "终端进程未在运行",
    );
    assert.equal(f.messages.filter((message) => message.type === "readonly").at(-1)!.value, true);
    assert.equal(f.calls.filter((call) => call.method === "terminal.input").length, 0);
    assert.equal(f.errors.length, 0);
  }
});

test("输出溢出、epoch变化和序号缺口恢复期间关闭输入，连续快照恢复后重新开放", async (t) => {
  for (const recovery of ["overflow", "epoch", "gap"]) {
    const late = deferred<ReturnType<typeof snapshot>>();
    let attaches = 0;
    const f = fixture(async (method) =>
      method === "terminal.attach"
        ? ++attaches === 1
          ? snapshot(1, "initial")
          : late.promise
        : {},
    );
    t.after(() => f.screen.dispose());
    await f.mount();
    f.acknowledge(false);
    if (recovery === "overflow") {
      for (let sequence = 2; sequence <= 7; sequence++)
        f.emit(sequence, { data: "x".repeat(32 * 1024) });
    } else if (recovery === "epoch") {
      f.emit(1, { resourceEpoch: "epoch-b", data: "new epoch" });
    } else f.emit(3, { data: "after missing output" });
    assert.equal(f.messages.filter((message) => message.type === "readonly").at(-1)!.value, true);
    f.message({ type: "input", data: "during recovery" });
    await settleScreen();
    f.render();
    assert.equal(f.calls.filter((call) => call.method === "terminal.input").length, 0);
    const recoverySequence = recovery === "overflow" ? 7 : recovery === "gap" ? 3 : 1;
    late.resolve(
      snapshot(recoverySequence, "recovered", recovery === "epoch" ? "epoch-b" : "epoch-a"),
    );
    await settleScreen();
    f.render();
    assert.equal(f.messages.filter((message) => message.type === "readonly").at(-1)!.value, false);
    f.acknowledge(true);
    const stalled = f.messages.filter((message) => message.type === "output").at(-1)!;
    f.message({ type: "written", id: stalled.id });
    f.message({ type: "input", data: "after recovery" });
    await settleScreen();
    assert.deepEqual(
      f.calls.filter((call) => call.method === "terminal.input").map((call) => call.params.data),
      ["after recovery"],
    );
  }
});

test("手机终端输入以字节和请求数限制排队，保留在途输入且超限内容需手动恢复", async (t) => {
  for (const mode of ["bytes", "count"] as const) {
    const inFlight = deferred<unknown>();
    let inputs = 0;
    const f = fixture(async (method) =>
      method === "terminal.attach"
        ? snapshot(1, "tail")
        : method === "terminal.input" && ++inputs === 1
          ? inFlight.promise
          : {},
    );
    t.after(() => f.screen.dispose());
    await f.mount();
    const paste = "中🙂".repeat(80000);
    if (mode === "bytes") f.message({ type: "input", data: paste });
    else for (let i = 0; i < 200; i++) f.message({ type: "input", data: "x" });
    await settleScreen();
    f.render();
    const restore = () =>
      f.screen.nodes("Button").find((node) => node.props.title === "已检查输出，恢复输入")!;
    assert.equal(restore().props.reason, "等待已接纳的输入完成");
    (restore().props.onPress as () => void)();
    f.message({ type: "input", data: "while paused" });
    assert.equal(f.calls.filter((call) => call.method === "terminal.input").length, 1);
    assert.ok(f.errors.some((error) => /输入队列已满/.test(String(error))));
    inFlight.resolve({});
    await settleScreen();
    f.render();
    const accepted = f.calls
      .filter((call) => call.method === "terminal.input")
      .map((call) => call.params.data as string);
    if (mode === "bytes") {
      assert.equal(accepted.length, 4);
      assert.ok(Buffer.byteLength(accepted.join(""), "utf8") <= 256 * 1024);
      assert.ok(paste.startsWith(accepted.join("")) && accepted.join("").length < paste.length);
    } else assert.equal(accepted.length, 128);
    assert.equal(restore().props.reason, undefined);
    (restore().props.onPress as () => void)();
    f.render();
    f.message({ type: "input", data: "after checked" });
    await settleScreen();
    assert.equal(
      f.calls.filter((call) => call.method === "terminal.input").length,
      accepted.length + 1,
    );
    assert.equal(
      f.calls.filter((call) => call.method === "terminal.input").at(-1)!.params.data,
      "after checked",
    );
  }
});

test("WebView再次ready恢复完整尾部，显示订阅使用独立lease且旧lease不能影响新流", async (t) => {
  let sequence = 1;
  let tail = "initial";
  const f = fixture(async (method, params) => {
    if (method === "terminal.create") {
      const value = { ...terminal("epoch-b"), terminalId: "terminal-b" };
      f.listedTerminals.push(value);
      return { ...snapshot(1, "created", "epoch-b"), terminal: value };
    }
    if (method === "terminal.attach")
      return params.terminalId === "terminal-b"
        ? {
            ...snapshot(1, "terminal-b", "epoch-b"),
            terminal: { ...terminal("epoch-b"), terminalId: "terminal-b" },
          }
        : snapshot(sequence, params.afterSequence === undefined ? tail : "");
    return {};
  });
  t.after(() => f.screen.dispose());
  await f.mount();
  f.acknowledge(false);
  f.emit(2, { data: "stalled write" });
  f.emit(3, { data: "old queued output" });
  sequence = 3;
  tail = "reloaded full tail";
  f.acknowledge(true);
  f.message({ type: "ready" });
  await settleScreen();
  f.render();
  assert.equal(
    f.calls.filter((call) => call.method === "terminal.attach").at(-1)!.params.afterSequence,
    undefined,
  );
  assert.ok(
    f.messages.some(
      (message) => message.type === "output" && message.data === tail && message.reset === true,
    ),
  );
  assert.equal(
    f.messages.some((message) => message.type === "output" && message.data === "old queued output"),
    false,
  );
  assert.equal(f.messages.filter((message) => message.type === "theme").length, 2);
  assert.equal(f.messages.filter((message) => message.type === "readonly").at(-1)!.value, false);
  f.emit(4, { data: "after reload" });
  sequence = 4;
  await settleScreen();
  assert.ok(
    f.messages.some((message) => message.type === "output" && message.data === "after reload"),
  );
  const oldStream = f.calls.filter((call) => call.method === "terminal.attach").at(-1)!.params
    .streamId;
  f.foreground("background");
  f.render();
  f.foreground("active");
  f.render();
  await settleScreen();
  f.render();
  const newStream = f.calls.filter((call) => call.method === "terminal.attach").at(-1)!.params
    .streamId;
  assert.notEqual(newStream, oldStream);
  assert.ok(
    f.calls.some((call) => call.method === "terminal.detach" && call.params.streamId === oldStream),
  );
  f.emit(5, { streamId: oldStream, data: "old lease" });
  f.emit(5, { data: "new lease" });
  await settleScreen();
  assert.equal(
    f.messages.some((message) => message.type === "output" && message.data === "old lease"),
    false,
  );
  assert.ok(
    f.messages.some((message) => message.type === "output" && message.data === "new lease"),
  );
  (
    f.screen.nodes("Button").find((node) => node.props.title === "新建终端")!.props
      .onPress as () => void
  )();
  await settleScreen();
  f.render();
  await settleScreen();
  f.render();
  const creation = f.calls.find((call) => call.method === "terminal.create")!;
  const selected = f.calls
    .filter((call) => call.method === "terminal.attach" && call.params.terminalId === "terminal-b")
    .at(-1)!;
  assert.notEqual(creation.params.streamId, selected.params.streamId);
  assert.ok(
    f.calls.some(
      (call) =>
        call.method === "terminal.detach" &&
        call.params.terminalId === "terminal-b" &&
        call.params.streamId === creation.params.streamId,
    ),
  );
  assert.equal(
    f.calls.some((call) => call.method === "terminal.stop"),
    false,
  );
});

test("detach早于挂接响应时释放迟到旧lease，保留新显示订阅", async (t) => {
  const late = deferred<ReturnType<typeof snapshot>>();
  const leases = new Set<unknown>();
  let attaches = 0;
  const f = fixture(async (method, params) => {
    if (method === "terminal.attach") {
      const result = ++attaches === 1 ? await late.promise : snapshot(2, "current display");
      leases.add(params.streamId);
      return result;
    }
    if (method === "terminal.detach") leases.delete(params.streamId);
    return {};
  });
  t.after(() => f.screen.dispose());
  await f.mount();
  const oldStream = f.calls.find((call) => call.method === "terminal.attach")!.params.streamId;
  f.foreground("background");
  f.render();
  assert.equal(
    f.calls.filter(
      (call) => call.method === "terminal.detach" && call.params.streamId === oldStream,
    ).length,
    1,
  );
  assert.equal(leases.has(oldStream), false, "早期detach尚无已登记显示scope");
  f.foreground("active");
  f.render();
  await settleScreen();
  f.render();
  const newStream = f.calls.filter((call) => call.method === "terminal.attach").at(-1)!.params
    .streamId;
  assert.notEqual(newStream, oldStream);
  late.resolve(snapshot(1, "late display must not appear", "epoch-late"));
  await settleScreen();
  f.render();
  const detach = f.calls.filter(
    (call) => call.method === "terminal.detach" && call.params.streamId === oldStream,
  );
  assert.equal(detach.length, 2);
  assert.equal(detach[1]!.params.terminalId, "terminal-a");
  assert.equal(detach[1]!.params.resourceEpoch, "epoch-late");
  assert.deepEqual([...leases], [newStream]);
  assert.equal(
    f.messages.some(
      (message) => message.type === "output" && message.data === "late display must not appear",
    ),
    false,
  );
  f.emit(3, { data: "new display still live" });
  await settleScreen();
  assert.ok(
    f.messages.some(
      (message) => message.type === "output" && message.data === "new display still live",
    ),
  );
  assert.equal(f.errors.length, 0);
});

test("终端WebView使用应用色板，主题热更新保留会话，写入回调串行且队列有界", () => {
  const sent: Record<string, unknown>[] = [];
  const writes: { data: string; callback: () => void }[] = [];
  const styles = new Map<string, string>();
  let receive!: (event: { data: string }) => void;
  let dataListener!: (data: string) => void;
  let reset = 0;
  let instances = 0;
  let options!: { theme: typeof terminalTheme; disableStdin: boolean };
  class Terminal {
    constructor(value: typeof options) {
      instances++;
      options = value;
    }
    get options() {
      return options;
    }
    loadAddon() {}
    open() {}
    focus() {}
    reset() {
      reset++;
    }
    onData(listener: typeof dataListener) {
      dataListener = listener;
    }
    onResize() {}
    input(data: string) {
      dataListener(data);
    }
    write(data: string, callback: () => void) {
      writes.push({ data, callback });
    }
  }
  const compiled = transformSync(
    readFileSync(new URL("../../../apps/mobile/src/terminal-web.ts", import.meta.url), "utf8"),
    {
      loader: "ts",
      format: "cjs",
    },
  ).code;
  vm.runInNewContext(compiled, {
    require: (name: string) =>
      name === "@xterm/xterm"
        ? { Terminal }
        : name === "@xterm/addon-fit"
          ? {
              FitAddon: class {
                fit() {}
              },
            }
          : { terminalTheme },
    window: {
      ReactNativeWebView: { postMessage: (data: string) => sent.push(JSON.parse(data)) },
      addEventListener: (_: string, fn: typeof receive) => {
        receive = fn;
      },
    },
    document: {
      getElementById: () => ({}),
      body: {},
      addEventListener() {},
      documentElement: {
        style: { setProperty: (key: string, value: string) => styles.set(key, value) },
      },
    },
    ResizeObserver: class {
      observe() {}
    },
  });
  const message = (value: unknown) => receive({ data: JSON.stringify(value) });
  assert.deepEqual(options.theme, terminalTheme);
  assert.equal(
    Object.keys(terminalTheme).filter(
      (key) =>
        /^(bright)?(Black|Red|Green|Yellow|Blue|Magenta|Cyan|White)$/.test(key) ||
        /^(black|red|green|yellow|blue|magenta|cyan|white)$/.test(key),
    ).length,
    16,
  );
  message({ type: "output", id: 1, data: "initial", reset: true });
  message({ type: "output", id: 2, data: "\x1b[31mnext\x1b[0m" });
  assert.equal(writes.length, 1);
  message({ type: "theme", theme: { ...terminalTheme, cursor: color.accentStrong } });
  assert.equal(instances, 1);
  assert.equal(reset, 1);
  assert.equal(options.theme.cursor, color.accentStrong);
  assert.equal(styles.get("--terminal-bg"), color.bg);
  writes[0]!.callback();
  assert.equal(writes.length, 2);
  assert.deepEqual(
    sent.find((value) => value.type === "written"),
    { type: "written", id: 1 },
  );
  message({ type: "output", id: 3, data: "x".repeat(128 * 1024 + 1) });
  assert.ok(sent.some((value) => value.type === "overflow"));
  message({ type: "key", data: "\x1b[A中文" });
  assert.deepEqual(sent.at(-1), { type: "input", data: "\x1b[A中文" });
  const bridge: Record<string, unknown>[] = [];
  const queue = new TerminalOutputQueue((value) => bridge.push(value));
  assert.equal(queue.push("x".repeat(128 * 1024 + 1)), false);
  assert.equal(bridge.length, 0);
  queue.push("tail", true);
  queue.ready(true);
  queue.push("second");
  assert.equal(bridge.length, 1);
  queue.written(bridge[0]!.id as number);
  assert.equal(bridge.length, 2);
});
