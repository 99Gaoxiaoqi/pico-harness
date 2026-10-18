import assert from "node:assert/strict";
import test from "node:test";
import { parseApprovalSessionScope, type RuntimeConversationItem } from "@pico/protocol/mobile";
import {
  mobileComponent,
  mobileTags,
  settleScreen,
} from "../../fixtures/mobile-component-harness.js";

type Node = { type: unknown; props: Record<string, unknown> };
type Interaction = Extract<RuntimeConversationItem, { kind: "approval" | "prompt" }>;
const colors = { text: "text", bg: "bg", line: "line", accent: "accent", danger: "danger" };
function flatten(tree: unknown): Node[] {
  if (!tree || typeof tree !== "object") return [];
  const node = tree as Node;
  const children = node.props?.children;
  return [node, ...(Array.isArray(children) ? children.flat(Infinity).flatMap(flatten) : [])];
}
function textContent(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (!tree || typeof tree !== "object") return "";
  const children = (tree as Node).props?.children;
  return Array.isArray(children) ? children.flat(Infinity).map(textContent).join(" ") : "";
}
function fixture(item: Interaction) {
  const requests: Array<{
    method: string;
    params: Record<string, unknown>;
    response: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>;
  }> = [];
  const pico = {
    host: { id: `host:${item.id}` },
    workspace: { id: "workspace" },
    generation: 1,
    reason: () => undefined as string | undefined,
    request(method: string, params: Record<string, unknown>) {
      const response = Promise.withResolvers<Record<string, unknown>>();
      requests.push({ method, params, response });
      return response.promise;
    },
  };
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/InteractionCard.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Pressable", "Text", "TextInput", "View"]),
        StyleSheet: { create: (styles: unknown) => styles },
      },
      "@pico/protocol/mobile": { parseApprovalSessionScope },
      "../store": { usePico: () => pico },
      "../ActionsSheet": mobileTags(["ActionsSheet"]),
      "../ui": { ...mobileTags(["Detail", "Label"]), s: {}, color: colors },
    },
  );
  const props = { item, sessionId: "session", syncReason: undefined as string | undefined };
  let tree: Node;
  const render = () => (tree = screen.render("InteractionCard", props));
  render();
  function button(title: string) {
    const button = flatten(tree).find(
      (node) => node.props.title === title && typeof node.props.onPress === "function",
    );
    assert.ok(button, `missing action: ${title}`);
    // Render the real stateless button to inspect native sizing and disabled accessibility.
    return (button.type as (props: Record<string, unknown>) => Node)(button.props);
  }
  const press = (title: string) => (button(title).props.onPress as () => void)();
  return {
    screen,
    props,
    pico,
    requests,
    render,
    button,
    press,
    content: () => textContent(tree),
    sheet: () => screen.nodes("ActionsSheet")[0],
    open() {
      press(
        flatten(tree).some((node) => node.props.title === "继续填写") ? "继续填写" : "填写回答",
      );
      render();
    },
    close() {
      (screen.nodes("ActionsSheet")[0]!.props.onClose as () => void)();
      render();
    },
    titles: () =>
      flatten(screen.nodes("ActionsSheet")[0] ?? tree)
        .filter((node) => typeof node.props.onPress === "function")
        .map((node) => node.props.title),
    input: () => screen.nodes("TextInput")[0]!,
    edit: (value: string) =>
      (screen.nodes("TextInput")[0]!.props.onChangeText as (value: string) => void)(value),
  };
}

