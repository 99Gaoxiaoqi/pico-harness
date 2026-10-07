import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";
import * as management from "../../../apps/mobile/src/settings/management.js";
import { terminalTheme } from "../../../apps/mobile/src/palette.js";
import { TerminalOutputQueue } from "../../../apps/mobile/src/terminal-output.js";
import { terminalInputChunks } from "../../../apps/mobile/src/terminal-input.js";

const ui = {
  ...mobileTags(["Button", "Card", "Chips", "Detail", "Field", "Label"]),
  s: {},
  color: {},
};
const native = {
  ...mobileTags(["Text", "View", "Switch", "Pressable", "ScrollView"]),
  Alert: { alert() {} },
};
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function store(request: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const errors: unknown[] = [];
  const pico = {
    generation: 1,
    syncRevision: 1,
    connected: true,
    workspace: { id: "workspace-a", label: "项目 A" },
    workspaces: [{ id: "workspace-a", label: "项目 A" }],
    request,
    requestWithSecrets: request,
    reason: (_method: string) => (pico.connected ? undefined : "电脑尚未连接"),
    perform: async (task: () => Promise<unknown>) => {
      try {
        await task();
      } catch (error) {
        errors.push(error);
      }
    },
    report: (error: unknown) => errors.push(error),
    onNotification: (_listener: unknown) => () => {},
  };
  return { pico, errors };
}
function modules(pico: unknown) {
  return {
    "react-native": native,
    "expo-crypto": { randomUUID: () => "page-refresh-fixture" },
    "../store": { usePico: () => pico },
    "../ui": ui,
    "./SettingsNavigation": { Choices: "Choices" },
    "./management": management,
    "./confirmDelete": { confirmDelete() {} },
  };
}
function button(screen: ReturnType<typeof mobileComponent>, title: string) {
  const node = screen.nodes("Button").find((node) => node.props.title === title);
  assert.ok(node, `Missing button: ${title}`);
  return node;
}

// One peer changes while mounted consumers remain open, without a page remount.
test("手机恢复后读取结束任务与最新设置，保留编辑草稿和原保存版本", async (t) => {
  let running = true;
  let model = "old-model";
  let revision = "old-revision";
  let writes = 0;
  let expectedRevision: unknown;
  const reads: string[] = [];
  const { pico, errors } = store(async (method, params) => {
    reads.push(method);
    if (method === "session.settings.get" || method === "session.settings.update") {
      if (method.endsWith("update")) writes++;
      return {
        settings: {
          model,
          provider: "fixture",
          modelRouteId: `fixture/${model}`,
          collaborationMode: params.collaborationMode ?? "agent",
          reasoningLevels: [],
        },
      };
    }
    if (method === "runs.list")
      return { runs: [{ runId: "run-a", status: running ? "running" : "succeeded" }] };
    if (method === "catalog.models")
      return { routes: [{ id: `fixture/${model}`, model, providerId: "fixture" }] };
    if (method === "goal.get") return { goal: null };
    if (method === "jobs.list")
      return {
        jobs: [
          {
            jobId: "job-a",
            name: "夜间任务",
            prompt: "fixture",
            schedule: "0 9 * * *",
            enabled: false,
            status: running ? "running" : "succeeded",
          },
        ],
      };
    if (method === "jobs.history")
      return {
        runs: [
          {
            runId: "job-run-a",
            description: "自动任务",
            status: running ? "running" : "succeeded",
          },
        ],
      };
    if (method === "config.user.get")
      return {
        config: {
          defaults: {
            thinkingEffort: model === "old-model" ? "high" : "low",
            webSearch: { enabled: false, source: "model" },
          },
        },
        revision,
      };
    if (method === "provider.list") return { providers: [] };
    expectedRevision = params.expectedRevision;
    throw new Error("配置版本冲突，请刷新后重新编辑");
  });
  const session = mobileComponent(
    new URL("../../../apps/mobile/src/settings/SessionSettings.tsx", import.meta.url),
    { ...modules(pico), "../ActionsSheet": { ActionsSheet: "ActionsSheet" } },
  );
  const defaults = mobileComponent(
    new URL("../../../apps/mobile/src/settings/Defaults.tsx", import.meta.url),
    modules(pico),
  );
  const actions = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/SessionActions.tsx", import.meta.url),
    modules(pico),
  );
  const jobs = mobileComponent(
    new URL("../../../apps/mobile/src/settings/Jobs.tsx", import.meta.url),
    modules(pico),
  );
  t.after(() => {
    session.dispose();
    defaults.dispose();
    actions.dispose();
    jobs.dispose();
  });
  const render = () => {
    session.render("SessionSettings", { sessionId: "session-a" });
    defaults.render("Defaults");
    actions.render("SessionActions", {
      sessionId: "session-a",
      idle: !running,
      onSession() {},
      onClose() {},
    });
    jobs.render("Jobs");
  };
  render();
  await settleScreen();
  render();
  assert.equal(session.nodes("Chips")[0]!.props.disabled, true);
  (button(jobs, "历史").props.onPress as () => void)();
  await settleScreen();
  render();
  (defaults.nodes("Switch")[0]!.props.onValueChange as (value: boolean) => void)(true);
  (actions.nodes("Field")[0]!.props.onChange as (value: string) => void)("保留这个目标草稿");
  render();
  pico.connected = false;
  render();
  const offlineReads = reads.length;
  await settleScreen();
  assert.equal(reads.length, offlineReads);
  running = false;
  model = "new-model";
  revision = "new-revision";
  pico.connected = true;
  pico.syncRevision++;
  render();
  await settleScreen();
  render();
  assert.equal(button(session, "new-model · fixture ▾").props.reason, undefined);
  assert.equal(session.nodes("Chips")[0]!.props.disabled, false);
  assert.equal(defaults.nodes("Switch")[0]!.props.value, true);
  assert.equal(defaults.nodes("Chips")[0]!.props.value, "high");
  assert.equal(actions.nodes("Field")[0]!.props.value, "保留这个目标草稿");
  assert.ok(jobs.nodes("Label").some((node) => node.props.children?.toString() === "succeeded"));
  (session.nodes("Chips")[0]!.props.onChange as (value: string) => void)("plan");
  await settleScreen();
  render();
  assert.equal(writes, 1);
  (button(defaults, "保存默认行为").props.onPress as () => void)();
  await settleScreen();
  render();
  assert.equal(expectedRevision, "old-revision");
  assert.equal(errors.length, 1);
  assert.equal(defaults.nodes("Switch")[0]!.props.value, true);
});

