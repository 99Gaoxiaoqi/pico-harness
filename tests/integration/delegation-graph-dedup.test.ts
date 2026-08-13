import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DelegationManager,
  type DelegationBatchResult,
} from "../../src/tools/delegation-manager.js";

test("DelegationManager rejects a duplicate graphWorkId dispatch while the first is in-flight", () => {
  const manager = new DelegationManager();
  const neverSettles = (_signal: AbortSignal): Promise<DelegationBatchResult> =>
    new Promise(() => undefined);

  const first = manager.dispatch(neverSettles, { graphWorkId: "work-dedup-1" });
  assert.equal(first.status, "dispatched");

  // settleGraphWork 链下游派发不写 dispatched CAS，并行 graph 分支 settle 时
  // computeReadyWorks 会重复返回同一 requested work，导致同一指令被多次 spawn。
  // 此处验证 dispatch 汇聚点对同一 graphWorkId 的重复派发去重。
  const duplicate = manager.dispatch(neverSettles, { graphWorkId: "work-dedup-1" });
  assert.equal(duplicate.status, "rejected");

  // 不同 graphWorkId 不受影响，仍可正常派发。
  const other = manager.dispatch(neverSettles, { graphWorkId: "work-dedup-2" });
  assert.equal(other.status, "dispatched");
});

test("DelegationManager rejects a duplicate graphWorkId dispatch during the settle-chain window (status terminal, settleFinalized false)", async () => {
  // 用 gate 卡住 onGraphWorkSettled，把 delegation 停在
  // "status 已 terminal、settleFinalized 仍 false" 的 settle 链窗口里。
  // 这正是钻石/扇入图里并发 settleGraphWork 对同一下游 work 二次派发的真实时序：
  // runner 已 resolve、status 已写成 terminal，但 settleGraphWork 的 recorded CAS
  // 与下游派发仍在飞行中。
  let releaseSettle: () => void = () => {};
  const settleGate = new Promise<void>((resolve) => {
    releaseSettle = resolve;
  });
  const manager = new DelegationManager({
    onGraphWorkSettled: async () => {
      await settleGate;
    },
  });

  const immediate: DelegationBatchResult = {
    status: "completed",
    results: [{ taskIndex: 0, status: "completed", durationMs: 1 }],
    totalDurationMs: 1,
  };
  const immediateRunner = (_signal: AbortSignal): Promise<DelegationBatchResult> =>
    Promise.resolve(immediate);

  const first = manager.dispatch(immediateRunner, { graphWorkId: "work-settle-1" });
  assert.equal(first.status, "dispatched");
  assert.ok(first.delegationId, "first dispatch should yield a delegationId");

  // 等 delegation 跑完 runner、进入 settle 链、status 写成 terminal——但 settleFinalized
  // 仍为 false（settle 链被 settleGate 卡住）。窄窗口（status === "running"）此时已不命中。
  const firstId = first.delegationId!;
  for (let i = 0; i < 1000; i++) {
    const snap = manager.snapshot(firstId);
    if (!("error" in snap) && snap.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const settled = manager.snapshot(firstId);
  assert.ok(!("error" in settled), "first delegation should still be tracked");
  assert.notEqual(settled.status, "running");
  // 此时宽窗口（!settleFinalized）仍然命中——这是修复要覆盖的关键窗口。

  // 同一 graphWorkId 的并发派发必须被拒。窄窗口实现下此处会变成 dispatched（双重派发洞）。
  const duplicate = manager.dispatch(immediateRunner, { graphWorkId: "work-settle-1" });
  assert.equal(duplicate.status, "rejected");
  if (duplicate.status === "rejected") {
    assert.equal(duplicate.delegationId, firstId);
  }

  // 不同 graphWorkId 不受宽窗口波及（按 id 严格相等去重），仍可正常派发——证明不死锁。
  const other = manager.dispatch(immediateRunner, { graphWorkId: "work-settle-2" });
  assert.equal(other.status, "dispatched");

  // 释放 gate，让两条 settle 链收口，进程可干净退出。
  releaseSettle();
  if (other.delegationId) {
    await manager.wait(other.delegationId);
  }
  await manager.wait(firstId);
});
