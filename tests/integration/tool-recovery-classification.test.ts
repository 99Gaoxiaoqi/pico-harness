// ADR 27 P0 工具半执行诚实恢复集成测试（indeterminate 分类）。
//
// 恢复决策表:
// | failpoint | 事件流状态 | 分类 | 恢复动作 |
// |---|---|---|---|
// | F1 assistant 已提交、未派发 | message.committed 含 toolCalls,无 tool.started | not_dispatched | 合成 result 声明未执行 |
// | F2 已派发、无结果 | tool.started 已落库,无 result | indeterminate | 合成 result 显式标记可能已执行、结果未知 |
// | F3 结果已落库 | started + result 齐全 | completed | 不动,绝不重执行 |
//
// 验收不变量:
// - I1 恢复期绝不重执行悬空工具:执行必须先落 tool.started(派发顺序硬约束),
//   因此断言 reconcile 后零新增 tool.started 且悬空调的唯一 result 是 synthetic 恢复结果。
// - I2 indeterminate 合成结果携带显式标记,模型可见文案如实("可能已实际执行")。
// - I3 not_dispatched 合成结果声明未执行("从未交给执行器执行")。
// - I4 二次 reconcile 不重复产生事件(既有幂等分支 / 确定性 eventId 重放)。
// - I5 F1/F2/F3 failpoint 矩阵,分类唯一互斥。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../../src/engine/session.js";
import type { EngineRuntimeToolResultInput } from "../../src/engine/runtime-port.js";
import type { Message, ToolCall } from "../../src/schema/message.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import type { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";

interface RecoveryScene {
  readonly session: Session;
  readonly store: SqliteRuntimeEventStore;
  readonly run: RuntimeRun;
}