test("手机审批按真实范围展示主次操作，锁定重复提交，失败可重试且已处理卡没有动作", async (t) => {
  const item: Interaction = {
    id: "approval-card",
    kind: "approval",
    title: "运行项目检查",
    detail: "检查刚修改的文件",
    state: "waiting",
    data: {
      approvalId: "approval",
      kind: "tool",
      toolName: "bash",
      command: '{"command":"npm run check"}',
      sessionScope: { type: "bash-command", command: "npm run", match: "prefix" },
    },
  };
  const card = fixture(item);
  t.after(() => card.screen.dispose());
  assert.match(card.content(), /检查刚修改的文件/);
  assert.match(card.content(), /npm run check/);
  assert.match(card.content(), /所有匹配以下前缀的命令/);
  assert.deepEqual(card.titles(), ["允许一次", "本会话允许", "拒绝"]);
  for (const title of card.titles() as string[]) {
    const style = card.button(title).props.style as (state: {
      pressed: boolean;
    }) => Array<Record<string, unknown> | false | undefined>;
    assert.ok(Number(style({ pressed: false })[0]?.minHeight) >= 44);
  }
  const primaryStyle = (
    card.button("允许一次").props.style as (state: { pressed: boolean }) => unknown[]
  )({ pressed: false });
  const secondaryStyle = (
    card.button("本会话允许").props.style as (state: { pressed: boolean }) => unknown[]
  )({ pressed: false });
  assert.equal(primaryStyle[1], undefined);
  assert.equal((secondaryStyle[1] as { backgroundColor: string }).backgroundColor, "bg");
  assert.equal((secondaryStyle[1] as { borderColor: string }).borderColor, "line");
  card.press("本会话允许");
  card.press("允许一次");
  assert.equal(card.requests.length, 1, "同帧重复点击不能发出第二个决定");
  card.render();
  assert.equal(card.button("拒绝").props.disabled, true);
  assert.equal(card.requests[0]!.params.decision, "allow_session");
  assert.equal(card.requests[0]!.params.approvalId, "approval");
  card.requests[0]!.response.reject(new Error("网络暂不可达"));
  await settleScreen();
  card.render();
  assert.match(card.content(), /网络暂不可达/);
  card.press("重试上次操作");
  assert.deepEqual(card.requests[1]!.params, card.requests[0]!.params);
  card.requests[1]!.response.resolve({ accepted: true, alreadyResolved: false });
  await settleScreen();
  card.render();
  assert.match(card.content(), /已允许 · 本会话范围/);
  assert.deepEqual(card.titles(), []);

  card.props.item = { ...item, id: "handled", state: "deny", data: { approvalId: "handled" } };
  card.render();
  assert.match(card.content(), /已拒绝/);
  assert.deepEqual(card.titles(), []);
  card.props.item = {
    ...item,
    id: "no-scope",
    data: {
      approvalId: "no-scope",
      kind: "tool",
      sessionScope: { type: "bash-command", command: "npm" },
    },
  };
  card.render();
  assert.deepEqual(card.titles(), ["允许一次", "拒绝"], "缺少合法授权范围时不能提供会话授权");
  card.props.syncReason = "等待连接恢复与同步";
  card.render();
  assert.equal(card.button("允许一次").props.disabled, true);
  card.press("允许一次");
  assert.equal(card.requests.length, 2);
});

