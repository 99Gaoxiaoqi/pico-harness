import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalManager, type ApprovalResult } from "../../src/approval/manager.js";
import {
  DesktopInteractionBroker,
  DesktopInteractionVersionConflictError,
} from "../../src/daemon/desktop-interaction-broker.js";
import {
  FileDesktopInteractionStore,
  type DesktopInteractionStore,
} from "../../src/daemon/desktop-interaction-store.js";
import {
  AskUserHandler,
  createAskUserRequestId,
  type AskUserAnswer,
} from "../../src/tools/ask-user.js";

test("approval 使用 expectedVersion 防止竞争，相同 resolution 幂等", async (context) => {
  const fixture = await createFixture(context, "approval");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const manager = new ApprovalManager(60_000);
  const broker = new DesktopInteractionBroker({
    store,
    ownerKey: "main:session-1:run-1",
    approvalManager: manager,
  });
  await broker.recover();
  const waiting = requestApproval(broker, manager, "approval-1");
  await broker.idle();
  assert.deepEqual(recordSummary(broker), ["approval:approval-1:pending:1"]);

  assert.throws(
    () =>
      broker.resolveApproval({
        taskId: "approval-1",
        decision: "approve",
        expectedVersion: 9,
      }),
    (error: unknown) =>
      error instanceof DesktopInteractionVersionConflictError && error.currentVersion === 1,
  );
  assert.equal(manager.pendingCount, 1);

  const resolved = await broker.resolveApprovalVersioned({
    taskId: "approval-1",
    decision: "approve",
    expectedVersion: 1,
  });
  assert.deepEqual(resolved, { accepted: true, alreadyResolved: false, version: 2 });
  assert.deepEqual(await waiting, {
    allowed: true,
    reason: "用户在桌面端批准了本次操作。",
  });

  const duplicate = await broker.resolveApprovalVersioned({
    taskId: "approval-1",
    decision: "approve",
    expectedVersion: 1,
  });
  assert.deepEqual(duplicate, { accepted: true, alreadyResolved: true, version: 2 });
  assert.throws(
    () => broker.resolveApproval({ taskId: "approval-1", decision: "reject" }),
    DesktopInteractionVersionConflictError,
  );
  assert.deepEqual(recordSummaryFrom(await store.load("main:session-1:run-1")), [
    "approval:approval-1:resolved:2",
  ]);
  await broker.closeAsync();
});

test("prompt resolution 不持久化答案原文，optionId/label 重试幂等", async (context) => {
  const fixture = await createFixture(context, "prompt");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const handler = new AskUserHandler();
  const broker = new DesktopInteractionBroker({
    store,
    ownerKey: "side:session-1:chat-1",
    askUserHandler: handler,
  });
  await broker.recover();
  const requestId = createAskUserRequestId();
  const waiting = handler.waitForAnswer({
    requestId,
    question: "选择一个敏感答案？",
    options: [
      { optionId: "option-1", label: "敏感选项 A" },
      { optionId: "option-2", label: "选项 B" },
    ],
  });
  await broker.idle();
  const resolved = await broker.answerPromptVersioned({
    requestId,
    answer: "敏感选项 A",
    expectedVersion: 1,
  });
  assert.deepEqual(resolved, { accepted: true, alreadyResolved: false, version: 2 });
  assert.equal((await waiting).kind, "selected");
  assert.deepEqual(
    await broker.answerPromptVersioned({ requestId, answer: "option-1", expectedVersion: 1 }),
    { accepted: true, alreadyResolved: true, version: 2 },
  );
  assert.throws(
    () => broker.answerPrompt(requestId, "option-2"),
    DesktopInteractionVersionConflictError,
  );
  const serialized = JSON.stringify(await store.load("side:session-1:chat-1"));
  assert.doesNotMatch(serialized, /敏感答案|敏感选项 A/u);
  assert.doesNotMatch(serialized, /[a-f\d]{64}/u);
  await broker.closeAsync();
});

test("恢复把旧 pending 单调转为 interrupted，不重建可处理请求", async (context) => {
  const fixture = await createFixture(context, "recover");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const oldManager = new ApprovalManager(60_000);
  const oldHandler = new AskUserHandler();
  const oldBroker = new DesktopInteractionBroker({
    store,
    ownerKey: "main:session-2:run-old",
    approvalManager: oldManager,
    askUserHandler: oldHandler,
  });
  await oldBroker.recover();
  const approvalWaiting = requestApproval(oldBroker, oldManager, "approval-old");
  const promptId = createAskUserRequestId();
  const promptWaiting = oldHandler.waitForAnswer({
    requestId: promptId,
    question: "old prompt",
    options: [
      { optionId: "a", label: "A" },
      { optionId: "b", label: "B" },
    ],
  });
  await oldBroker.idle();

  const recovered = new DesktopInteractionBroker({
    store,
    ownerKey: "main:session-2:run-old",
  });
  const records = await recovered.recover();
  assert.deepEqual(recordSummaryFrom(records), [
    "approval:approval-old:interrupted:3",
    `prompt:${promptId}:interrupted:4`,
  ]);
  assert.deepEqual(recovered.listPendingApprovals(), []);
  assert.equal(recovered.askUserHandler.pendingCount, 0);
  assert.equal(recovered.resolveApproval({ taskId: "approval-old", decision: "approve" }), false);
  assert.equal(recovered.answerPrompt(promptId, "a"), false);

  oldBroker.close();
  assert.equal((await approvalWaiting).allowed, false);
  assert.equal((await promptWaiting).kind, "cancelled");
  await recovered.closeAsync();
});

