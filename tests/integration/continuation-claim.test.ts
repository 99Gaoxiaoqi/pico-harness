// ADR 29 continuation claim 最小协议集成测试——中断 run 的确定性续跑锚。
//
// 验收不变量:
// - C1 同一 source run 至多一个 claim(UNIQUE 约束;冲突返回类型化结果,不抛裸 SqliteError)。
// - C2 claim 成功隐含:claim 时刻源为 interrupted 终态、digest/high_water 与账本一致;
//   活跃(无终态)/非 interrupted 终态的 run 被类型化拒绝。
// - C3 claim 事务只读源账本、只写 claims 行;目标关联只经 run.started 的 continuationOf。
// - C4 已 claim(=已 interrupted 终态)的源 run 追加新事件被拒(源封口,本次新增防线);
//   幂等重放不受影响。
//
// 前缀 digest 序列化口径(与 store 注释一致,此处独立重算对账):
//   对 seq∈[1..high_water] 升序的每条事件,取
//     JSON.stringify({ seq, eventId, payload })   // payload = 键排序 canonical JSON 字符串
//   逐行后跟 "\n"(含末行),对全文取 sha256 hex。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../../src/engine/session.js";
import type { Message } from "../../src/schema/message.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { RuntimeEventStoreRunSealedError } from "../../src/storage/runtime-event-store-contracts.js";
import type { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";

interface ClaimScene {
  readonly session: Session;
  readonly store: SqliteRuntimeEventStore;
}

async function createScene(context: test.TestContext, sessionId: string): Promise<ClaimScene> {
  const root = await mkdtemp(join(tmpdir(), `pico-continuation-${sessionId}-`));
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
  return { session, store };
}

function userMessage(content: string): Message {
  return { role: "user", content };
}

/** 键排序 canonical JSON(独立实现,与 store 的 sortKeysDeep+stringify 对账)。 */
function sortedKeysJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedKeysJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedKeysJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/** 手工重算 seq∈[1..highWater] 前缀 digest(不经 store 实现)。 */
function manualPrefixDigest(
  entries: readonly { sequence: number; event: RuntimeEvent }[],
  highWater: number,
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry.sequence > highWater) continue;
    hash.update(
      JSON.stringify({
        seq: entry.sequence,
        eventId: entry.event.eventId,
        payload: sortedKeysJson(entry.event),
      }),
      "utf8",
    );
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

/** 构造一个已终态的 run:interrupted(completed 场景传 "completed")。 */
async function createTerminatedRun(
  scene: ClaimScene,
  status: "interrupted" | "completed",
  messages: readonly string[] = [],
): Promise<RuntimeRun> {
  const run = await RuntimeRun.start({ capability: scene.session.runtimeEventCapability! });
  await run.recordTurnStarted(1);
  for (const content of messages) {
    await run.commitMessages(scene.session, [userMessage(content)]);
  }
  await run.finish(status, `test-${status}`);
  return run;
}

test("C2+ C1：interrupted run claim 成功（digest/high_water 手工重算对账），二次 claim 类型化冲突", async (context) => {
  const scene = await createScene(context, "claim-happy-path");
  const source = await createTerminatedRun(scene, "interrupted", ["前缀消息一", "前缀消息二"]);

  const before = (await scene.store.readSessionEntries(scene.session.id)).map(
    ({ sequence, event }) => ({ sequence, event }),
  );
  const boundary = await scene.store.readSessionRunBoundary(scene.session.id, source.runId);
  assert.ok(boundary.entries.at(-1), "interrupted run must have a terminal event");

  const outcome = await scene.store.claimContinuation(
    scene.session.id,
    source.runId,
    "run-continuation-target-1",
  );
  assert.equal(outcome.status, "claimed");
  const claim = outcome.claim;
  assert.equal(claim.sourceSessionId, scene.session.id);
  assert.equal(claim.sourceRunId, source.runId);
  assert.equal(claim.targetSessionId, scene.session.id, "ADR 29:同 session 续跑");
  assert.equal(claim.targetRunId, "run-continuation-target-1");

  // C2 后半:high_water = 该 run 全部事件的 seq 上界(末条 run 事件 = 终态)。
  assert.equal(claim.sourceHighWater, boundary.entries.at(-1)!.sequence);
  // C2 后半:digest 与账本手工重算一致。
  assert.equal(
    claim.sourcePrefixDigest,
    manualPrefixDigest(before, claim.sourceHighWater),
    "prefix digest must match an independently recomputed serialization",
  );
  // C2 前半已由构造保证:claim 时刻源终态为 interrupted(非 interrupted 场景另测)。
  const terminal = boundary.entries.at(-1)!.event;
  assert.equal(terminal.kind, "run.terminal");
  assert.equal(terminal.data.status, "interrupted");

  // C3 写侧:claim 只写 claims 行——源账本事件数与末条 seq 不变。
  const after = await scene.store.readSessionEntries(scene.session.id);
  assert.equal(after.length, before.length);
  assert.equal(after.at(-1)!.event.eventId, before.at(-1)!.event.eventId);

  // C1:同一 source run 二次 claim(即使换 target)→ already_claimed,不抛裸 SqliteError。
  const second = await scene.store.claimContinuation(
    scene.session.id,
    source.runId,
    "run-continuation-target-2",
  );
  assert.equal(second.status, "already_claimed");
  assert.equal(second.claim.claimId, claim.claimId);
  assert.equal(second.claim.targetRunId, claim.targetRunId);

  // 读回通道:按 source run 点查同一行。
  const reread = await scene.store.findContinuationClaimBySourceRun(scene.session.id, source.runId);
  assert.deepEqual(reread, claim);
});

test("C2 前半：活跃 run / completed run / 不存在 run 的 claim 被类型化拒绝；target 重复占用被拒", async (context) => {
  const scene = await createScene(context, "claim-rejections");
  const capability = scene.session.runtimeEventCapability!;

  // 活跃 run:已 start 未终态。
  const active = await RuntimeRun.start({ capability });
  await active.recordTurnStarted(1);
  assert.deepEqual(
    await scene.store.claimContinuation(scene.session.id, active.runId, "target-active"),
    { status: "rejected", reason: "run_active" },
  );

  // completed run:有终态但非 interrupted,不可续。
  const completed = await createTerminatedRun(scene, "completed", ["done"]);
  assert.deepEqual(
    await scene.store.claimContinuation(scene.session.id, completed.runId, "target-completed"),
    { status: "rejected", reason: "run_not_interrupted" },
  );

  // 不存在的 run。
  assert.deepEqual(
    await scene.store.claimContinuation(scene.session.id, "run-never-existed", "target-void"),
    { status: "rejected", reason: "run_not_found" },
  );

  // target run 已被其他 claim 占用 → target_conflict。
  const firstSource = await createTerminatedRun(scene, "interrupted");
  const claimed = await scene.store.claimContinuation(
    scene.session.id,
    firstSource.runId,
    "target-shared",
  );
  assert.equal(claimed.status, "claimed");
  const secondSource = await createTerminatedRun(scene, "interrupted");
  assert.deepEqual(
    await scene.store.claimContinuation(scene.session.id, secondSource.runId, "target-shared"),
    { status: "rejected", reason: "target_conflict" },
  );
});

test("C4 源封口：已 claim（interrupted）与已终态（completed）的 run 追加新事件被拒，幂等重放不受影响", async (context) => {
  const scene = await createScene(context, "claim-source-seal");
  const claimedSource = await createTerminatedRun(scene, "interrupted", ["sealed-prefix"]);
  const claim = await scene.store.claimContinuation(
    scene.session.id,
    claimedSource.runId,
    "run-seal-target",
  );
  assert.equal(claim.status, "claimed");

  // 向已 claim 的源 run 追加新的非恢复类事件 → 类型化拒绝(fail-closed)。
  const sealedAppend: RuntimeEvent = {
    schemaVersion: 2,
    eventId: "seal-probe:after-claim",
    sessionId: scene.session.id,
    invocationId: "inv-seal-probe",
    runId: claimedSource.runId,
    turnId: "turn-seal-probe",
    at: new Date().toISOString(),
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content: "追改已封口的源 run" } },
  } as RuntimeEvent;
  await assert.rejects(
    scene.store.append(sealedAppend),
    (error: unknown) =>
      error instanceof RuntimeEventStoreRunSealedError &&
      error.runId === claimedSource.runId &&
      error.sessionId === scene.session.id,
  );

  // 未被 claim 的 completed run 同样封口(终态即封口,与 claim 无关)。
  const completed = await createTerminatedRun(scene, "completed");
  await assert.rejects(
    scene.store.append({
      ...sealedAppend,
      eventId: "seal-probe:after-completed",
      runId: completed.runId,
    } as RuntimeEvent),
    (error: unknown) =>
      error instanceof RuntimeEventStoreRunSealedError && error.runId === completed.runId,
  );

  // 幂等重放不受封口影响:重放已落库的终态事件(同 eventId 同载荷)合法且不新增。
  const before = await scene.store.readSession(scene.session.id);
  const terminal = before.find(
    (event) => event.kind === "run.terminal" && event.runId === claimedSource.runId,
  )!;
  const replay = await scene.store.append(terminal);
  assert.equal(replay.inserted, false);
  const afterReplay = await scene.store.readSession(scene.session.id);
  assert.equal(afterReplay.length, before.length, "sealed-run replay must not append anything");
});

