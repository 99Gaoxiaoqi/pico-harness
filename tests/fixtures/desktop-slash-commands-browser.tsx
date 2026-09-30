import { parseComposerDraft } from "../../apps/desktop/src/renderer/conversation/composer-references.js";
import "../../apps/desktop/src/renderer/layers.css";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route, useParams, useNavigate } from "react-router-dom";
import { SessionsPage } from "../../apps/desktop/src/renderer/pages/SessionsPage.tsx";
import { UsagePage } from "../../apps/desktop/src/renderer/usage/UsagePage.tsx";
import { ConversationPage } from "../../apps/desktop/src/renderer/pages/ConversationPage.tsx";
import { SideChatPanelController } from "../../apps/desktop/src/renderer/workbar-panels/SideChatPanelController.tsx";
import { PicoTheme } from "../../apps/desktop/src/renderer/astryx-provider.tsx";
import { RuntimeContext } from "../../apps/desktop/src/renderer/runtime-context.tsx";
import { previewData } from "../../apps/desktop/src/renderer/fixture.ts";
import { workspaceSessionKey } from "../../apps/desktop/src/renderer/workspace-session.ts";
import { DESKTOP_COMMAND_POLICY } from "../../apps/desktop/src/shared/command-policy.ts";
import { applyConversationSettings } from "../../apps/desktop/src/renderer/conversation/conversation-settings.ts";
import { ComposerModelPicker } from "../../apps/desktop/src/renderer/ComposerModelPicker.tsx";
import { SelectField } from "../../apps/desktop/src/renderer/ui-controls.tsx";
import {
  ConversationComposer,
  type ConversationComposerHandle,
} from "../../apps/desktop/src/renderer/conversation/ConversationComposer.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const calls = [];
const ref = { workspacePath: "/fixture", sessionId: "s1" };
const records = [{ id: "history-1", kind: "userMessage", text: "原始历史消息" }];
let commandsPending;
let delayNext = false;
let failNext;
let failPlan = false;
let goalPending;
let deferGoal = false;
let navigateTest;
const primaryNames = ["help", "goal", "resume", "compact", "rewind", "changes"];
const catalog = Object.entries(DESKTOP_COMMAND_POLICY)
  .filter(([, policy]) => policy.tier === "primary" || policy.tier === "advanced")
  .map(([name, policy]) => ({
    name,
    insertText: name,
    description: "测试 " + name,
    aliases: [],
    source: "builtin",
    kind: "local",
    tier: policy.tier,
  }));