test("close 持久化 interrupted；prompt abort 持久化 expired", async (context) => {
  const fixture = await createFixture(context, "close");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const manager = new ApprovalManager(60_000);
  const handler = new AskUserHandler();
  const broker = new DesktopInteractionBroker({
    store,
    ownerKey: "main:session-close:run-1",
    approvalManager: manager,
    askUserHandler: handler,
  });
  await broker.recover();
  const approvalWaiting = requestApproval(broker, manager, "approval-close");
  const promptId = createAskUserRequestId();
  const promptWaiting = handler.waitForAnswer({
    requestId: promptId,
    question: "close?",
    options: [
      { optionId: "a", label: "A" },
      { optionId: "b", label: "B" },
    ],
  });
  await broker.closeAsync();
  await broker.closeAsync();
  assert.equal((await approvalWaiting).allowed, false);
  assert.equal((await promptWaiting).kind, "cancelled");
  assert.deepEqual(recordSummaryFrom(await store.load("main:session-close:run-1")), [
    "approval:approval-close:interrupted:3",
    `prompt:${promptId}:interrupted:4`,
  ]);

  const abortBroker = new DesktopInteractionBroker({
    store,
    ownerKey: "side:session-close:chat-2",
  });
  await abortBroker.recover();
  const controller = new AbortController();
  const abortedId = createAskUserRequestId();
  const aborted = abortBroker.askUserHandler.waitForAnswer(
    {
      requestId: abortedId,
      question: "abort?",
      options: [
        { optionId: "a", label: "A" },
        { optionId: "b", label: "B" },
      ],
    },
    controller.signal,
  );
  controller.abort(new Error("run stopped"));
  await assert.rejects(aborted, /run stopped/u);
  await abortBroker.idle();
  assert.deepEqual(recordSummaryFrom(await store.load("side:session-close:chat-2")), [
    `prompt:${abortedId}:expired:2`,
  ]);
  await abortBroker.closeAsync();
});

test("approval 超时后持久化 expired，不再接受过期决策", async (context) => {
  const fixture = await createFixture(context, "expired");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const manager = new ApprovalManager(5);
  const broker = new DesktopInteractionBroker({
    store,
    ownerKey: "main:session-expired:run-1",
    approvalManager: manager,
    approvalTtlMs: 10,
  });
  await broker.recover();
  const waiting = requestApproval(broker, manager, "approval-expired");
  assert.equal((await waiting).allowed, false);
  await waitFor(
    () => broker.listInteractionRecords()[0]?.status === "expired",
    "approval expiration",
  );
  await broker.idle();
  assert.deepEqual(recordSummaryFrom(await store.load("main:session-expired:run-1")), [
    "approval:approval-expired:expired:2",
  ]);
  assert.equal(broker.resolveApproval({ taskId: "approval-expired", decision: "approve" }), false);
  await broker.closeAsync();
});

test("同一 File store 隔离主对话与 Side Chat owner version", async (context) => {
  const fixture = await createFixture(context, "shared");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const main = new DesktopInteractionBroker({ store, ownerKey: "main:session-3:run-1" });
  const side = new DesktopInteractionBroker({ store, ownerKey: "side:session-3:chat-1" });
  await main.recover();
  await side.recover();
  const mainWaiting = pendingPrompt(main, "main question");
  const sideWaiting = pendingPrompt(side, "side question");
  await Promise.all([main.idle(), side.idle()]);
  assert.equal((await store.load("main:session-3:run-1"))[0]?.version, 1);
  assert.equal((await store.load("side:session-3:chat-1"))[0]?.version, 1);
  await Promise.all([main.closeAsync(), side.closeAsync()]);
  assert.equal((await mainWaiting).kind, "cancelled");
  assert.equal((await sideWaiting).kind, "cancelled");
});

test("监听异常与 pending 事件同步重入不能破坏权威状态", async () => {
  const listenerErrors: unknown[] = [];
  const broker = new DesktopInteractionBroker({
    ownerKey: "side:listener:chat-1",
    onListenerError: (error) => listenerErrors.push(error),
  });
  broker.subscribe(() => {
    throw new Error("renderer failed");
  });
  broker.subscribe((event) => {
    if (event.kind === "prompt.pending") {
      assert.equal(
        broker.answerPrompt(event.request.requestId, event.request.options[0]!.optionId),
        true,
      );
    }
  });
  const answer = await pendingPrompt(broker, "reentrant question");
  assert.equal(answer.kind, "selected");
  await broker.idle();
  assert.equal(listenerErrors.length, 2);
  assert.match(recordSummary(broker)[0] ?? "", /:resolved:/u);
  await broker.closeAsync();
});