test("C3+ 目标关联：run.started 携带 continuationOf 落库可读回；目标 run 正常写事件不受源封口影响", async (context) => {
  const scene = await createScene(context, "claim-target-association");
  const source = await createTerminatedRun(scene, "interrupted", ["源前缀"]);
  const claim = await scene.store.claimContinuation(
    scene.session.id,
    source.runId,
    "run-target-with-anchor",
  );
  assert.equal(claim.status, "claimed");

  // 目标 run 经最小 API 声明续跑关系:三元组写入 run.started 的 data.continuationOf。
  const target = await RuntimeRun.start({
    capability: scene.session.runtimeEventCapability!,
    continuationOf: {
      runId: claim.claim.sourceRunId,
      highWater: claim.claim.sourceHighWater,
      prefixDigest: claim.claim.sourcePrefixDigest,
    },
  });
  await target.recordTurnStarted(1);
  await target.commitMessages(scene.session, [userMessage("续跑后的新消息")]);
  await target.finish("completed");

  const events = await scene.store.readSession(scene.session.id);
  const targetStarted = events.find(
    (event) => event.kind === "run.started" && event.runId === target.runId,
  )!;
  assert.equal(targetStarted.kind, "run.started");
  assert.deepEqual(targetStarted.data.continuationOf, {
    runId: claim.claim.sourceRunId,
    highWater: claim.claim.sourceHighWater,
    prefixDigest: claim.claim.sourcePrefixDigest,
  });
  // 同 session 事件流天然含前缀:源前缀消息仍在目标 run 可见的会话账本里。
  assert.ok(
    events.some(
      (event) =>
        event.kind === "message.committed" && event.data.message.content === "源前缀",
    ),
  );

  // schema 严格校验:continuationOf 缺字段/坏 digest 的 run.started 被 append 校验拒绝。
  await assert.rejects(
    scene.store.append({
      schemaVersion: 2,
      eventId: "bad-continuation-start",
      sessionId: scene.session.id,
      invocationId: "inv-bad",
      runId: "run-bad-anchor",
      turnId: "turn-bad",
      at: new Date().toISOString(),
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: {
        workDir: scene.session.workDir,
        continuationOf: { runId: source.runId, highWater: 1, prefixDigest: "not-a-digest" },
      },
    } as RuntimeEvent),
    /is invalid|prefixDigest/u,
  );
});
