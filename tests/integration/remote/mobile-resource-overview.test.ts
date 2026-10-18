import assert from "node:assert/strict";
import test from "node:test";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";

const native = mobileTags(["Image", "Text", "View"]);
const ui = { ...mobileTags(["Busy", "Button", "Card", "Detail", "Label"]), s: {} };
const visibleText = (screen: ReturnType<typeof mobileComponent>) =>
  [...screen.nodes("Text"), ...screen.nodes("Label")]
    .flatMap((node) => node.props.children)
    .join(" ");

test("移动资源概览按协议显示执行、过程与协作事实，原始字段保留在折叠详情", (t) => {
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/ResourceOverview.tsx", import.meta.url),
    {
      "react-native": native,
      "./ui": ui,
    },
  );
  t.after(() => screen.dispose());
  const run = {
    runId: "run-a",
    status: "completed",
    at: "2026-10-18T10:00:00Z",
    durationMs: 1500,
    steps: [
      { id: "step-a", kind: "tool", title: "读取项目文件", status: "completed", durationMs: 60 },
    ],
  };
  screen.render("ResourceOverview", {
    tab: "执行",
    value: {
      schemaVersion: 1,
      runs: [run],
      summary: {
        modelCalls: 2,
        toolCalls: 1,
        failedCalls: 0,
        unpricedCalls: 1,
        inputTokens: 1200,
        provenance: { source: "physical_attempts" },
      },
    },
  });
  assert.match(visibleText(screen), /执行概览/);
  assert.match(visibleText(screen), /2 次模型调用/);
  assert.match(visibleText(screen), /读取项目文件/);
  assert.match(visibleText(screen), /已完成/);
  assert.match(visibleText(screen), /暂无法计价/);
  assert.doesNotMatch(visibleText(screen), /schemaVersion|physical_attempts|run-a/);
  assert.equal(screen.nodes("Detail")[0]!.props.value, run);

  const event = {
    sequence: 7,
    eventId: "event-a",
    kind: "tool.started",
    at: "2026-10-18T10:00:00Z",
    event: { data: { toolName: "read_file", argumentsJson: "sensitive internal details" } },
  };
  screen.render("ResourceOverview", {
    tab: "追踪",
    value: { events: [event], throughSequence: 7 },
  });
  assert.match(visibleText(screen), /开始执行工具/);
  assert.match(visibleText(screen), /read_file/);
  assert.doesNotMatch(visibleText(screen), /argumentsJson|sensitive internal details/);
  assert.equal(screen.nodes("Detail")[0]!.props.value, event);

  const summary = {
    graphId: "graph-a",
    epoch: 2,
    phase: "open",
    createdAt: 1792317600000,
    counts: { operators: 2, intents: 3, records: 1 },
  };
  screen.render("ResourceOverview", {
    tab: "Graph",
    value: {
      summary,
      operators: [{ operatorId: "operator-a", description: "研究资料", role: "researcher" }],
      intents: [{ intentId: "intent-a", operatorId: "operator-a", instruction: "核对原始来源" }],
      runtimeClaims: [{ claimId: "claim-a", status: "waiting_permission" }],
      diagnostics: [
        { diagnosticId: "diagnostic-a", state: "needs_attention", message: "需要检查工作区" },
      ],
    },
  });
  assert.match(visibleText(screen), /第 2 轮协作/);
  assert.match(visibleText(screen), /2 位协作者/);
  assert.match(visibleText(screen), /研究资料/);
  assert.match(visibleText(screen), /核对原始来源/);
  assert.match(visibleText(screen), /1 项等待批准/);
  assert.match(visibleText(screen), /需要检查工作区/);
  assert.doesNotMatch(visibleText(screen), /graph-a|claim-a|operator-a/);
  screen.render("ResourceOverview", {
    tab: "Graph",
    value: {
      graph: summary,
      items: [{ id: "item-a", kind: "graph.created", status: "open", at: 1792317600000 }],
    },
  });
  assert.match(visibleText(screen), /协作周期开始/);
  for (const [tab, value, expected] of [
    ["执行", { runs: [] }, "还没有执行记录"],
    ["追踪", { events: [] }, "还没有过程事件"],
    ["Graph", { graphs: [] }, "还没有协作任务"],
  ] as const) {
    screen.render("ResourceOverview", { tab, value });
    assert.match(visibleText(screen), new RegExp(expected));
  }
});

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function filesFixture() {
  const reads: Array<ReturnType<typeof deferred> & { params: Record<string, unknown> }> = [];
  const pico = {
    generation: 1,
    connected: true,
    syncRevision: 0,
    reason: () => (pico.connected ? undefined : "连接已断开"),
    perform: async (action: () => Promise<void>) => action(),
    request: async (method: string, params: Record<string, unknown>) => {
      assert.equal(method, "session.artifacts.query");
      const read = { ...deferred(), params };
      reads.push(read);
      return read.promise;
    },
  };
  const screen = mobileComponent(new URL("../../../apps/mobile/src/Files.tsx", import.meta.url), {
    "react-native": native,
    "expo-sharing": {},
    "react-native-webview": { WebView: "WebView" },
    "expo-video": { VideoView: "VideoView" },
    "./store": { usePico: () => pico },
    "./artifact-cache": {},
    "./ui": ui,
  });
  const press = (title: string) => {
    const button = screen.nodes("Button").find((node) => node.props.title === title);
    assert.ok(button, title);
    (button.props.onPress as () => void)();
  };
  const render = (sessionId = "session-a") => screen.render("FilesPanel", { sessionId });
  return { screen, reads, pico, press, render };
}
const artifact = (title: string) => ({
  artifactId: title,
  title,
  mimeType: "application/pdf",
  sizeBytes: 2048,
});