async function createScene(context: test.TestContext, sessionId: string): Promise<RecoveryScene> {
  const root = await mkdtemp(join(tmpdir(), `pico-tool-recovery-${sessionId}-`));
  const session = new Session(sessionId, join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  });
  context.after(async () => {
    await session.close();
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const store = session.runtimeEventStore;
  assert.ok(store, "durable session must expose its runtime event store");
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  await run.recordTurnStarted(1);
  return { session, store, run };
}

function toolCall(id: string): ToolCall {
  return { id, name: "write_file", arguments: '{"path":"out.txt","content":"side-effect"}' };
}

function assistantToolCallMessage(...calls: readonly ToolCall[]): Message {
  return { role: "assistant", content: "", toolCalls: [...calls] };
}

function inlineResultInput(call: ToolCall, content: string): EngineRuntimeToolResultInput {
  return {
    toolCallId: call.id,
    toolName: call.name,
    status: "succeeded",
    body: {
      storage: "inline",
      content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    },
    projection: { version: 1, mode: "full", text: content, strategy: "full", truncated: false },
  };
}

function startedEventsFor(events: readonly RuntimeEvent[], toolCallId: string): RuntimeEvent[] {
  return events.filter(
    (event) => event.kind === "tool.started" && event.refs?.toolCallId === toolCallId,
  );
}

function resultEventsFor(
  events: readonly RuntimeEvent[],
  toolCallId: string,
): Extract<RuntimeEvent, { kind: "tool.result.recorded" }>[] {
  return events.filter(
    (event): event is Extract<RuntimeEvent, { kind: "tool.result.recorded" }> =>
      event.kind === "tool.result.recorded" && event.refs?.toolCallId === toolCallId,
  );
}

async function readEvents(scene: RecoveryScene): Promise<readonly RuntimeEvent[]> {
  return scene.store.readSession(scene.session.id);
}

async function reconcile(scene: RecoveryScene): Promise<string[]> {
  return RuntimeRun.reconcileIncompleteRuns({
    capability: scene.session.runtimeEventCapability!,
  });
}

test("F1 assistant 已提交未派发 → not_dispatched 合成结果声明未执行（I3/I5），恢复期零重执行（I1）", async (context) => {
  const scene = await createScene(context, "tool-recovery-f1");
  const call = toolCall("call:f1-not-dispatched");
  await scene.run.commitMessages(scene.session, [assistantToolCallMessage(call)]);

  const before = await readEvents(scene);
  assert.equal(startedEventsFor(before, call.id).length, 0);

  assert.deepEqual(await reconcile(scene), [scene.run.runId]);

  const after = await readEvents(scene);
  // I1:派发顺序硬约束下,重执行必先落新的 tool.started——这里必须保持零派发。
  assert.equal(startedEventsFor(after, call.id).length, 0);
  const results = resultEventsFor(after, call.id);
  assert.equal(results.length, 1);
  const result = results[0]!;
  // I3:显式分类 + 未执行声明;不得出现 indeterminate 的"可能已执行"措辞。
  assert.equal(result.data.recovery?.classification, "not_dispatched");
  assert.equal(result.data.projection.mode, "synthetic");
  assert.equal(result.data.projection.strategy, "runtime-interruption-recovery");
  assert.ok(result.data.projection.text.includes("从未交给执行器执行"));
  assert.ok(!result.data.projection.text.includes("可能已实际执行"));
  // 恢复只补齐 transcript start + 合成 result + interrupted 终态,无其他写入。
  assert.deepEqual(
    after.map((event) => event.kind),
    [
      ...before.map((event) => event.kind),
      "transcript.event.recorded",
      "tool.result.recorded",
      "run.terminal",
    ],
  );
  const terminal = after.at(-1)!;
  assert.equal(terminal.kind, "run.terminal");
  assert.equal(terminal.data.status, "interrupted");
});

test("F2 已派发无结果 → indeterminate 合成结果如实声明可能已执行（I2/I5），恢复期零重执行（I1）", async (context) => {
  const scene = await createScene(context, "tool-recovery-f2");
  const call = toolCall("call:f2-indeterminate");
  await scene.run.commitMessages(scene.session, [assistantToolCallMessage(call)]);
  await scene.run.recordToolStarted(call.id, call.name, call.arguments);

  const before = await readEvents(scene);
  assert.equal(startedEventsFor(before, call.id).length, 1);

  assert.deepEqual(await reconcile(scene), [scene.run.runId]);

  const after = await readEvents(scene);
  // I1:不重派发——tool.started 仍只有崩溃前那一条。
  assert.equal(startedEventsFor(after, call.id).length, 1);
  const results = resultEventsFor(after, call.id);
  assert.equal(results.length, 1);
  const result = results[0]!;
  // I2:显式 indeterminate 标记 + 对模型可见文案如实("可能已实际执行"、"结果未知")。
  assert.equal(result.data.recovery?.classification, "indeterminate");
  assert.equal(result.data.projection.mode, "synthetic");
  assert.ok(result.data.projection.text.includes("可能已实际执行"));
  assert.ok(result.data.projection.text.includes("结果未知"));
  assert.ok(!result.data.projection.text.includes("从未交给执行器执行"));

  // I2(模型可见):repair 后模型上下文里的该 toolCall 文案必须如实携带不确定性。
  await RuntimeRun.repairSessionProjection(scene.session, {
    capability: scene.session.runtimeEventCapability!,
  });
  const visible = scene.session.getModelContext().find((message) => message.toolCallId === call.id);
  assert.ok(visible, "synthetic recovery result must enter the model context");
  assert.ok(visible.content.includes("可能已实际执行"));
});

test("F3 结果已落库 → completed 不动，绝不重执行（I5/I1）", async (context) => {
  const scene = await createScene(context, "tool-recovery-f3");
  const call = toolCall("call:f3-completed");
  await scene.run.commitMessages(scene.session, [assistantToolCallMessage(call)]);
  await scene.run.recordToolStarted(call.id, call.name, call.arguments);
  const resultMessage = scene.run.registerToolResult(
    inlineResultInput(call, "real executed output"),
  );
  await scene.run.commitMessages(scene.session, [resultMessage]);

  const before = await readEvents(scene);
  assert.equal(startedEventsFor(before, call.id).length, 1);
  assert.equal(resultEventsFor(before, call.id).length, 1);
  const beforeEventIds = before.map((event) => event.eventId);

  await reconcile(scene);

  const after = await readEvents(scene);
  // I1:零重派发、零重复结果;唯一新增事件是补齐的 interrupted 终态事实。
  assert.equal(startedEventsFor(after, call.id).length, 1);
  const results = resultEventsFor(after, call.id);
  assert.equal(results.length, 1);
  const original = results[0]!;
  assert.equal(original.data.projection.mode, "full");
  assert.equal(original.data.body.storage, "inline");
  if (original.data.body.storage === "inline") {
    assert.equal(original.data.body.content, "real executed output");
  }
  assert.deepEqual(
    after.map((event) => event.eventId),
    [...beforeEventIds, after.at(-1)!.eventId],
  );
  // F3 分类:绝不产生任何 recovery 合成事实。
  assert.equal(after.at(-1)!.kind, "run.terminal");
  for (const event of after) {
    if (event.kind === "tool.result.recorded") {
      assert.equal(event.data.recovery, undefined, "completed results must stay untouched");
    }
  }
});

test("I4 恢复幂等（同 run 分支）：二次 reconcile 走既有幂等分支，不产生任何新事件", async (context) => {
  const scene = await createScene(context, "tool-recovery-idempotent");
  const call = toolCall("call:idempotent-indeterminate");
  await scene.run.commitMessages(scene.session, [assistantToolCallMessage(call)]);
  await scene.run.recordToolStarted(call.id, call.name, call.arguments);

  assert.deepEqual(await reconcile(scene), [scene.run.runId]);
  const firstPassEvents = await readEvents(scene);
  const firstPass = firstPassEvents.map((event) => event.eventId);
  assert.equal(resultEventsFor(firstPassEvents, call.id).length, 1);

  const second = await reconcile(scene);
  assert.deepEqual(second, [], "second reconcile must not report any newly inserted run");
  const secondPassEvents = await readEvents(scene);
  assert.deepEqual(
    secondPassEvents.map((event) => event.eventId),
    firstPass,
    "second reconcile must not append any event",
  );
  assert.equal(resultEventsFor(secondPassEvents, call.id).length, 1);
});

test("I4 strict seal 拒绝带 prepared 工具的终态，reconcile 先 T2 再封口且幂等", async (context) => {
  const scene = await createScene(context, "tool-recovery-idempotent-replay");
  const call = toolCall("call:idempotent-replay");
  await scene.run.commitMessages(scene.session, [assistantToolCallMessage(call)]);
  await scene.run.recordToolStarted(call.id, call.name, call.arguments);
  await assert.rejects(
    scene.run.finish("completed"),
    /prepared tool operation\(s\) without outcome/u,
  );
  assert.equal(
    (await readEvents(scene)).some((event) => event.kind === "run.terminal"),
    false,
    "strict seal must leave the run open for recovery T2",
  );

  assert.deepEqual(await reconcile(scene), [scene.run.runId]);
  const firstPassEvents = await readEvents(scene);
  const firstPass = firstPassEvents.map((event) => event.eventId);
  const firstResults = resultEventsFor(firstPassEvents, call.id);
  assert.equal(firstResults.length, 1);
  assert.equal(firstResults[0]!.data.recovery?.classification, "indeterminate");

  // 二次 reconcile 对同一悬空调派生同一组确定性 eventId,重放走幂等分支。
  const second = await reconcile(scene);
  assert.deepEqual(second, [], "replayed deterministic events must not count as inserted");
  const secondPassEvents = await readEvents(scene);
  assert.deepEqual(
    secondPassEvents.map((event) => event.eventId),
    firstPass,
  );
});

test("I5 分类矩阵：同一 run 内 F1/F2 混合并存，逐调用分类唯一互斥", async (context) => {
  const scene = await createScene(context, "tool-recovery-matrix");
  const dispatchedCall = toolCall("call:matrix-dispatched");
  const notDispatchedCall = toolCall("call:matrix-not-dispatched");
  await scene.run.commitMessages(scene.session, [
    assistantToolCallMessage(dispatchedCall, notDispatchedCall),
  ]);
  await scene.run.recordToolStarted(
    dispatchedCall.id,
    dispatchedCall.name,
    dispatchedCall.arguments,
  );

  assert.deepEqual(await reconcile(scene), [scene.run.runId]);

  const events = await readEvents(scene);
  const dispatchedResults = resultEventsFor(events, dispatchedCall.id);
  const notDispatchedResults = resultEventsFor(events, notDispatchedCall.id);
  assert.equal(dispatchedResults.length, 1);
  assert.equal(notDispatchedResults.length, 1);
  assert.equal(dispatchedResults[0]!.data.recovery?.classification, "indeterminate");
  assert.equal(notDispatchedResults[0]!.data.recovery?.classification, "not_dispatched");
  // 互斥:两份模型可见文案不得互换。
  assert.ok(dispatchedResults[0]!.data.projection.text.includes("可能已实际执行"));
  assert.ok(notDispatchedResults[0]!.data.projection.text.includes("从未交给执行器执行"));
  assert.ok(!dispatchedResults[0]!.data.projection.text.includes("从未交给执行器执行"));
  assert.ok(!notDispatchedResults[0]!.data.projection.text.includes("可能已实际执行"));
});
