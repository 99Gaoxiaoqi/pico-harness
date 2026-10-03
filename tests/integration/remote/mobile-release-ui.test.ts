import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { connectionIssue } from "../../../apps/mobile/src/connection-errors.js";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";

const ui = { ...mobileTags(["Button", "Card", "Field", "Label"]), s: {}, color: {} };
function textOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (value && typeof value === "object")
    return textOf((value as { props?: { children?: unknown } }).props?.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function releaseInfoFixture() {
  const module = {
    exports: {} as {
      releaseInfo: unknown;
      safeDiagnostic: (phase: string, code?: string) => string;
    },
  };
  const compiled = transformSync(
    readFileSync(new URL("../../../apps/mobile/src/release-info.ts", import.meta.url), "utf8"),
    { loader: "ts", format: "cjs" },
  ).code;
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    URL,
    require(name: string) {
      if (name === "react-native") return { Platform: { OS: "ios" } };
      assert.equal(name, "expo-constants");
      return {
        nativeAppVersion: "0.1.0",
        nativeBuildVersion: "7",
        expoConfig: {
          version: "0.1.0",
          ios: { buildNumber: "7" },
          extra: {
            release: { publisher: "", privacyPolicyUrl: "", supportUrl: "", supportEmail: "" },
          },
        },
      };
    },
  });
  return module.exports;
}

test("离线未配对可读隐私说明和安全诊断，拒绝相机仍可粘贴，未知结果清理仅在明确放弃后执行", async (t) => {
  const shared: string[] = [];
  const opened: string[] = [];
  const pico = {
    phase: "offline",
    host: undefined,
    workspace: undefined,
    deviceToken: "fixture-secret-token",
    body: "fixture-private-body",
    path: "/fixture/private/path",
    errorInfo: { code: "https://fixture-host.example/token" },
    perform: (operation: () => Promise<unknown>) => operation(),
  };
  const privacy = mobileComponent(
    new URL("../../../apps/mobile/src/PrivacySupport.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Text", "View"]),
        Linking: {
          openURL: async (url: string) => {
            opened.push(url);
          },
        },
        Share: {
          share: async ({ message }: { message: string }) => {
            shared.push(message);
          },
        },
      },
      "./store": { usePico: () => pico },
      "./ui": ui,
      "./release-info": releaseInfoFixture(),
    },
  );
  t.after(() => privacy.dispose());
  privacy.render("PrivacySupport");
  const privacyText = privacy
    .nodes("Label")
    .map((node) => textOf(node.props.children))
    .join("\n");
  assert.match(privacyText, /草稿文字、图片和发送／审阅恢复记录/);
  assert.match(privacyText, /保存在手机本机/);
  assert.match(privacyText, /模型与工具服务/);
  assert.match(privacyText, /公开隐私政策地址尚未配置/);
  assert.match(privacyText, /支持地址尚未配置/);
  assert.match(privacyText, /发布主体：尚未配置/);
  assert.match(privacyText, /Pico 0\.1\.0 · 构建 7/);
  assert.equal(
    privacy
      .nodes("Button")
      .some((node) => /打开隐私政策|打开支持页面|联系支持邮箱/.test(String(node.props.title))),
    false,
  );
  const share = privacy.nodes("Button").find((node) => node.props.title === "分享安全诊断")!;
  (share.props.onPress as () => void)();
  await settleScreen();
  assert.equal(opened.length, 0, "不伪造尚未配置的发布链接");
  assert.equal(shared.length, 1);
  const diagnostic = JSON.parse(shared[0]!);
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "app",
    "build",
    "errorCode",
    "phase",
    "platform",
    "version",
  ]);
  assert.equal(diagnostic.phase, "offline");
  assert.equal(diagnostic.errorCode, "NONE_OR_OTHER");
  assert.equal(diagnostic.version, "0.1.0");
  assert.equal(diagnostic.build, "7");
  for (const privateValue of [pico.deviceToken, pico.body, pico.path, pico.errorInfo.code])
    assert.equal(shared[0]!.includes(privateValue), false);

  type Host = { id: string; name: string; baseUrl: string };
  type Choice = { text: string; style?: string; onPress?: () => void };
  const alerts: { title: string; message: string; choices: Choice[] }[] = [];
  const paired: { raw: string; name: string }[] = [];
  const connections: string[] = [];
  const clearCalls: { hostId: string; discardUnconfirmed: boolean }[] = [];
  let openedSettings = 0,
    cameraRequests = 0;
  const computerPico = {
    hosts: [] as Host[],
    host: undefined,
    pairing: undefined,
    perform: (operation: () => Promise<unknown>) => operation(),
    report() {},
    pair: async (raw: string, name: string) => {
      paired.push({ raw, name });
    },
    connect: async (host: Host) => {
      connections.push(host.id);
    },
    clearLocalData: async (host: Host, discardUnconfirmed: boolean) => {
      clearCalls.push({ hostId: host.id, discardUnconfirmed });
      return { legacyCacheRemaining: true };
    },
  };
  const computers = mobileComponent(
    new URL("../../../apps/mobile/src/screens/Computers.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Text", "View"]),
        StyleSheet: { create: (value: unknown) => value },
        AppState: { addEventListener: () => ({ remove() {} }) },
        Linking: {
          openSettings: async () => {
            openedSettings++;
          },
        },
        Alert: {
          alert: (title: string, message: string, choices: Choice[] = []) => {
            alerts.push({ title, message, choices });
          },
        },
      },
      "expo-camera": {
        CameraView: "CameraView",
        useCameraPermissions: () => [
          { granted: false, canAskAgain: false },
          async () => {
            cameraRequests++;
            return { granted: false, canAskAgain: false };
          },
        ],
      },
      "../store": { usePico: () => computerPico },
      "../ui": ui,
      "../local-data": {
        inspectHostLocalData: async (hostId: string) => {
          assert.equal(hostId, "A");
          return { hasUnconfirmed: true, legacyCache: true };
        },
      },
    },
  );
  t.after(() => computers.dispose());
  const render = () => computers.render("Computers");
  const press = (title: string) => {
    const node = computers.nodes("Button").find((candidate) => candidate.props.title === title);
    assert.ok(node, title);
    (node.props.onPress as () => void)();
  };
  render();
  press("配对新电脑");
  render();
  press("扫描电脑二维码");
  await settleScreen();
  render();
  assert.equal(cameraRequests, 1);
  assert.equal(computers.nodes("CameraView").length, 0);
  assert.match(
    computers
      .nodes("Label")
      .map((node) => textOf(node.props.children))
      .join("\n"),
    /相机未获授权，仍可粘贴/,
  );
  press("打开系统权限设置");
  await settleScreen();
  assert.equal(openedSettings, 1);
  const paste = computers.nodes("Field").find((node) => node.props.label === "或粘贴配对内容")!;
  (paste.props.onChange as (value: string) => void)("fixture-pairing-content");
  render();
  press("提交配对");
  await settleScreen();
  render();
  assert.deepEqual(paired, [{ raw: "fixture-pairing-content", name: "我的手机" }]);
  computerPico.hosts.push({ id: "A", name: "电脑 A", baseUrl: "https://fixture-host.example" });
  render();
  press("清除本机数据");
  await settleScreen();
  let confirmation = alerts.at(-1)!;
  assert.match(confirmation.message, /结果未确认/);
  assert.match(confirmation.message, /永久放弃本机恢复记录/);
  assert.match(confirmation.message, /电脑会话、任务和终端保留/);
  assert.match(confirmation.message, /旧版成果缓存会保留/);
  assert.equal(clearCalls.length, 0);
  confirmation.choices.find((choice) => choice.text === "先查看电脑状态")!.onPress!();
  await settleScreen();
  assert.deepEqual(connections, ["A"]);
  assert.equal(clearCalls.length, 0, "查看状态不放弃恢复记录");
  press("清除本机数据");
  await settleScreen();
  confirmation = alerts.at(-1)!;
  const discard = confirmation.choices.find((choice) => choice.text === "放弃恢复并清除")!;
  assert.equal(discard.style, "destructive");
  discard.onPress!();
  await settleScreen();
  assert.deepEqual(clearCalls, [{ hostId: "A", discardUnconfirmed: true }]);
});