test("页面恢复读取不能被断线前或前一台电脑的迟到响应覆盖", async (t) => {
  const reads: ReturnType<typeof deferred>[] = [];
  const { pico } = store(async () => {
    const read = deferred();
    reads.push(read);
    return read.promise;
  });
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/settings/Providers.tsx", import.meta.url),
    modules(pico),
  );
  t.after(() => screen.dispose());
  const render = () => screen.render("Providers");
  const result = (id: string) => ({
    revision: id,
    providers: [
      {
        id,
        protocol: "openai",
        baseURL: "https://example.invalid",
        apiKeyEnv: "API_KEY",
        models: [],
        discoverModels: false,
      },
    ],
  });
  render();
  pico.connected = false;
  render();
  pico.connected = true;
  pico.syncRevision++;
  render();
  reads[1]!.resolve(result("new-a"));
  await settleScreen();
  render();
  reads[0]!.resolve(result("old-a"));
  await settleScreen();
  render();
  assert.ok(screen.nodes("Text").some((node) => node.props.children?.toString().includes("new-a")));
  assert.equal(
    screen.nodes("Text").some((node) => node.props.children?.toString().includes("old-a")),
    false,
  );
  (button(screen, "编辑").props.onPress as () => void)();
  render();
  (screen.nodes("Field")[0]!.props.onChange as (value: string) => void)(
    "https://draft.example.invalid",
  );
  render();
  pico.syncRevision++;
  render(); // Recovery A is still in flight when identity changes.
  pico.generation++;
  pico.syncRevision++;
  render();
  reads[3]!.resolve(result("computer-b"));
  await settleScreen();
  render();
  reads[2]!.resolve(result("late-computer-a"));
  await settleScreen();
  render();
  assert.ok(
    screen.nodes("Text").some((node) => node.props.children?.toString().includes("computer-b")),
  );
  assert.equal(
    screen
      .nodes("Text")
      .some((node) => node.props.children?.toString().includes("late-computer-a")),
    false,
  );
  assert.equal(screen.nodes("Field").length, 0);
});

test("终端恢复仅刷新和挂接显示，未知输入继续暂停且不重发", async (t) => {
  const input = deferred();
  const calls: string[] = [];
  let status = "running";
  const terminal = () => ({
    terminalId: "terminal-a",
    resourceEpoch: "epoch-a",
    status,
    controlAllowed: true,
    capability: "pty",
    resizeSupported: true,
  });
  const { pico } = store(async (method) => {
    calls.push(method);
    if (method === "terminal.list") return { terminals: [terminal()] };
    if (method === "runtime.ping") return { capabilities: ["terminal-stream-v1"] };
    if (method === "terminal.attach")
      return {
        terminal: terminal(),
        resourceEpoch: "epoch-a",
        sequence: calls.length,
        snapshot: "latest output",
        truncated: false,
      };
    if (method === "terminal.input") return input.promise;
    return {};
  });
  Object.assign(pico, { client: { subscribeTerminalFrames: () => ({ dispose() {} }) } });
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/Terminal.tsx", import.meta.url),
    {
      "react-native": {
        ...native,
        AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
      },
      "react-native-webview": { WebView: "WebView" },
      "@pico/protocol/mobile": { TERMINAL_STREAM_RUNTIME_CAPABILITY: "terminal-stream-v1" },
      "./store": { usePico: () => pico },
      "./ui": ui,
      "./palette": { terminalTheme },
      "./terminal-output": { TerminalOutputQueue },
      "./terminal-input": { terminalInputChunks },
      "./terminal.generated": { default: "<html></html>" },
    },
  );
  t.after(() => screen.dispose());
  const render = () => screen.render("TerminalPanel", { sessionId: "session-a" });
  render();
  await settleScreen();
  render();
  (button(screen, "terminal · running").props.onPress as () => void)();
  render();
  await settleScreen();
  render();
  (screen.nodes("WebView")[0]!.props.onMessage as (event: unknown) => void)({
    nativeEvent: { data: JSON.stringify({ type: "input", data: "run command\n" }) },
  });
  await settleScreen();
  pico.connected = false;
  render();
  input.reject(new Error("响应丢失"));
  await settleScreen();
  render();
  assert.ok(button(screen, "已检查输出，恢复输入"));
  status = "exited";
  pico.connected = true;
  pico.syncRevision++;
  render();
  await settleScreen();
  render();
  assert.ok(button(screen, "terminal · exited"));
  assert.ok(button(screen, "已检查输出，恢复输入"));
  assert.equal(calls.filter((method) => method === "terminal.input").length, 1);
  assert.equal(calls.filter((method) => method === "terminal.create").length, 0);
  assert.ok(calls.filter((method) => method === "terminal.attach").length >= 2);
});
