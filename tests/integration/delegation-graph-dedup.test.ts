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
