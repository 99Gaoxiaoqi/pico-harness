// ADR 27 P1 写失败读回仲裁集成测试。
//
// 验收不变量:
// - A1 仲裁只允许"确认全部落地"一种翻案;缺任一事件不得恢复可写。
// - A2 仲裁路径自身不得产生任何新写入(只读)。
// - A3 仲裁过程异常 → 等价不仲裁(保守回落 write_uncertain)。
//
// 注入面(ADR 27 集成测试注入面建议):以 Proxy 包装 Session 的 durable store,
// 在 appendBatch 真正成功落地后向上抛错,模拟"上层收到失败信号但事务已提交"。
// 仲裁读回走公开点查 readEventRowsByEventIds,可通过同一 Proxy 注入读回失败。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../src/schema/message.js";
import { Session } from "../../src/engine/session.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { EngineRuntimePort, EngineRuntimeRun } from "../../src/engine/runtime-port.js";
import type {
  AppendRuntimeEventBatchOptions,
  RuntimeEventStoreAppendResult,
} from "../../src/storage/runtime-event-store-contracts.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import {
  SqliteRuntimeEventStore,
  type RuntimeEventPointRead,
} from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";

/** 一次性注入计划:只影响 arm() 之后的第一次 appendBatch。 */
interface FailureSeamPlan {
  /** append(部分)成功落地后向上抛出的失败信号。 */
  readonly appendError: Error;
  /** 落地前从批尾剔除的事件数(模拟"任一 event_id 缺失"的部分落地)。 */
  readonly dropTailEvents?: number;
  /** 读回点查接口抛错(模拟仲裁时存储不可用,A3)。 */
  readonly readBackError?: Error;
}