test("store 模式恢复前与 close 后的新请求均立即 fail-closed", async (context) => {
  const fixture = await createFixture(context, "lifecycle-gate");
  const store = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const manager = new ApprovalManager(60_000);
  const broker = new DesktopInteractionBroker({
    store,
    ownerKey: "main:gate:run-1",
    approvalManager: manager,
  });
  assert.equal((await requestApproval(broker, manager, "before-recover")).allowed, false);
  assert.equal((await pendingPrompt(broker, "before recover")).kind, "cancelled");
  await broker.recover();
  await broker.closeAsync();
  assert.equal((await requestApproval(broker, manager, "after-close")).allowed, false);
  assert.equal((await pendingPrompt(broker, "after close")).kind, "cancelled");
});

test("版本化批准在持久 CAS 失败时保持 fail-closed", async (context) => {
  const fixture = await createFixture(context, "fail-closed");
  const delegate = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  const store: DesktopInteractionStore = {
    load: (ownerKey) => delegate.load(ownerKey),
    interruptPending: (ownerKey, at) => delegate.interruptPending(ownerKey, at),
    commit: async (input) => {
      if (input.record.status !== "pending") throw new Error("disk unavailable");
      return delegate.commit(input);
    },
  };
  const manager = new ApprovalManager(60_000);
  const broker = new DesktopInteractionBroker({
    store,
    ownerKey: "main:failure:run-1",
    approvalManager: manager,
  });
  await broker.recover();
  const waiting = requestApproval(broker, manager, "approval-failure");
  await broker.idle();
  assert.equal(
    broker.resolveApproval({
      taskId: "approval-failure",
      decision: "approve",
      expectedVersion: 1,
    }),
    false,
  );
  assert.equal(manager.pendingCount, 1);
  await assert.rejects(
    broker.resolveApprovalVersioned({
      taskId: "approval-failure",
      decision: "approve",
      expectedVersion: 1,
    }),
    /disk unavailable/u,
  );
  assert.equal(manager.pendingCount, 1);
  broker.close();
  assert.equal((await waiting).allowed, false);
});

test("同路径的两个 File store 实例不会互相覆盖", async (context) => {
  const fixture = await createFixture(context, "two-stores");
  const main = new DesktopInteractionBroker({
    store: new FileDesktopInteractionStore({ picoHome: fixture.picoHome }),
    ownerKey: "main:two-store:run-1",
  });
  const side = new DesktopInteractionBroker({
    store: new FileDesktopInteractionStore({ picoHome: fixture.picoHome }),
    ownerKey: "side:two-store:chat-1",
  });
  await Promise.all([main.recover(), side.recover()]);
  const mainWaiting = pendingPrompt(main, "main");
  const sideWaiting = pendingPrompt(side, "side");
  await Promise.all([main.idle(), side.idle()]);
  assert.equal(main.listInteractionRecords().length, 1);
  assert.equal(side.listInteractionRecords().length, 1);
  const verifier = new FileDesktopInteractionStore({ picoHome: fixture.picoHome });
  assert.equal((await verifier.load("main:two-store:run-1")).length, 1);
  assert.equal((await verifier.load("side:two-store:chat-1")).length, 1);
  await Promise.all([main.closeAsync(), side.closeAsync()]);
  assert.equal((await mainWaiting).kind, "cancelled");
  assert.equal((await sideWaiting).kind, "cancelled");
});

function requestApproval(
  broker: DesktopInteractionBroker,
  manager: ApprovalManager,
  taskId: string,
): Promise<ApprovalResult> {
  return manager.waitForApproval(
    taskId,
    "bash",
    '{"command":"private command"}',
    broker.notifyApproval,
    undefined,
    undefined,
    { providerCallId: `call-${taskId}` },
  );
}

function pendingPrompt(broker: DesktopInteractionBroker, question: string): Promise<AskUserAnswer> {
  return broker.askUserHandler.waitForAnswer({
    requestId: createAskUserRequestId(),
    question,
    options: [
      { optionId: "a", label: "A" },
      { optionId: "b", label: "B" },
    ],
  });
}

function recordSummary(broker: DesktopInteractionBroker): string[] {
  return recordSummaryFrom(broker.listInteractionRecords());
}

function recordSummaryFrom(
  records: readonly {
    kind: string;
    interactionId: string;
    status: string;
    version: number;
  }[],
): string[] {
  return records.map(
    (record) => `${record.kind}:${record.interactionId}:${record.status}:${record.version}`,
  );
}

async function createFixture(
  context: { after(callback: () => Promise<void> | void): void },
  name: string,
): Promise<{ root: string; picoHome: string }> {
  const root = await mkdtemp(join(tmpdir(), `pico-desktop-interaction-${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome, { recursive: true });
  return { root: await realpath(root), picoHome: await realpath(picoHome) };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