test("未知结果、设备撤销、权限和 TLS 错误使用对应恢复入口，点击提示不盲目重连", (t) => {
  const connections: string[] = [];
  const host = { id: "A", name: "电脑 A", baseUrl: "https://fixture-host.example" };
  const pico = {
    host,
    phase: "blocked",
    generation: 1,
    workspace: undefined,
    connected: false,
    error: "fixture error",
    errorInfo: connectionIssue({ outcome: "unknown", retryable: true, code: "CONNECTION_FAILED" }),
    connect: (selected: typeof host) => {
      connections.push(selected.id);
    },
    reason: () => "offline",
  };
  const app = mobileComponent(new URL("../../../apps/mobile/src/App.tsx", import.meta.url), {
    "react-native": {
      ...mobileTags(["Modal", "Pressable", "ScrollView", "Text", "View"]),
      StyleSheet: { create: (value: unknown) => value },
      Keyboard: { dismiss() {} },
      BackHandler: { addEventListener: () => ({ remove() {} }) },
    },
    "react-native-safe-area-context": {
      ...mobileTags(["SafeAreaProvider", "SafeAreaView"]),
      useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
      initialWindowMetrics: {},
    },
    "expo-status-bar": { StatusBar: "StatusBar" },
    "expo-crypto": {},
    "./store": { usePico: () => pico },
    "./ui": ui,
    "./Conversation": { Conversation: "Conversation" },
    "./MessageMedia": { MessageMediaProvider: "MessageMediaProvider" },
    "./Workbar": { Workbar: "Workbar" },
    "./Settings": { SettingsPanel: "SettingsPanel" },
    "./ActionsSheet": { ActionsSheet: "ActionsSheet" },
    "./screens/Computers": { Computers: "Computers" },
    "./screens/Sessions": { Sessions: "Sessions" },
  });
  t.after(() => app.dispose());
  const cases = [
    {
      error: { outcome: "unknown", retryable: true, code: "CONNECTION_FAILED" },
      action: "verify",
      label: "核对当前状态",
    },
    { error: { code: "DEVICE_REVOKED", retryable: true }, action: "pair", label: "电脑与连接" },
    { error: { code: "FORBIDDEN", retryable: true }, action: "authorize", label: "电脑与连接" },
    {
      error: {
        code: "TRANSPORT_ERROR",
        message: "SSL certificate validation failed",
        retryable: true,
      },
      action: "prepare",
      label: "电脑与连接",
    },
  ];
  for (const { error, action, label } of cases) {
    pico.errorInfo = connectionIssue(error);
    assert.equal(pico.errorInfo.action, action);
    app.render();
    assert.equal(
      app.nodes("Button").some((node) => node.props.title === "重新连接"),
      false,
    );
    const recovery = app.nodes("Button").find((node) => node.props.title === label)!;
    assert.ok(recovery, `error action ${action}`);
    (recovery.props.onPress as () => void)();
    app.render();
    assert.equal(connections.length, 0, `${action} 点击只导航到核对/准备入口`);
  }
});
