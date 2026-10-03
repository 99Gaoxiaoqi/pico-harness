import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";
import { modelChoices, saveUserDefaults } from "../../../apps/mobile/src/settings/management.js";

const ui = {
  ...mobileTags(["Button", "Card", "Chips", "Detail", "Field", "Label"]),
  s: {},
  color: {},
};
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

test("手机多层会话返回保留祖先，切换电脑清除父关系", (t) => {
  const pico = {
    host: { id: "host-a" },
    workspace: { id: "workspace-a", label: "项目" },
    generation: 1,
    phase: "connected",
    reason: () => undefined,
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
  (screen.nodes("Conversation")[0]!.props.onSession as (...ids: string[]) => void)(
    "B",
    "A",
    "sideChat",
  );
  render();
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
