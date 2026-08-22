// ADR 29 调度接入(2026-08-20)集成测试:executor 级自动锚定 interrupted 续跑。
// reconcile 把崩溃 run 定形 interrupted 后,新 run 自动以续跑身份起跑——
// goal/cron/前台统一生效;claim 的 targetRunId 即新 run 的 runId(调度契约)。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { HookOutput } from "../../src/hooks/types.js";
import type { SessionRuntime } from "../../src/runtime/session-runtime.js";
import type {
  RuntimeLifecycleEvent,
  RuntimeRunOptions,
} from "../../src/runtime/runtime-contract.js";
import { RuntimeRunExecutor } from "../../src/runtime/runtime-run-executor.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { RuntimeEventStoreRunSealedError } from "../../src/storage/runtime-event-store-contracts.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";

test("executor 自动锚定 interrupted 续跑：claim→targetRunId 起跑→源封口→二次不重复锚定", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-continuation-auto-wiring-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("continuation-auto-wiring", workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await session.recover();
    // 崩溃 run:起跑+落一条消息,无终态(模拟进程中断)。
    const capability = session.runtimeEventCapability!;
    const crashed = await RuntimeRun.start({ capability });
    await crashed.recordTurnStarted(1);
    await crashed.commitMessages(session, [{ role: "user", content: "崩溃前的输入" }]);

    const result = await newExecutor(session, workDir, picoHome, {
      continuationTerminalMinAgeMs: 0,
    }).execute();
    assert.equal(result.finalMessage, "answer");

    const store = session.runtimeEventStore!;
    // reconcile 已把崩溃 run 定形 interrupted,并被自动 claim。
    const claim = await store.findContinuationClaimBySourceRun(session.id, crashed.runId);
    assert.ok(claim, "crashed run must be auto-claimed");
    assert.equal(claim.targetSessionId, session.id);

    // 新 run 以 claim 的 targetRunId 起跑,run.started 携带续跑三元组。
    const events = await store.readSession(session.id);
    const targetStart = events.find(
      (event) => event.kind === "run.started" && event.runId === claim.targetRunId,
    );
    if (targetStart?.kind !== "run.started") {
      assert.fail("target run.started missing");
    }
    assert.deepEqual(targetStart.data.continuationOf, {
      runId: crashed.runId,
      highWater: claim.sourceHighWater,
      prefixDigest: claim.sourcePrefixDigest,
    });
    const targetTerminal = events.find(
      (event) => event.kind === "run.terminal" && event.runId === claim.targetRunId,
    );
    assert.ok(targetTerminal, "target run must have finished");

    // 源封口(C4):被 claim 的崩溃 run 拒收新的非恢复类事件。
    await assert.rejects(
      store.append({
        schemaVersion: 2,
        eventId: `seal-probe:${claim.claimId}`,
        sessionId: session.id,
        invocationId: "inv-seal-probe",
        runId: crashed.runId,
        turnId: "turn-seal-probe",
        at: new Date().toISOString(),
        partial: false,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "user", content: "追改已封口的源 run" } },
      } as RuntimeEvent),
      (error: unknown) => error instanceof RuntimeEventStoreRunSealedError,
    );

    // 二次 executor:无未 claim 的 interrupted → 普通起跑,不携带 continuationOf。
    await newExecutor(session, workDir, picoHome, { continuationTerminalMinAgeMs: 0 }).execute();
    const secondEvents = await store.readSession(session.id);
    const starts = secondEvents.filter(
      (event): event is Extract<RuntimeEvent, { kind: "run.started" }> =>
        event.kind === "run.started",
    );
    const lastStart = starts.at(-1);
    assert.ok(lastStart, "second run must have started");
    assert.equal(lastStart.data.continuationOf, undefined);
    assert.notEqual(lastStart.runId, claim.targetRunId);
    // claim 不因二次起跑变化。
    const reread = await store.findContinuationClaimBySourceRun(session.id, crashed.runId);
    assert.deepEqual(reread, claim);

    // 新鲜度门(审查 F2):新崩溃 run 的终态刚被 reconcile 补写,默认窗口(10 分钟)
    // 内不锚定不封口——跨进程存活保护;窗口 0 后的下一轮 executor 正常锚定。
    const crashed2 = await RuntimeRun.start({ capability });
    await crashed2.recordTurnStarted(1);
    await crashed2.commitMessages(session, [{ role: "user", content: "第二次崩溃" }]);
    await newExecutor(session, workDir, picoHome).execute();
    assert.equal(
      await store.findContinuationClaimBySourceRun(session.id, crashed2.runId),
      undefined,
      "fresh interrupted terminal must not be claimed within the default window",
    );
    // 未被 claim 的终态 run 保持开放语义:追加不被 seal 拒绝。
    const openAppend = await store.append({
      schemaVersion: 2,
      eventId: `fresh-open-probe:${crashed2.runId}`,
      sessionId: session.id,
      invocationId: "inv-fresh-open-probe",
      runId: crashed2.runId,
      turnId: "turn-fresh-open-probe",
      at: new Date().toISOString(),
      partial: false,
      visibility: "internal",
      kind: "message.committed",
      data: { message: { role: "user", content: "开放语义探针" } },
    } as RuntimeEvent);
    assert.equal(openAppend.inserted, true, "unclaimed terminal run stays appendable");
    await newExecutor(session, workDir, picoHome, { continuationTerminalMinAgeMs: 0 }).execute();
    const claim2 = await store.findContinuationClaimBySourceRun(session.id, crashed2.runId);
    assert.ok(claim2, "zero-window executor must anchor the aged-in terminal");
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

function newExecutor(
  session: Session,
  workDir: string,
  picoHome: string,
  extra?: { continuationTerminalMinAgeMs?: number },
): RuntimeRunExecutor {
  const runtimeState = {
    dispatchHook: async (): Promise<HookOutput> => ({ decision: "allow" }),
  } as unknown as SessionRuntime;
  const engine = {
    run: async (target: Session) => {
      await target.commitMessages({ role: "assistant", content: "answer" });
      return target.getHistory();
    },
  } as unknown as AgentEngine;
  const options: RuntimeRunOptions = {};
  const lifecycleEvents: RuntimeLifecycleEvent[] = [];
  return new RuntimeRunExecutor({
    session,
    runtimeState,
    engine,
    sessionSelection: { mode: "new", sessionId: session.id },
    workDir,
    picoHome,
    prompt: "continue after crash",
    resumeExistingSession: false,
    traceEnabled: false,
    options,
    onEvent: (event) => lifecycleEvents.push(event),
    ...extra,
  });
}
