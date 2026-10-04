import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalRunStatus } from "@pico/protocol/mobile";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";
import { modelChoices, saveUserDefaults } from "../../../apps/mobile/src/settings/management.js";
import { transcriptRows } from "../../../apps/mobile/src/conversation/transcriptRows.js";

const ui = {
  ...mobileTags(["Button", "Card", "Chips", "Detail", "Field", "Label"]),
  s: {},
  color: {},
};
test("手机任务结束后解除执行入口与空闲操作限制，发送不携带已结束的 Run", (t) => {
  const terminalRun = { runId: "finished-run", status: "succeeded" };
  let composerRun: unknown;
  const records: Array<{ itemId: string; item: unknown }> = [];
  const jumps: string[] = [];
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/Conversation.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags([
          "FlatList",
          "Image",
          "KeyboardAvoidingView",
          "Pressable",
          "Text",
          "TextInput",
          "View",
        ]),
        StyleSheet: { create: (value: unknown) => value },
        Platform: { OS: "ios" },
        Keyboard: { dismiss() {} },
        Alert: { alert() {} },
      },
      "expo-crypto": {},
      "@pico/protocol/mobile": { isTerminalRunStatus },
      "./store": { usePico: () => ({ reason: () => undefined }) },
      "./core": {},
      "./ui": ui,
      "./ActionsSheet": { ActionsSheet: "ActionsSheet" },
      "./conversation/useSessionTranscript": {
        useSessionTranscript: () => ({
          view: { records, queuedInputs: [], activeOverlay: [], activeRun: terminalRun },
          sessionReady: true,
        }),
      },
      "./conversation/useMessageComposer": {
        useMessageComposer: (input: { activeRun?: unknown }) => {
          composerRun = input.activeRun;
          return { text: "", images: [], selectedSkills: [], mode: "auto", draftReady: true };
        },
      },
      "./conversation/useTranscriptViewport": {
        useTranscriptViewport: () => ({ jumpToItem: (itemId: string) => jumps.push(itemId) }),
      },
      "./conversation/transcriptRows": { transcriptRows },
      "./conversation/ComposerOptions": mobileTags(["ComposerOptions", "ComposerReferences"]),
      "./conversation/SessionActions": { SessionActions: "SessionActions" },
      "./conversation/TranscriptItem": mobileTags([
        "TranscriptItem",
        "ProcessGroup",
        "StreamingItem",
        "PlanCard",
      ]),
    },
  );
  t.after(() => screen.dispose());
  const render = () => screen.render("Conversation", { active: true, sessionId: "A" });
  render();
  assert.equal(composerRun, undefined);
  assert.equal(
    screen.nodes("Button").some((node) => node.props.title === "停止"),
    false,
  );
  const sessionActions = () => {
    const menu = (
      screen.nodes("ComposerOptions")[0]!.props.sessionMenu as (close: () => void) => {
        props: { children: Array<{ type: unknown; props: Record<string, unknown> }> };
      }
    )(() => {});
    return menu.props.children.find((node) => node.type === "SessionActions")!;
  };
  assert.equal(sessionActions().props.idle, true);
  terminalRun.status = "running";
  render();
  assert.equal(composerRun, terminalRun);
  assert.equal(
    screen.nodes("Button").some((node) => node.props.title === "停止"),
    true,
  );
  assert.equal(sessionActions().props.idle, false);
  records.push({
    itemId: "pending-approval",
    item: { kind: "approval", state: "waiting", data: { kind: "tool" } },
  });
  render();
  const jump = screen
    .nodes("Pressable")
    .find((node) => node.props.accessibilityLabel === "查看待批准请求");
  assert.ok(jump);
  (jump.props.onPress as () => void)();
  assert.deepEqual(jumps, ["pending-approval"]);
  assert.equal(screen.nodes("ActionsSheet")[0]!.props.open, false);
  records[0]!.item = { kind: "prompt", state: "waiting" };
  render();
  assert.ok(
    screen.nodes("Pressable").find((node) => node.props.accessibilityLabel === "查看待回答问题"),
  );
});
test("极简输入选项可打开会话操作和发送方式，返回不丢草稿", (t) => {
  const composer = {
    text: "继续优化当前页面",
    mode: "auto",
    selectedSkills: [],
    images: [],
    setMode: (value: string) => {
      composer.mode = value;
    },
  };
  let settingsOpened = 0;
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/ComposerOptions.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Pressable", "Text", "View"]),
        StyleSheet: { create: (value: unknown) => value },
        Keyboard: { dismiss() {} },
      },
      "../store": { usePico: () => ({ reason: () => undefined }) },
      "../ui": ui,
      "../ActionsSheet": { ActionsSheet: "ActionsSheet" },
    },
  );
  t.after(() => screen.dispose());
  const render = () =>
    screen.render("ComposerOptions", {
      composer,
      active: true,
      modelSummary: "模型 · 普通 · off",
      onSettings: () => {
        settingsOpened++;
      },
      sessionMenu: (onClose: () => void) => ({ type: "SessionMenu", props: { onClose } }),
      transcriptDetails: { type: "TranscriptDetails", props: {} },
    });
  const press = (title: string) => {
    const button = screen.nodes("Button").find((node) => node.props.title === title)!;
    assert.ok(button, title);
    (button.props.onPress as () => void)();
    render();
  };
  render();
  (screen.nodes("Pressable")[0]!.props.onPress as () => void)();
  render();
  press("会话操作");
  assert.equal(screen.nodes("ActionsSheet")[0]!.props.open, true);
  assert.equal(screen.nodes("SessionMenu").length, 1);
  press("高级记录详情");
  assert.equal(screen.nodes("TranscriptDetails").length, 1);
  press("返回会话操作");
  press("返回选项");
  press("发送方式 · 自动");
  const queue = screen.nodes("Pressable").find((node) => node.props.key === "queue")!;
  (queue.props.onPress as () => void)();
  render();
  assert.equal(composer.mode, "queue");
  assert.equal(screen.nodes("ActionsSheet")[0]!.props.open, false);
  (screen.nodes("Pressable")[0]!.props.onPress as () => void)();
  render();
  press("模型与会话设置");
  assert.equal(settingsOpened, 1);
  assert.equal(screen.nodes("ActionsSheet")[0]!.props.open, false);
  assert.equal(composer.text, "继续优化当前页面");
});
test("手机 Goal 的通知乱序不倒退，自动默认等级保留并可保存", async (t) => {
  let listener: (event: unknown) => void = () => {};
  const reads: Array<(value: unknown) => void> = [];
  const pico = {
    generation: 1,
    reason: () => undefined,
    perform: (fn: () => Promise<unknown>) => fn(),
    request: () => new Promise((resolve) => reads.push(resolve)),
    onNotification: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
  };
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/SessionActions.tsx", import.meta.url),
    {
      "react-native": { ...mobileTags(["Text", "View"]), Alert: { alert() {} } },
      "../store": { usePico: () => pico },
      "../ui": ui,
    },
  );
  t.after(() => screen.dispose());
  const props = { sessionId: "session-a", idle: true, onSession() {}, onClose() {} };
  const render = () => screen.render("SessionActions", props);
  const goal = (id: string, revision: number, status: string) => ({
    goal: {
      currentGoal: { id, revision, status, condition: "验收", iterations: 1, maxIterations: 5 },
    },
  });
  render();
  reads[0]!(goal("goal-a", 1, "active"));
  await settleScreen();
  render();
  const event = {
    scope: { sessionId: "session-a" },
    topic: "session.resourceChanged",
    payload: { resource: "goal" },
  };
  listener(event);
  listener(event);
  reads[2]!(goal("goal-a", 3, "paused"));
  await settleScreen();
  render();
  assert.ok(screen.nodes("Button").some((node) => node.props.title === "恢复目标"));
  reads[1]!(goal("goal-a", 2, "active"));
  await settleScreen();
  render();
  assert.ok(screen.nodes("Button").some((node) => node.props.title === "恢复目标"));
  listener(event);
  reads[3]!(goal("goal-b", 1, "waiting"));
  await settleScreen();
  render();
  assert.equal(
    (screen.nodes("Detail")[0]!.props.value as { currentGoal: { id: string } }).currentGoal.id,
    "goal-b",
  );
  assert.equal(
    (screen.nodes("Detail")[0]!.props.value as { currentGoal: { revision: number } }).currentGoal
      .revision,
    1,
  );

  let saved: Record<string, unknown> | undefined;
  const defaults = mobileComponent(
    new URL("../../../apps/mobile/src/settings/Defaults.tsx", import.meta.url),
    {
      "react-native": mobileTags(["Text", "View", "Switch"]),
      "../ui": ui,
      "./SettingsNavigation": { Choices: "Choices" },
      "./management": { modelChoices, saveUserDefaults },
      "../store": {
        usePico: () => ({
          generation: 1,
          reason: () => undefined,
          perform: (fn: () => Promise<unknown>) => fn(),
          request: async (method: string, params: Record<string, unknown>) => {
            if (method === "config.user.get")
              return { config: { defaults: { thinkingEffort: "high" } }, revision: "a".repeat(64) };
            if (method === "provider.list")
              return {
                providers: [
                  {
                    id: "fixture",
                    models: ["deep"],
                    resolvedModelCapabilities: { deep: { reasoningLevels: ["low", "high"] } },
                  },
                ],
              };
            saved = params.defaults as Record<string, unknown>;
            return { config: { defaults: saved }, revision: "b".repeat(64) };
          },
        }),
      },
    },
  );
  t.after(() => defaults.dispose());
  defaults.render("Defaults");
  await settleScreen();
  defaults.render("Defaults");
  (defaults.nodes("Switch")[0]!.props.onValueChange as (value: boolean) => void)(true);
  defaults.render("Defaults");
  const save = defaults.nodes("Button").find((node) => node.props.title === "保存默认行为")!;
  assert.equal(save.props.reason, undefined);
  await (save.props.onPress as () => Promise<unknown>)();
  await settleScreen();
  assert.equal(saved?.thinkingEffort, "high");
  assert.equal((saved?.webSearch as { enabled: boolean }).enabled, true);
});