function attachFailureSeam(
  realStore: SqliteRuntimeEventStore,
  plan: FailureSeamPlan,
): { wrapped: SqliteRuntimeEventStore; arm: () => void } {
  let injectNextAppendBatch = false;
  const wrapped = new Proxy(realStore, {
    get(target, property) {
      if (property === "appendBatch") {
        return (
          events: readonly RuntimeEvent[],
          options?: AppendRuntimeEventBatchOptions,
        ): Promise<readonly RuntimeEventStoreAppendResult[]> => {
          if (!injectNextAppendBatch) return target.appendBatch(events, options);
          injectNextAppendBatch = false;
          const dropped = plan.dropTailEvents ?? 0;
          const landed = dropped > 0 ? events.slice(0, events.length - dropped) : events;
          return target.appendBatch(landed, options).then(() => {
            throw plan.appendError;
          });
        };
      }
      if (property === "readEventRowsByEventIds" && plan.readBackError) {
        return (): Promise<ReadonlyMap<string, RuntimeEventPointRead>> =>
          Promise.reject(plan.readBackError);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (value as (...fnArgs: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { wrapped, arm: () => (injectNextAppendBatch = true) };
}

interface ArbitrationScene {
  readonly session: Session;
  readonly realStore: SqliteRuntimeEventStore;
  readonly arm: () => void;
}

async function createArbitrationScene(
  sessionId: string,
  plan: FailureSeamPlan,
): Promise<ArbitrationScene & { cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pico-write-arbitration-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  // 最小 RuntimePort:让 session.commitMessages 走真实生产链
  // (enqueuePersistence → currentRun → RuntimeRun.commitMessages → markWriteUncertain)。
  const currentRunRef: { run?: EngineRuntimeRun } = {};
  const runtimePort: EngineRuntimePort = {
    currentRun: () => currentRunRef.run,
    currentToolCallId: () => undefined,
    runWithToolCall: (_toolCallId, execute) => execute(),
    reconcileIncompleteRuns: async () => [],
    repairSessionProjection: async () => false,
    startRun: async () => {
      throw new Error("write-recovery-arbitration test does not use startRun");
    },
    commitExternalMessages: async () => false,
    commitExternalMessageOnce: async () => undefined,
  };
  const session = new Session(sessionId, workDir, { persistence: true, picoHome, runtimePort });
  const cleanup = async (): Promise<void> => {
    await session.close();
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  };
  await session.recover();
  const realStore = session.runtimeEventStore;
  assert.ok(realStore, "durable session must expose its runtime event store");

  const seam = attachFailureSeam(realStore, plan);
  // 测试注入缝:替换 Session 的私有 store 引用,使 capability 与 RuntimeRun
  // 都经由包装后的 store 写入(私有字段无公开注入口,测试用受控替换)。
  (session as unknown as { store: SqliteRuntimeEventStore }).store = seam.wrapped;
  const run = await RuntimeRun.start({ capability: session.runtimeEventCapability! });
  currentRunRef.run = run;
  return { session, realStore, arm: seam.arm, cleanup };
}

function userMessage(content: string): Message {
  return { role: "user", content };
}

test("写失败读回仲裁：append 成功后收到失败信号且读回全部落地 → 等价正常返回，会话保持可写（A1 确认翻案 + A2 只读）", async (context) => {
  const injected = new Error("injected durable append failure");
  const scene = await createArbitrationScene("write-arbitration-recovered", {
    appendError: injected,
  });
  context.after(scene.cleanup);

  scene.arm();
  // 失败信号在批全部落地后抛出:仲裁读回确认全部落地 → 等价正常返回,不 reject。
  await scene.session.commitMessages(
    userMessage("arbitration-one"),
    userMessage("arbitration-two"),
  );

  // A2:账本里只有 run.started + 两条 message.committed,仲裁自身零新增写入。
  const events = await scene.realStore.readSession(scene.session.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["run.started", "message.committed", "message.committed"],
  );

  // 会话保持可写:后续 append 正常,内存投影从 durable 真值重建。
  await scene.session.commitMessages(userMessage("after-recovery"));
  const after = await scene.realStore.readSession(scene.session.id);
  assert.deepEqual(
    after.map((event) => event.kind),
    ["run.started", "message.committed", "message.committed", "message.committed"],
  );
  const modelContext = scene.session.getModelContext();
  assert.deepEqual(
    modelContext.map((message) => message.content),
    ["arbitration-one", "arbitration-two", "after-recovery"],
  );
});

test("写失败读回仲裁：批内一条事件缺失 → 照旧 markWriteUncertain 停写（A1 拒绝翻案）", async (context) => {
  const injected = new Error("injected durable append failure");
  const scene = await createArbitrationScene("write-arbitration-missing-event", {
    appendError: injected,
    dropTailEvents: 1,
  });
  context.after(scene.cleanup);

  scene.arm();
  // 批尾一条事件被剔除后落地,失败信号触发仲裁:读回缺一条 → 重抛原始异常。
  await assert.rejects(
    scene.session.commitMessages(userMessage("partial-one"), userMessage("partial-missing")),
    (error: unknown) => error === injected,
  );

  // 只有第一条消息落地;会话进入 write_uncertain,后续写入全部被拒。
  const events = await scene.realStore.readSession(scene.session.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["run.started", "message.committed"],
  );
  await assert.rejects(
    scene.session.commitMessages(userMessage("blocked-after-missing")),
    /durable commit failed/u,
  );
});

test("写失败读回仲裁：读回接口自身抛错 → 保守回落 write_uncertain（A3）", async (context) => {
  const injected = new Error("injected durable append failure");
  const scene = await createArbitrationScene("write-arbitration-readback-failure", {
    appendError: injected,
    readBackError: new Error("injected storage unavailable during arbitration"),
  });
  context.after(scene.cleanup);

  scene.arm();
  // 批实际全部落地,但仲裁读回不可用:仲裁异常等价于不仲裁 → 重抛原始异常。
  await assert.rejects(
    scene.session.commitMessages(userMessage("landed-one"), userMessage("landed-two")),
    (error: unknown) => error === injected,
  );

  // 尽管事件已全部落地,会话仍保守进入 write_uncertain 停写。
  const events = await scene.realStore.readSession(scene.session.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["run.started", "message.committed", "message.committed"],
  );
  await assert.rejects(
    scene.session.commitMessages(userMessage("blocked-after-readback-failure")),
    /durable commit failed/u,
  );
});

test("写失败读回仲裁：确定性契约拒绝（fingerprint CAS 冲突）不被翻案", async (context) => {
  const scene = await createArbitrationScene("write-arbitration-cas-refusal", {
    appendError: new Error("unused"),
  });
  context.after(scene.cleanup);

  const planEvent = {
    schemaVersion: 2,
    eventId: `${scene.session.id}-plan-1`,
    sessionId: scene.session.id,
    invocationId: "inv-1",
    runId: "run-plan",
    turnId: "turn-1",
    at: "2026-08-19T00:00:00.000Z",
    partial: false,
    visibility: "internal",
    kind: "plan.execution.completed",
    data: {
      operationId: "op-arbitration",
      fingerprint: "sha256:" + "a".repeat(64),
      planId: "plan-arbitration",
    },
  } as RuntimeEvent;
  // run.started 占 seq 1;首次 CAS 占 seq 2。
  const first = await scene.realStore.appendPlanOperation([planEvent], {
    operationId: "op-arbitration",
    fingerprint: "sha256:" + "a".repeat(64),
    expectedSessionSequence: 1,
    ownerFence: await scene.session.assertRuntimeEventWriteAllowed(),
  });
  assert.deepEqual(
    first.map((result) => [result.inserted, result.cursor.seq]),
    [[true, 2]],
  );
  // 同 eventId 同载荷但 fingerprint 不同:读回载荷相等也不得翻案,契约冲突原样抛出。
  await assert.rejects(
    scene.realStore.appendPlanOperation([planEvent], {
      operationId: "op-arbitration",
      fingerprint: "sha256:" + "b".repeat(64),
      expectedSessionSequence: 2,
      ownerFence: await scene.session.assertRuntimeEventWriteAllowed(),
    }),
    /already bound to another fingerprint/u,
  );
});