test("手机提问在回答弹层填写，关闭保留草稿，提交与会话切换安全收起", async (t) => {
  const item: Interaction = {
    id: "prompt-card",
    kind: "prompt",
    title: "选择运行范围",
    state: "waiting",
    data: {
      promptId: "question",
      options: [
        { optionId: "targeted", label: "相关检查", description: "只运行相关集成测试" },
        "全部检查",
      ],
    },
  };
  const card = fixture(item);
  t.after(() => card.screen.dispose());
  assert.equal(card.screen.nodes("TextInput").length, 0, "内联卡不挂载回答输入框");
  assert.deepEqual(card.titles(), ["填写回答"]);
  card.open();
  assert.equal(card.sheet()?.props.open, true);
  assert.match(textContent(card.sheet()), /选择运行范围/);
  card.press("相关检查");
  card.render();
  assert.equal(card.input().props.value, "targeted");
  assert.equal(
    (card.button("相关检查").props.accessibilityState as { selected: boolean }).selected,
    true,
  );
  card.edit("保留这段回答");
  card.render();
  card.close();
  assert.equal(card.sheet(), undefined);
  assert.equal(card.screen.nodes("TextInput").length, 0);
  assert.deepEqual(card.titles(), ["继续填写"]);
  card.open();
  assert.equal(card.input().props.value, "保留这段回答");
  card.press("提交回答");
  card.press("取消提问");
  assert.equal(card.requests.length, 1);
  card.render();
  assert.equal(card.input().props.editable, false);
  card.edit("提交时不能覆盖");
  card.requests[0]!.response.resolve({ accepted: false, alreadyResolved: false });
  await settleScreen();
  card.render();
  assert.match(card.content(), /电脑未接受此操作/);
  assert.equal(card.input().props.value, "保留这段回答");
  card.press("重试上次操作");
  assert.deepEqual(card.requests[1]!.params, card.requests[0]!.params);
  card.props.sessionId = "another-session";
  card.render();
  assert.equal(card.sheet(), undefined, "切换会话关闭旧回答弹层");
  card.open();
  assert.equal(card.input().props.value, "");
  card.edit("新会话回答");
  card.render();
  card.requests[1]!.response.resolve({ accepted: true, alreadyResolved: false });
  await settleScreen();
  card.render();
  assert.equal(card.input().props.value, "新会话回答");
  assert.doesNotMatch(card.content(), /已提交回答/);
  card.props.sessionId = "session";
  card.render();
  assert.equal(card.sheet(), undefined);
  card.open();
  assert.equal(card.input().props.value, "保留这段回答");
  card.press("提交回答");
  card.pico.generation++;
  card.render();
  assert.equal(card.sheet(), undefined, "连接切换关闭旧回答弹层");
  card.open();
  card.requests[2]!.response.reject(new Error("旧连接失败"));
  await settleScreen();
  card.render();
  assert.doesNotMatch(card.content(), /旧连接失败/);
  assert.equal(card.input().props.value, "保留这段回答");
  card.screen.dispose();
  card.render();
  assert.equal(card.sheet(), undefined);
  card.open();
  assert.equal(card.input().props.value, "保留这段回答", "虚拟列表重挂载仍恢复本题草稿");
  card.press("提交回答");
  card.requests[3]!.response.resolve({ accepted: true, alreadyResolved: false });
  await settleScreen();
  card.render();
  assert.match(card.content(), /已提交回答/);
  assert.equal(card.sheet(), undefined, "提交成功关闭弹层");
  assert.match(card.content(), /保留这段回答/);
  assert.equal(card.screen.nodes("TextInput").length, 0);
  card.props.item = { ...item, id: "answered", state: "answered", data: { promptId: "answered" } };
  card.render();
  assert.match(card.content(), /已处理 · 问题已结束/);
  assert.deepEqual(card.titles(), []);

  card.props.item = { ...item, id: "uncertain", data: { promptId: "uncertain" } };
  card.render();
  card.open();
  card.edit("原回答");
  card.render();
  card.press("提交回答");
  card.requests[4]!.response.reject(Object.assign(new Error("响应丢失"), { outcome: "unknown" }));
  await settleScreen();
  card.render();
  assert.deepEqual(card.titles(), ["重试上次操作"]);
  card.close();
  card.open();
  assert.deepEqual(card.titles(), ["重试上次操作"], "重开弹层仍只能重试原操作");
  assert.equal(card.input().props.editable, false);
  card.press("重试上次操作");
  assert.deepEqual(card.requests[5]!.params, card.requests[4]!.params);
  card.requests[5]!.response.resolve({ accepted: true, alreadyResolved: true });
  await settleScreen();
  card.render();
  assert.match(card.content(), /已提交回答/);

  card.props.item = { ...item, id: "cancel", data: { promptId: "cancel" } };
  card.render();
  card.open();
  card.press("取消提问");
  assert.equal(card.requests[6]!.method, "prompt.cancel");
  assert.equal(card.requests[6]!.params.promptId, "cancel");
  card.requests[6]!.response.resolve({ cancelled: true });
  await settleScreen();
  card.render();
  assert.match(card.content(), /已取消提问/);
  assert.equal(card.sheet(), undefined);
});

test("手机结果卡展示真实摘要并打开改动，不从无文件计数的事件推测文件数", () => {
  let reviewed = 0;
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/TranscriptItem.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Pressable", "Text", "View"]),
        StyleSheet: { create: (value: unknown) => value },
      },
      "../store": { usePico: () => ({}) },
      "../ui": {
        ...mobileTags(["Button", "Card", "Detail", "Field", "Label"]),
        s: {},
        color: colors,
      },
      "../MessageMarkdown": mobileTags(["MessageMarkdown"]),
      "../markdown": {},
      "../MessageMedia": mobileTags(["MessageMedia"]),
      "../media": {},
      "./InteractionCard": mobileTags(["InteractionCard"]),
    },
  );
  const tree = screen.render("TranscriptItem", {
    item: {
      id: "changes",
      kind: "changes",
      title: "Changes updated",
      detail: "已调整审批操作和回答草稿",
      state: "ready",
      data: { runId: "run", fingerprint: "fingerprint" },
    },
    sessionId: "session",
    visible: true,
    onReview: () => reviewed++,
  });
  assert.match(textContent(tree), /改动已更新/);
  assert.match(textContent(tree), /已调整审批操作和回答草稿/);
  assert.doesNotMatch(textContent(tree), /\d+\s*个文件/);
  const action = screen.nodes("Pressable")[0]!;
  assert.ok(Number((action.props.style as { minHeight: number }).minHeight) >= 44);
  (action.props.onPress as () => void)();
  assert.equal(reviewed, 1);
  screen.dispose();
});
