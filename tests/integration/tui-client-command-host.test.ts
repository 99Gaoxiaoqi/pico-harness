import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandRegistry } from "../../src/input/command-registry.js";
import {
  clientSlashSuggestions,
  handleClientLocalCommand,
  type ClientCommandHostDeps,
} from "../../src/tui/client-command-host.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

/**
 * 3-D Phase 3：客户端命令宿主（无 Ink）——LocalCommandResult 各 action 分支、
 * 选择器/面板对话框数据形状、建议源 availability 过滤。
 */

interface HostHarness {
  readonly reporter: TuiReporter;
  readonly messages: string[];
  readonly dialogs: { id: string; content: unknown }[];
  readonly switches: (string | undefined)[];
  deps: ClientCommandHostDeps;
  readonly registry: CommandRegistry;
}

function createHostHarness(): HostHarness {
  const reporter = new TuiReporter();
  const messages: string[] = [];
  const dialogs: { id: string; content: unknown }[] = [];
  const switches: (string | undefined)[] = [];
  const harness: HostHarness = {
    reporter,
    messages,
    dialogs,
    switches,
    registry: new CommandRegistry([
      {
        name: "model",
        description: "切换模型",
        usage: "/model [route]",
        availability: "idle",
        execute: () => ({ type: "local", action: "model" }),
      },
      {
        name: "steer",
        description: "转向",
        availability: "running",
        execute: () => ({ type: "local", action: "message", message: "ok" }),
      },
    ]),
    deps: undefined as unknown as ClientCommandHostDeps,
  };
  const originalPush = reporter.pushSystemMessage.bind(reporter);
  reporter.pushSystemMessage = (content: string) => {
    messages.push(content);
    originalPush(content);
  };
  harness.deps = {
    reporter,
    registry: harness.registry,
    dispatchInput: () => undefined,
    closeDialog: () => undefined,
    switchSession: (sessionId: string | undefined) => {
      switches.push(sessionId);
    },
  };
  return harness;
}

test("command host: message/clear/exit actions", () => {
  const harness = createHostHarness();
  const message = handleClientLocalCommand(
    { type: "local", action: "message", message: "提示文本" },
    harness.deps,
  );
  assert.deepEqual(message, { dialog: null, exit: false, switchedSession: undefined });
  assert.deepEqual(harness.messages, ["提示文本"]);

  const cleared = handleClientLocalCommand({ type: "local", action: "clear" }, harness.deps);
  assert.equal(cleared.dialog, null);
  assert.equal(harness.reporter.getProjection().entries.length, 0, "clear 应清空投影");

  // exit 走 effect 信号（宿主据此卸载 Ink），不直接回调。
  const exited = handleClientLocalCommand({ type: "local", action: "exit" }, harness.deps);
  assert.equal(exited.exit, true);
});

test("command host: selector dialogs carry data (model routes / sessions)", () => {
  const harness = createHostHarness();

  const model = handleClientLocalCommand(
    {
      type: "local",
      action: "model",
      ui: { kind: "open-selector", selector: "model" },
      data: { modelRoutes: [{ id: "p1/m1", name: "m1" }, { id: "p1/m2", name: "m2" }] },
    },
    harness.deps,
  );
  assert.equal(model.dialog?.id, "local-ui:model-selector");
  assert.equal(model.dialog?.layer, "modal");

  const sessions = handleClientLocalCommand(
    {
      type: "local",
      action: "resume",
      ui: { kind: "open-selector", selector: "session" },
      data: [
        { id: "s1", cwd: "C:\\ws", createdAt: new Date(1), updatedAt: new Date(2), title: "A", isCurrent: true },
        { id: "s2", cwd: "C:\\ws", createdAt: new Date(1), updatedAt: new Date(3), title: "B" },
      ],
    },
    harness.deps,
  );
  assert.equal(sessions.dialog?.id, "local-ui:session-selector");
});

test("command host: help panel uses client registry list", () => {
  const harness = createHostHarness();
  const help = handleClientLocalCommand(
    { type: "local", action: "help", ui: { kind: "open-panel", panel: "help" } },
    harness.deps,
  );
  assert.equal(help.dialog?.id, "local-ui:help");
  assert.equal(help.dialog?.layer, "overlay");
});