test("手机会话标题同步改名、隔离迟到响应，多层返回保留祖先", async (t) => {
  const reads: Array<{ sessionId: string; resolve: (value: unknown) => void }> = [];
  let listener: (event: { topic: string; scope: { sessionId: string } }) => void = () => {};
  const pico = {
    host: { id: "host-a" },
    workspace: { id: "workspace-a", label: "项目" },
    generation: 1,
    phase: "connected",
    connected: true,
    reason: () => undefined,
    request: (_method: string, params: { sessionId: string }) =>
      new Promise((resolve) => reads.push({ sessionId: params.sessionId, resolve })),
    onNotification: (fn: typeof listener) => {
      listener = fn;
      return () => {};
    },
    report: (error: unknown) => {
      throw error;
    },
  };
  const screen = mobileComponent(new URL("../../../apps/mobile/src/App.tsx", import.meta.url), {
    "react-native": {
      ...mobileTags(["Modal", "Pressable", "ScrollView", "Text", "View"]),
      BackHandler: { addEventListener: () => ({ remove() {} }) },
      Keyboard: { dismiss() {} },
      StyleSheet: { create: (x: unknown) => x, absoluteFill: {} },
    },
    "react-native-safe-area-context": {
      ...mobileTags(["SafeAreaProvider", "SafeAreaView"]),
      useSafeAreaInsets: () => ({ top: 0 }),
    },
    "expo-status-bar": { StatusBar: "StatusBar" },
    "expo-crypto": {},
    "./store": { usePico: () => pico },
    "./ui": ui,
    ...Object.fromEntries(
      ["Conversation", "MessageMedia", "Workbar", "Settings", "ActionsSheet"].map((name) => [
        `./${name}`,
        {
          [(
            { MessageMedia: "MessageMediaProvider", Settings: "SettingsPanel" } as Record<
              string,
              string
            >
          )[name] ?? name]: name,
        },
      ]),
    ),
    "./screens/Computers": { Computers: "Computers" },
    "./screens/Sessions": { Sessions: "Sessions" },
  });
  t.after(() => screen.dispose());
  const render = () => screen.render();
  render();
  (screen.nodes("Sessions")[0]!.props.onSession as (...ids: string[]) => void)("A");
  render();
  reads.at(-1)!.resolve({ session: { sessionId: "A", title: "排查连接问题" } });
  await settleScreen();
  render();
  const hasTitle = (title: string) =>
    screen.nodes("Text").some((node) => (node.props.children as unknown[]).includes(title));
  assert.ok(hasTitle("排查连接问题"));
  listener({ topic: "session.updated", scope: { sessionId: "A" } });
  const lateA = reads.at(-1)!;
  (screen.nodes("Conversation")[0]!.props.onSession as (...ids: string[]) => void)(
    "B",
    "A",
    "sideChat",
  );
  render();
  const oldB = reads.at(-1)!;
  listener({ topic: "session.updated", scope: { sessionId: "B" } });
  reads.at(-1)!.resolve({ session: { sessionId: "B", title: "确认修复结果" } });
  await settleScreen();
  render();
  assert.ok(hasTitle("确认修复结果"));
  oldB.resolve({ session: { sessionId: "B", title: "旧标题" } });
  lateA.resolve({ session: { sessionId: "A", title: "迟到的其他会话" } });
  await settleScreen();
  render();
  assert.ok(hasTitle("确认修复结果"));
  assert.equal(hasTitle("旧标题"), false);
  assert.equal(hasTitle("迟到的其他会话"), false);
  (screen.nodes("Conversation")[0]!.props.onSession as (...ids: string[]) => void)(
    "C",
    "B",
    "child",
  );
  render();
  (screen.nodes("Conversation")[0]!.props.onSession as (...ids: string[]) => void)("B");
  render();
  assert.equal(screen.nodes("Conversation")[0]!.props.sideParentSessionId, "A");
  assert.equal(screen.nodes("Conversation")[0]!.props.parentIsSideChat, true);
  (screen.nodes("Conversation")[0]!.props.onSession as (...ids: string[]) => void)("A");
  render();
  assert.equal(screen.nodes("Conversation")[0]!.props.sideParentSessionId, undefined);
  pico.host.id = "host-b";
  render();
  (screen.nodes("Sessions")[0]!.props.onSession as (...ids: string[]) => void)("B");
  render();
  assert.equal(screen.nodes("Conversation")[0]!.props.sideParentSessionId, undefined);
});