const local = (result) => ({
  ok: true,
  value: { outcome: { kind: "local", result: { type: "local", ...result } } },
});
window.pico = {
  commands: {
    catalog: async (context) =>
      window.testCommandBridge
        ? window.testCommandBridge.catalog(context)
        : {
            ok: true,
            value: catalog.map((item) => {
              const policy = DESKTOP_COMMAND_POLICY[item.name];
              const missingSession = policy.session && !context.sessionId;
              const runningCompact = context.running && item.name === "compact";
              return {
                ...item,
                disabled: Boolean(missingSession || runningCompact),
                disabledReason: missingSession
                  ? "请先发送消息或打开历史会话。"
                  : runningCompact
                    ? "任务执行中，结束后可执行此操作。"
                    : undefined,
              };
            }),
          },
    complete: async (context, text) =>
      window.testCommandBridge
        ? window.testCommandBridge.complete(context, text)
        : {
            ok: true,
            value: text.startsWith("/resume ") ? [{ label: "第二个会话", value: "s2" }] : [],
          },
    execute: async (context, text, requestId) => {
      calls.push({ method: "command", context, text, requestId });
      if (failNext) {
        const failure = failNext;
        failNext = undefined;
        return failure === "ipc"
          ? { ok: false, error: { message: "响应丢失" } }
          : local({ action: "message", message: "命令执行失败：响应丢失" });
      }
      if (delayNext) {
        delayNext = false;
        return new Promise((resolve) => {
          commandsPending = resolve;
        });
      }
      if (window.testCommandBridge)
        return window.testCommandBridge.execute(context, text, requestId);
      const policy = DESKTOP_COMMAND_POLICY[text.slice(1)];
      if (policy?.tier === "control")
        return {
          ok: true,
          value: { outcome: { kind: "local" }, action: { kind: "open", target: policy.target } },
        };
      if (text === "/new")
        return { ok: true, value: { outcome: { kind: "local" }, switchSession: null } };
      if (["/usage", "/sessions"].includes(text))
        return {
          ok: true,
          value: {
            outcome: { kind: "rejected", message: "请使用页面" },
            redirect: {
              destination: text.slice(1),
              label: text === "/usage" ? "打开用量统计" : "打开会话工作库",
            },
          },
        };
      if (["/goal", "/model", "/skill", "/agent"].includes(text))
        return {
          ok: true,
          value: { outcome: { kind: "local" }, action: { kind: "open", target: text.slice(1) } },
        };
      if (text === "/compact")
        return { ok: true, value: { outcome: { kind: "local" }, action: { kind: "compact" } } };
      if (text === "/goal pause")
        return {
          ok: true,
          value: {
            outcome: { kind: "local" },
            action: { kind: "goal", input: { action: "pause", goalId: "g1", expectedRevision: 1 } },
          },
        };
      if (text.startsWith("/agent ")) return local({ action: "message", message: "任务已提交" });
      if (text === "/help")
        return local({
          action: "help",
          message: "全部命令",
          ui: { kind: "open-panel", panel: "help" },
        });
      if (text === "/resume")
        return {
          ok: true,
          value: { outcome: { kind: "local" }, action: { kind: "open", target: "sessions" } },
        };
      if (text === "/resume s2")
        return { ok: true, value: { outcome: { kind: "local" }, switchSession: "s2" } };
      if (["/clear", "/exit"].includes(text))
        return {
          ok: true,
          value: { outcome: { kind: "rejected", message: "此命令不适用于桌面" } },
        };
      if (text.startsWith("/provider "))
        return {
          ok: true,
          value: {
            outcome: { kind: "rejected", message: "请使用模型设置" },
            redirect: { destination: "providers", label: "打开模型设置" },
          },
        };
      if (text === "/rewind cp1")
        return local({
          action: "message",
          ui: { kind: "open-selector", selector: "rewind" },
          data: {
            sessionId: context.sessionId,
            selectedMessageId: "cp1",
            snapshots: [{ messageId: "cp1", userPrompt: "原始提示", changedFileCount: 1 }],
          },
        });
      if (text === "/changes cp1")
        return local({
          action: "message",
          ui: { kind: "open-selector", selector: "changes" },
          data: { sessionId: context.sessionId, checkpointId: "cp1" },
        });
      return { ok: true, value: { outcome: { kind: "unknown", message: "未知命令" } } };
    },
  },
  runtime: new Proxy(
    {},
    {
      get: (_, method) => async (params) => {
        calls.push({ method, params });
        if (method === "rewind.preview")
          return {
            ok: true,
            value: {
              checkpointId: "cp1",
              fingerprint: "preview-fingerprint",
              changes: [{ path: "a.ts", patch: "-old\n+new" }],
            },
          };
        if (method === "rewind.apply")
          return {
            ok: true,
            value: { applied: true, sourceSessionId: "s1", sessionId: "rewound" },
          };
        if (method === "rewind.changes")
          return {
            ok: true,
            value: {
              checkpointId: "cp1",
              files: [
                {
                  path: "a.ts",
                  fingerprint: "file-fingerprint",
                  patch: "-old\n+new",
                  additions: 1,
                  deletions: 1,
                },
              ],
            },
          };
        if (method === "rewind.restoreFile") return { ok: true, value: { restored: true } };
        if (method === "sideChat.create")
          return { ok: true, value: { session: { sessionId: "side-1" }, throughEventId: "e1" } };
        return { ok: true, value: {} };
      },
    },
  ),
  lifecycle: {
    quit: async () => {
      calls.push({ method: "quit" });
      return { ok: true };
    },
  },
};
const actions = new Proxy(
  {
    queryUsage: async (input) => {
      calls.push({ method: "query-usage", input });
      return {};
    },
    loadSession: async (ref) => {
      calls.push({ method: "load-session", ref });
    },
    reload: async () => {
      calls.push({ method: "reload" });
    },
    updateSessionSettings: async (ref, patch) => {
      calls.push({ method: "settings", ref, patch });
      return true;
    },
    compactSession: async (ref) => {
      calls.push({ method: "compact", ref });
      return true;
    },
    controlGoal: async (ref, input) => {
      calls.push({ method: "goal-control", ref, input });
      if (deferGoal) {
        deferGoal = false;
        return new Promise((resolve) => {
          goalPending = resolve;
        });
      }
      return true;
    },
    respondPlan: async (input) => {
      calls.push({ method: "plan-response", input });
      return !failPlan;
    },
    ensureTemporaryWorkspace: async () => "/fixture",
    sendMessage: async (input) => {
      calls.push({ method: "send", input });
      return { succeeded: true };
    },
  },
  { get: (target, name) => target[name] ?? (async () => {}) },
);
const conversation = {
  ...ref,
  items: records,
  queuedCount: 0,
  goal: {
    currentGoal: {
      id: "g1",
      revision: 1,
      status: "active",
      condition: "完成验收",
      maxIterations: 50,
      iterations: 0,
      tokensAtStart: 0,
      tokensNow: 0,
    },
  },
  settings: {
    modelRouteId: "p/m",
    model: "m",
    collaborationMode: "agent",
    orchestrationMode: "default",
    permissionMode: "ask",
    thinkingEffort: "",
    reasoningLevels: [],
  },
};
const runtime = {
  preview: true,
  connection: { kind: "ready" },
  actions,
  data: {
    ...previewData,
    workspacePath: "/fixture",
    trusted: true,
    modelRoutes: [
      { id: "p/m", label: "模型 M" },
      { id: "p/n", label: "模型 N" },
    ],
    workspaces: [{ path: "/fixture", name: "fixture", trusted: true }],
    sessions: [
      {
        id: "s1",
        workspacePath: "/other",
        title: "另一个项目的会话",
        status: "active",
        updatedAt: 1,
      },
      { id: "s1", workspacePath: "/fixture", title: "会话一", status: "active", updatedAt: 1 },
      { id: "s2", workspacePath: "/fixture", title: "第二个会话", status: "active", updatedAt: 1 },
    ],
    conversations: {
      [workspaceSessionKey(ref)]: conversation,
      [workspaceSessionKey({ ...ref, sessionId: "s2" })]: { ...conversation, sessionId: "s2" },
      [workspaceSessionKey({ ...ref, sessionId: "side-1" })]: {
        ...conversation,
        sessionId: "side-1",
      },
    },
    catalogSkills: [
      {
        name: "archify",
        description: "架构图流程图",
        allowedTools: [],
        sourceId: "user-agents",
        sourcePath: "/skills/archify/SKILL.md",
      },
      {
        name: "aihot",
        description: "中文 AI 新闻热点",
        allowedTools: [],
        sourceId: "user-agents",
        sourcePath: "/skills/aihot/SKILL.md",
      },
    ],
    catalogAgents: [{ name: "reviewer", description: "检查代码", source: "user", tools: [] }],
    skillScope: {
      userItems: [
        {
          id: "aihot",
          name: "aihot",
          description: "中文 AI 新闻热点",
          state: "ready",
          source: {
            scope: "user",
            sourceId: "user-agents",
            sourceLabel: "Agents 用户级",
            readOnly: true,
            effective: true,
          },
        },
      ],
      userRevision: "fixture",
    },
    runs: [],
    approvals: [],
    prompts: [],
  },
};
const root = createRoot(document.getElementById("app"));
const check = (value, message) => {
  if (!value) throw new Error(message);
};
async function wait() {
  await new Promise((resolve) => setTimeout(resolve, 35));
}
function TestRoute({ side }) {
  const { sessionId } = useParams();
  navigateTest = useNavigate();
  return (
    <>
      {sessionId !== "s1" && <div>会话切换成功</div>}
      {side ? (
        <SideChatPanelController
          runtime={runtime}
          workspacePath="/fixture"
          sourceSessionId="s1"
          panelId="test"
          active
          onRequestClose={() => {}}
        />
      ) : (
        <ConversationPage />
      )}
    </>
  );
}
async function mount(side = false, key = crypto.randomUUID()) {
  await act(async () => {
    root.render(
      <PicoTheme>
        <RuntimeContext value={runtime}>
          <MemoryRouter key={key} initialEntries={["/session/s1?workspace=%2Ffixture"]}>
            <Routes>
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/settings/usage" element={<UsagePage />} />
              <Route
                path="/task/new"
                element={
                  <>
                    <p>新任务页面</p>
                    <TestRoute side={false} />
                  </>
                }
              />
              <Route path="/session/:sessionId" element={<TestRoute side={side} />} />
            </Routes>
          </MemoryRouter>
        </RuntimeContext>
      </PicoTheme>,
    );
    await wait();
  });
}
function editor() {
  return document.querySelector('[contenteditable="true"]');
}
async function type(text) {
  await act(async () => {
    const input = editor();
    check(input, "没有输入框");
    input.focus();
    input.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
    );
    await wait();
  });
}
async function key(name, options = {}) {
  await act(async () => {
    editor().dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options }),
    );
    await wait();
  });
}
async function click(label) {
  const button = [...document.querySelectorAll('button, a, [role="menuitem"]')].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.textContent.trim() === label ||
      item.textContent.startsWith(label),
  );
  check(button, "没有按钮 " + label);
  await act(async () => {
    button.click();
    await wait();
  });
}
async function command(text) {
  await type(text);
  await key("Escape");
  await key("Enter");
}