test("command host: rewind selector dialog carries snapshots (3-D /rewind /changes)", async () => {
  const harness = createHostHarness();
  const snapshots = [
    {
      messageId: "msg_1",
      timestamp: new Date(1_000).toISOString(),
      userPrompt: "第一条",
      trackedFileCount: 0,
      backedUpFileCount: 0,
      deletedFileCount: 0,
      messageIndex: 0,
      changedFileCount: 2,
      addedLines: 10,
      removedLines: 4,
    },
  ];
  const applied: { messageId: string; mode: string }[] = [];
  harness.deps = {
    ...harness.deps,
    getRewindDiffStat: async () => ({
      messageId: "msg_1",
      changedFileCount: 2,
      addedLines: 10,
      removedLines: 4,
      files: [
        { filePath: "src/a.ts", status: "created" as const, addedLines: 10, removedLines: 0 },
      ],
    }),
    onRewindApply: (snapshot, mode) => {
      applied.push({ messageId: snapshot.messageId, mode });
    },
  };

  // /rewind：选择器 + 快照数据 → rewind-selector 对话框（交互版经
  // getRewindDiffStat 通道装配 RewindCommandDialog）。
  const rewind = handleClientLocalCommand(
    {
      type: "local",
      action: "message",
      message: "Rewind：1 个 checkpoint 可选。",
      ui: { kind: "open-selector", selector: "rewind" },
      data: { sessionId: "s1", snapshots },
    },
    harness.deps,
  );
  assert.equal(rewind.dialog?.id, "local-ui:rewind-selector");
  assert.equal(rewind.dialog?.layer, "modal");

  // /changes：viewOnly + 预选——对话框相同，apply 回调不装配（查看型）。
  const changes = handleClientLocalCommand(
    {
      type: "local",
      action: "message",
      message: "Opening partial rewind preview.",
      ui: { kind: "open-selector", selector: "rewind" },
      data: { sessionId: "s1", snapshots, viewOnly: true, selectedMessageId: "msg_1" },
    },
    harness.deps,
  );
  assert.equal(changes.dialog?.id, "local-ui:rewind-selector");

  // 无 preview 数据源的调用方（纯浏览路径）仍可打开（兼容既有行为）。
  const browse = handleClientLocalCommand(
    {
      type: "local",
      action: "message",
      ui: { kind: "open-selector", selector: "rewind" },
      data: { sessionId: "s1", snapshots },
    },
    { ...harness.deps, getRewindDiffStat: undefined, onRewindApply: undefined },
  );
  assert.equal(browse.dialog?.id, "local-ui:rewind-selector");
  assert.deepEqual(applied, [], "宿主层不主动触发 apply（对话框回调驱动）");
});

test("command host: resume data switches session; new mode is no-op (executor已处理)", () => {
  const harness = createHostHarness();
  const resumed = handleClientLocalCommand(
    { type: "local", action: "resume", data: { mode: "resume", sessionId: "s9" } },
    harness.deps,
  );
  assert.equal(resumed.switchedSession, "s9");
  assert.deepEqual(harness.switches, ["s9"]);

  const fresh = handleClientLocalCommand(
    { type: "local", action: "resume", data: { mode: "new" } },
    harness.deps,
  );
  assert.equal(fresh.switchedSession, undefined, "/new 的切换在执行器内完成，宿主不再重复");
});

test("command host: slash suggestions annotate availability (not filter)", () => {
  const harness = createHostHarness();
  // 与 in-process InputBox 同语义：不可用命令仍出现但标 disabled（灰显）。
  const idle = clientSlashSuggestions(harness.registry, "", "idle");
  assert.deepEqual(
    idle.map((s) => [s.value, s.disabled === true]),
    [
      ["model", false],
      ["steer", true],
    ],
  );
  const running = clientSlashSuggestions(harness.registry, "", "running");
  assert.deepEqual(
    running.map((s) => [s.value, s.disabled === true]),
    [
      ["model", true],
      ["steer", false],
    ],
  );
});
