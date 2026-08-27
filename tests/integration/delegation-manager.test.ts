import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DelegationManager,
  type DelegationBatchResult,
  type DelegationCompletionEnvelope,
  type DelegationRecordStatus,
} from "../../src/tools/delegation-manager.js";

const COMPLETED_BATCH: DelegationBatchResult = {
  status: "completed",
  results: [{ taskIndex: 0, status: "completed", summary: "done", durationMs: 1 }],
  totalDurationMs: 1,
};

test("DelegationManager completes an ordinary delegation and publishes its envelope", async () => {
  const completions: DelegationCompletionEnvelope[] = [];
  const manager = new DelegationManager({
    onCompletion: (completion) => completions.push(completion),
  });

  const dispatched = manager.dispatch(async () => COMPLETED_BATCH, {
    description: "ordinary delegation",
    ownerSessionId: "session-1",
  });

  assert.equal(dispatched.status, "dispatched");
  assert.ok(dispatched.delegationId);
  await manager.wait(dispatched.delegationId);
  assert.equal(manager.snapshot(dispatched.delegationId).status, "not_found");
  assert.deepEqual(completions, [
    {
      completionId: `completion:${dispatched.taskId}:1`,
      jobId: dispatched.taskId,
      ownerSessionId: "session-1",
      completionSeq: 1,
      activityIds: [],
      completionPolicy: "required",
      status: "completed",
      outputSummary: "task 0 completed:\ndone",
    },
  ]);
});

test("DelegationManager settles plan steps on both resolved and rejected runners", async () => {
  const settled: Array<{ planStepId: string; status: DelegationRecordStatus }> = [];
  const manager = new DelegationManager({
    onPlanStepSettled: (planStepId, status) => {
      settled.push({ planStepId, status });
    },
  });

  const completed = manager.dispatch(async () => COMPLETED_BATCH, { planStepId: "plan-step-ok" });
  const failed = manager.dispatch(
    async () => {
      throw new Error("child failed");
    },
    { planStepId: "plan-step-error" },
  );

  assert.ok(completed.delegationId);
  assert.ok(failed.delegationId);
  await Promise.all([manager.wait(completed.delegationId), manager.wait(failed.delegationId)]);
  assert.deepEqual(settled, [
    { planStepId: "plan-step-ok", status: "completed" },
    { planStepId: "plan-step-error", status: "error" },
  ]);
});