(async () => {
  try {
    await mount();
    if (window.testNativeSlash) {
      await type("");
      await act(async () => {
        editor().focus();
        await window.testNativeSlash();
        await wait();
      });
    } else await type("/");
    const commandLabels = () =>
      [...document.querySelectorAll('.command-suggestions [role="option"]')]
        .filter((item) => item.querySelector("small")?.textContent === "命令")
        .map((item) => item.querySelector("strong")?.textContent)
        .sort();
    check(
      commandLabels().join() ===
        primaryNames
          .map((name) => "/" + name)
          .sort()
          .join(),
      "默认菜单未仅露出六个主命令",
    );
    const count = calls.length;
    await key("Enter", { isComposing: true });
    check(calls.length === count && editor().textContent === "/", "IME 提交了命令");
    await key("ArrowDown");
    await key("Tab");
    check(
      editor().textContent.trim().startsWith("/") && editor().textContent.trim() !== "/",
      "方向键/Tab 补全失败",
    );
    await act(async () => {
      navigateTest("/task/new");
      await wait();
    });
    await type("/mode");
    const modeSettingsBefore = calls.filter((item) => item.method === "settings").length;
    await key("Enter");
    check(
      calls.findLast((item) => item.method === "command")?.text === "/mode",
      "完整 /mode 被当作 /model 前缀补全",
    );
    check(
      document
        .querySelector('.pico-composer-menu [role="menuitemcheckbox"]')
        ?.closest("[popover]")
        ?.matches(":popover-open"),
      "新任务 /mode Enter 没有打开加号菜单",
    );
    check(
      calls.filter((item) => item.method === "settings").length === modeSettingsBefore,
      "/mode 修改了会话设置",
    );
    await mount();
    await type("/agent rev");
    await key("Enter");
    check(
      editor().querySelector("[data-astryx-token]")?.textContent.includes("reviewer"),
      "Agent 资源候选未插入原子标签",
    );
    await command("/goal");
    check(document.querySelector('[aria-label="设置 Goal"]'), "没有打开已有 Goal 控件");
    await click("取消");
    await type("/operations");
    check(
      document.querySelector('.command-suggestions [role="option"]')?.textContent.includes("高级"),
      "高级命令不能按前缀找到",
    );
    check(!calls.some((item) => item.method === "send"), "命令误发模型");
    await command("/unknown");
    check(
      editor().textContent === "/unknown" && document.body.textContent.includes("未知"),
      "未知命令丢失草稿",
    );
    await type("/resume s");
    check(
      document
        .querySelector('.command-suggestions [role="option"]')
        ?.textContent.includes("第二个会话"),
      "参数补全未显示标题",
    );
    await key("Tab");
    check(editor().textContent.trim() === "/resume s2", "会话补全没使用 ID");
    await command("/model");
    const choice = [...document.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.textContent.includes("模型 N"),
    );
    check(choice, "未复用模型选择器");
    await act(async () => {
      choice.click();
      await wait();
    });
    check(
      calls.some((item) => item.method === "settings" && item.patch.modelRouteId === "p/n"),
      "模型选择没有走原桌面设置动作",
    );
    runtime.data.runs.push({
      id: "running-1",
      workspacePath: "/fixture",
      sessionId: "s1",
      description: "执行中的任务",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    await mount();
    await type("/");
    check(
      commandLabels().join() ===
        primaryNames
          .filter((name) => name !== "compact")
          .map((name) => "/" + name)
          .sort()
          .join(),
      "运行中默认候选没有保留检查点查看或隐藏压缩",
    );
    await command("/model");
    const runningModel = [
      ...document.querySelectorAll('.pico-composer-model-menu [role="menuitemradio"]'),
    ].find((item) => item.textContent.includes("模型 N"));
    check(
      runningModel?.closest("[popover]")?.matches(":popover-open") &&
        runningModel.getAttribute("aria-disabled") === "true",
      "实际会话运行中没有打开只读模型菜单",
    );
    const settingsBefore = calls.filter((item) => item.method === "settings").length;
    await act(async () => {
      runningModel.click();
      await wait();
    });
    check(
      calls.filter((item) => item.method === "settings").length === settingsBefore,
      "运行中模型发生修改",
    );
    await click("选择模型：模型 M");
    for (const [text, label, method] of [
      ["/changes cp1", "恢复此文件", "rewind.restoreFile"],
      ["/rewind cp1", "确认回退", "rewind.apply"],
    ]) {
      await command(text);
      const action = [...document.querySelectorAll("button")].find(
        (button) =>
          button.textContent.trim() === label || button.getAttribute("aria-label") === label,
      );
      check(
        action?.disabled || action?.getAttribute("aria-disabled") === "true",
        "运行中的检查点查看允许写入：" + text,
      );
      await click(label);
      check(!calls.some((item) => item.method === method), "运行中的检查点查看触发写入：" + text);
      await click("关闭");
    }
    runtime.data.runs = [];
    await mount();
    await command("/compact");
    check(!calls.some((item) => item.method === "compact"), "压缩命令绕过确认");
    await click("取消");
    await click("压缩");
    await click("确认压缩");
    check(
      calls.filter((item) => item.method === "compact").length === 1,
      "原按钮没有共享压缩确认流程",
    );
    const originalConfirm = window.confirm;
    conversation.settings.collaborationMode = "plan";
    runtime.data.approvals.push({
      kind: "plan",
      sessionId: "s1",
      planId: "p1",
      expectedRevision: 3,
      expectedSessionSequence: 8,
      controlEpoch: "e1",
    });
    window.confirm = () => false;
    check(
      !(await applyConversationSettings(runtime, ref, {}, { collaborationMode: "agent" })),
      "取消 Plan 退出仍写入",
    );
    window.confirm = () => true;
    check(
      await applyConversationSettings(runtime, ref, {}, { collaborationMode: "agent" }),
      "确认 Plan 退出失败",
    );
    check(
      calls.find((item) => item.method === "plan-response")?.input.expectedRevision === 3,
      "Plan 退出丢失 CAS",
    );
    failPlan = true;
    const settingsCount = calls.filter((item) => item.method === "settings").length;
    check(
      !(await applyConversationSettings(runtime, ref, {}, { collaborationMode: "research" })),
      "审批失败仍报告模式切换成功",
    );
    check(
      calls.filter((item) => item.method === "settings").length === settingsCount,
      "审批失败仍更新会话设置",
    );
    failPlan = false;
    window.confirm = originalConfirm;
    runtime.data.approvals = [];
    conversation.settings.collaborationMode = "agent";
    await command("/changes cp1");
    await click("恢复此文件");
    check(!calls.some((item) => item.method === "rewind.restoreFile"), "未确认就恢复文件");
    await click("确认恢复此文件");
    const restored = calls.find((item) => item.method === "rewind.restoreFile");
    check(
      restored.params.checkpointId === "cp1" &&
        restored.params.expectedFingerprint === "file-fingerprint",
      "文件恢复丢失目标或指纹",
    );
    await click("关闭");
    await command("/rewind cp1");
    check(!calls.some((item) => item.method === "rewind.apply"), "预览触发回退");
    await click("确认回退");
    const applied = calls.find((item) => item.method === "rewind.apply");
    check(
      applied.params.checkpointId === "cp1" &&
        applied.params.expectedFingerprint === "preview-fingerprint" &&
        applied.params.mode === "both",
      "回退目标或范围丢失",
    );
    check(document.body.textContent.includes("会话切换成功"), "回退没有切换新会话");
    await mount();
    await command("/clear");
    check(
      document.querySelector(".conversation-transcript")?.textContent.includes("原始历史消息"),
      "clear 隐藏了历史",
    );
    await command("/exit");
    check(!calls.some((item) => item.method === "quit"), "exit 意外退出了应用");
    await command("/resume");
    await click("第二个会话");
    check(document.body.textContent.includes("会话切换成功"), "选择会话没导航");
    await mount();
    await command("/new");
    check(document.body.textContent.includes("新任务页面"), "/new 没有打开新任务");
    await mount();
    await act(async () => {
      navigateTest("/task/new");
      await wait();
    });
    await command("/resume");
    check(
      document.body.textContent.includes("另一个项目的会话") &&
        document.body.textContent.includes("第二个会话"),
      "无项目 resume 未打开全局会话工作库",
    );
    await mount();
    await command("/sessions");
    await click("打开会话工作库");
    check(
      document.body.textContent.includes("第二个会话") &&
        !document.body.textContent.includes("另一个项目的会话"),
      "会话工作库没有按来源项目筛选",
    );
    await mount();
    await command("/usage");
    await click("打开用量统计");
    check(
      calls.findLast((item) => item.method === "query-usage")?.input.workspacePath === "/fixture",
      "用量入口没有按来源项目查询",
    );
    await mount(true);
    await command("/goal pause");
    check(
      calls.findLast((item) => item.method === "goal-control")?.ref.sessionId === "side-1",
      "侧边命令作用到了主会话",
    );
    await mount();
    failNext = "ipc";
    await command("/agent reviewer 检查任务");
    check(editor().textContent === "/agent reviewer 检查任务", "失败丢失输入草稿");
    const lastCommand = () => calls.findLast((item) => item.method === "command");
    const retryId = lastCommand().requestId;
    failNext = "rpc";
    await command("/agent reviewer 检查任务");
    check(lastCommand().requestId === retryId, "IPC 失败重试更换了幂等键");
    await command("/agent reviewer 检查任务");
    check(lastCommand().requestId === retryId, "发送失败重试更换了幂等键");
    await command("/agent reviewer 检查任务");
    check(lastCommand().requestId !== retryId, "已成功命令的新提交仍复用旧键");
    delayNext = true;
    await command("/goal pause");
    const pendingCount = calls.filter((item) => item.text === "/goal pause").length;
    await key("Enter");
    check(
      calls.filter((item) => item.text === "/goal pause").length === pendingCount,
      "重复执行命令",
    );
    const oldPending = commandsPending;
    await act(async () => {
      navigateTest("/session/s2?workspace=%2Ffixture");
      await wait();
    });
    delayNext = true;
    await command("/goal");
    check(
      calls.at(-1).context?.sessionId === "s2" && calls.at(-1).text === "/goal",
      "旧会话慢命令阻塞新会话输入",
    );
    const newPending = commandsPending;
    await act(async () => {
      oldPending(local({ action: "message", message: "迟到的旧会话结果" }));
      await wait();
    });
    check(!document.body.textContent.includes("迟到的旧会话结果"), "旧会话结果污染新页面");
    const pendingNewCount = calls.length;
    await key("Enter");
    check(calls.length === pendingNewCount, "旧会话完成释放了新会话的命令锁");
    await act(async () => {
      newPending(local({ action: "message", message: "新会话结果" }));
      await wait();
    });
    check(document.body.textContent.includes("新会话结果"), "新会话结果未显示");
    await mount();
    deferGoal = true;
    await command("/goal pause");
    check(goalPending, "Goal 动作未启动");
    await act(async () => {
      navigateTest("/session/s2?workspace=%2Fother");
      await wait();
    });
    const refreshCount = calls.filter((item) => item.method === "load-session").length;
    await act(async () => {
      goalPending(false);
      await wait();
    });
    check(
      calls.filter((item) => item.method === "load-session").length === refreshCount,
      "迟到的 Goal 失败刷新了旧项目",
    );
    check(
      !calls.some((item) => item.method === "reload"),
      "命令触发了全局 bootstrap，会卸载命令弹窗",
    );
    await mount();
    const selectCandidate = async (label) => {
      const candidate = [...document.querySelectorAll('.command-suggestions [role="option"]')].find(
        (item) => item.querySelector("strong")?.textContent === label,
      );
      check(candidate, "没有候选 " + label);
      await act(async () => {
        candidate.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        await wait();
      });
    };
    await type("/架构图");
    await key("Enter", { isComposing: true });
    check(!editor().querySelector("[data-astryx-token]"), "IME 插入了技能");
    await key("Enter");
    check(
      editor().querySelector("[data-astryx-token]")?.textContent.includes("archify"),
      "Skill 未插入行内标签",
    );
    const inputValue = () =>
      parseComposerDraft(
        [...editor().childNodes]
          .map((node) =>
            node instanceof HTMLElement && node.hasAttribute("data-astryx-token")
              ? node.getAttribute("data-astryx-token-value")
              : node.textContent,
          )
          .join(""),
      );
    const saved = [...editor().childNodes]
      .map((node) =>
        node instanceof HTMLElement && node.hasAttribute("data-astryx-token")
          ? node.getAttribute("data-astryx-token-value")
          : node.textContent,
      )
      .join("");
    await type(saved + "请整理 /中文 新闻");
    check(
      document.querySelector(".command-suggestions")?.textContent.includes("aihot"),
      "中文多词描述搜索失败",
    );
    await key("Enter");
    check(editor().querySelectorAll("[data-astryx-token]").length === 2, "未支持两个技能");
    const expected = inputValue();
    check(expected.references.map((ref) => ref.name).join() === "archify,aihot", "技能顺序错误");
    await act(async () => {
      navigateTest("/session/s2?workspace=%2Ffixture");
      await wait();
      navigateTest("/session/s1?workspace=%2Ffixture");
      await wait();
    });
    check(editor().querySelectorAll("[data-astryx-token]").length === 2, "切换任务丢失技能");
    const tokenDraft = [...editor().childNodes]
      .map((node) =>
        node instanceof HTMLElement && node.hasAttribute("data-astryx-token")
          ? node.getAttribute("data-astryx-token-value")
          : node.textContent,
      )
      .join("");
    await type(tokenDraft + " /arch");
    check(
      !document.querySelector(".command-suggestions")?.textContent.includes("archify"),
      "已选技能未排除",
    );
    await type(tokenDraft + " /agent reviewer");
    await selectCandidate("reviewer");
    check(document.body.textContent.includes("替换已选上下文"), "混用没有明确替换提示");
    await click("取消");
    await type(tokenDraft);
    const skill = runtime.data.catalogSkills[0];
    skill.sourceId = "changed";
    await key("Escape");
    await key("Enter");
    check(document.body.textContent.includes("来源已变化"), "来源变更未阻止提交");
    skill.sourceId = "user-agents";
    await key("Enter");
    check(
      calls
        .findLast((item) => item.method === "send")
        ?.input.skills?.map((ref) => ref.name)
        .join() === "archify,aihot",
      "多技能未结构化发送",
    );
    await act(async () => {
      navigateTest("/task/new");
      await wait();
    });
    await type("/");
    check(
      commandLabels().join() === ["/help", "/goal", "/resume"].sort().join(),
      "无会话默认菜单没有隐藏需要会话的命令",
    );
    check(
      document.querySelector(".command-suggestions")?.textContent.includes("aihot"),
      "无项目新任务缺少用户技能",
    );
    check(
      !document.querySelector(".command-suggestions")?.textContent.includes("archify"),
      "无项目泄露上一个项目的技能",
    );
    await type("/compact");
    const disabledCandidate = document.querySelector('.command-suggestions [role="option"]');
    check(
      disabledCandidate?.getAttribute("aria-disabled") === "true" &&
        disabledCandidate.textContent.includes("请先发送消息或打开历史会话。"),
      "搜索没有展示不可用命令及原因",
    );
    const commandCount = calls.filter((item) => item.method === "command").length;
    await key("Tab");
    await key("Enter");
    check(
      editor().textContent === "/compact" &&
        calls.filter((item) => item.method === "command").length === commandCount,
      "不可用候选被键盘选择或执行",
    );
    await type("");
    await click("添加上下文与模式");
    await click("选择 Skill");
    check(
      document.querySelector(".command-suggestions")?.textContent.includes("aihot"),
      "加号插入未同步候选和草稿",
    );
    await type("/中文");
    await key("Enter");
    check(
      editor().querySelector("[data-astryx-token]")?.textContent.includes("aihot"),
      "无项目不能选择用户技能",
    );
    const sentBefore = calls.filter((item) => item.method === "send").length;
    await key("Enter");
    check(
      calls.filter((item) => item.method === "send").length === sentBefore + 1 &&
        calls.findLast((item) => item.method === "send").input.text === "",
      "无参数 Skill 未提交",
    );
    await type("");
    await mount(true);
    await type("/arch");
    await key("Enter");
    check(editor().querySelector("[data-astryx-token]"), "侧边对话未复用技能菜单");
    await type("https://example.com/arch");
    check(!document.querySelector(".command-suggestions"), "URL 错误触发候选");
    const controlRef = React.createRef<ConversationComposerHandle>();
    let stopped = false;
    const renderControls = async (readOnly, disabled = false) => {
      await act(async () => {
        root.render(
          <PicoTheme>
            <SelectField
              name="permission-mode"
              label="外部权限模式"
              value="ask"
              options={[{ value: "ask", label: "请求批准" }]}
              onValueChange={() => {}}
            />
            <ConversationComposer
              inputRef={controlRef}
              value=""
              onValueChange={() => {}}
              onSubmit={() => {}}
              status="running"
              onStop={() => {
                stopped = true;
              }}
              modes={{
                planActive: false,
                graphActive: false,
                onPlanChange: () => {},
                onGraphChange: () => {},
              }}
              leadingAccessory={
                <>
                  <SelectField
                    name="permission-mode"
                    disabled
                    label="权限模式"
                    value="ask"
                    options={[{ value: "ask", label: "请求批准" }]}
                    onValueChange={() => {}}
                  />
                  <SelectField
                    name="thinking-effort"
                    label="Thinking"
                    value="default"
                    options={[{ value: "default", label: "默认" }]}
                    onValueChange={() => {}}
                  />
                  <ComposerModelPicker
                    routes={runtime.data.modelRoutes}
                    providers={[]}
                    value="p/m"
                    readOnly={readOnly}
                    disabled={disabled}
                    onChange={(id) => {
                      calls.push({ method: "readonly-model-change", id });
                    }}
                    onConfigure={() => {}}
                  />
                </>
              }
            />
          </PicoTheme>,
        );
        await wait();
      });
    };
    await renderControls(true);
    check(controlRef.current.openControl("interrupt"), "没有定位停止按钮");
    check(
      document.activeElement?.getAttribute("aria-label") === "停止运行" && !stopped,
      "定位停止执行了中断",
    );
    check(!controlRef.current.openControl("permissions"), "打开了禁用权限控件");
    await act(async () => {
      check(controlRef.current.openControl("thinking"), "没有定位思考控件");
      await wait();
    });
    check(
      [...document.querySelectorAll('[role="listbox"]')].some((list) =>
        list.closest("[popover]")?.matches(":popover-open"),
      ),
      "没有打开现有思考控件",
    );
    await act(async () => {
      check(controlRef.current.openControl("mode"), "没有打开模式菜单");
      await wait();
    });
    check(
      document
        .querySelector('.pico-composer-menu [role="menuitemcheckbox"]')
        ?.closest("[popover]")
        ?.matches(":popover-open"),
      "没有复用现有加号模式菜单",
    );
    await click("添加上下文与模式");
    await click("选择模型：模型 M");
    const readonlyChoice = [...document.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.textContent.includes("模型 N"),
    );
    check(
      readonlyChoice?.closest("[popover]")?.matches(":popover-open"),
      "运行中模型菜单不能打开查看",
    );
    check(readonlyChoice?.getAttribute("aria-disabled") === "true", "运行中模型选项未禁用");
    check(
      document.body.textContent.includes("任务执行中，可查看模型，结束后可切换"),
      "只读模型菜单缺少说明",
    );
    await act(async () => {
      readonlyChoice.click();
      await wait();
    });
    check(!calls.some((item) => item.method === "readonly-model-change"), "只读模型菜单触发了切换");
    await renderControls(true, true);
    await click("选择模型：模型 M");
    const disabledModelTrigger = document.querySelector(".composer-model-trigger");
    const modelLayer = document.querySelector(".pico-composer-model-menu")?.closest("[popover]");
    check(
      (disabledModelTrigger.disabled ||
        disabledModelTrigger.getAttribute("aria-disabled") === "true") &&
        disabledModelTrigger.getAttribute("aria-expanded") === "false" &&
        !modelLayer?.matches(":popover-open"),
      "disabled 模型选择器仍可展开",
    );
    await fetch("/result", { method: "POST", body: "PASS: desktop commands" });
  } catch (error) {
    await fetch("/result", { method: "POST", body: String(error.stack ?? error) });
  }
})();