test("文件页区分加载、空结果与可重试失败，更新期间保留已有文件", async (t) => {
  const { screen, reads, press, render } = filesFixture();
  t.after(() => screen.dispose());
  render();
  assert.equal(screen.nodes("Busy")[0]!.props.label, "正在加载文件…");
  assert.doesNotMatch(visibleText(screen), /还没有文件/);
  reads[0]!.reject(new Error("电脑暂时不可达"));
  await settleScreen();
  render();
  assert.match(visibleText(screen), /文件暂时无法加载/);
  press("重试加载");
  reads[1]!.resolve({ artifacts: [], revision: 1 });
  await settleScreen();
  render();
  assert.match(visibleText(screen), /还没有文件/);
  press("刷新文件");
  reads[2]!.resolve({ artifacts: [artifact("研究报告.pdf")], revision: 2, nextCursor: "page-two" });
  await settleScreen();
  render();
  assert.match(visibleText(screen), /研究报告.pdf/);
  assert.match(visibleText(screen), /PDF 文档 · 2.0 KB/);
  assert.equal(screen.nodes("Detail")[0]!.props.title, "文件信息");
  press("加载更多文件");
  assert.equal(reads[3]!.params.cursor, "page-two");
  assert.equal(reads[3]!.params.revision, 2);
  reads[3]!.reject(new Error("读取下一页失败"));
  await settleScreen();
  render();
  assert.match(visibleText(screen), /更新失败，仍显示上次的文件/);
  assert.match(visibleText(screen), /研究报告.pdf/);
  press("重试加载");
  render();
  assert.equal(screen.nodes("Busy")[0]!.props.label, "正在更新文件…");
  assert.match(visibleText(screen), /研究报告.pdf/);
  reads[4]!.resolve({ artifacts: [artifact("最新报告.pdf")], revision: 3 });
  await settleScreen();
  render();
  assert.match(visibleText(screen), /最新报告.pdf/);
  assert.doesNotMatch(visibleText(screen), /更新失败|研究报告.pdf/);
});

test("文件页断线恢复及会话切换拒绝旧读取和旧错误", async (t) => {
  const { screen, reads, pico, press, render } = filesFixture();
  t.after(() => screen.dispose());
  render();
  pico.connected = false;
  render();
  assert.match(visibleText(screen), /连接已断开/);
  assert.equal(reads.length, 1);
  pico.connected = true;
  pico.syncRevision++;
  render();
  reads[1]!.resolve({ artifacts: [artifact("恢复后的文件.pdf")], revision: 1 });
  await settleScreen();
  render();
  reads[0]!.resolve({ artifacts: [artifact("断线前的旧文件.pdf")], revision: 0 });
  await settleScreen();
  render();
  assert.match(visibleText(screen), /恢复后的文件.pdf/);
  assert.doesNotMatch(visibleText(screen), /断线前的旧文件/);
  pico.connected = false;
  render();
  assert.match(visibleText(screen), /仍显示上次的文件/);
  assert.match(visibleText(screen), /恢复后的文件.pdf/);
  pico.connected = true;
  pico.syncRevision++;
  render();
  render("session-b");
  reads[3]!.resolve({ artifacts: [artifact("会话 B.pdf")], revision: 1 });
  await settleScreen();
  render("session-b");
  reads[2]!.reject(new Error("旧会话读取失败"));
  await settleScreen();
  render("session-b");
  assert.match(visibleText(screen), /会话 B.pdf/);
  assert.doesNotMatch(visibleText(screen), /旧会话读取失败|恢复后的文件/);
  press("刷新文件");
  pico.generation++;
  render("session-b");
  reads[5]!.resolve({ artifacts: [], revision: 1 });
  await settleScreen();
  render("session-b");
  reads[4]!.resolve({ artifacts: [artifact("旧电脑的文件.pdf")], revision: 1 });
  await settleScreen();
  render("session-b");
  assert.match(visibleText(screen), /还没有文件/);
  assert.doesNotMatch(visibleText(screen), /旧电脑的文件/);
});
