import assert from "node:assert/strict";
import test from "node:test";
import { createRealGoalHost, GOAL_E2E_TIMEOUT_MS } from "./helpers/goal-real-host.js";

test(
  "real Goal ignores success claims and injected output until a fresh native process succeeds",
  {
    skip: process.env.RUN_LLM_E2E !== "1" || process.platform === "win32",
    timeout: GOAL_E2E_TIMEOUT_MS,
  },
  async (context) => {
    const host = await createRealGoalHost(context, {
      releaseAfterContinuations: 1,
      processEvidence: true,
    });
    if (!host) return;
    await host.arm(4);
    await host.sendInitialInput();
    const goal = await host.waitForTerminalGoal();
    await host.assertRealExecutionAndReport(goal);
    assert.equal(goal.status, "achieved", goal.lastReason);
    assert.ok(host.continuationRunIds.size >= 1);
    assert.equal(goal.lastEvaluation?.evidenceTrace?.gateReason, undefined);
    await host.assertNoFurtherRuns();
  },
);
