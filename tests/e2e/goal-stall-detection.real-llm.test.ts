import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRealGoalHost, GOAL_E2E_TIMEOUT_MS } from "./helpers/goal-real-host.js";

test(
  "real Goal waiting for external evidence stops at its iteration cap without claiming success",
  { skip: process.env.RUN_LLM_E2E !== "1", timeout: GOAL_E2E_TIMEOUT_MS },
  async (context) => {
    const host = await createRealGoalHost(context);
    if (!host) return;

    await host.arm(2);
    await host.sendInitialInput();
    const goal = await host.waitForTerminalGoal();
    await host.assertRealExecutionAndReport(goal);
    assert.equal(goal.status, "max_iterations", goal.lastReason);
    assert.equal(goal.iterations, 2);
    assert.equal(host.startedRuns.size, 2);
    assert.equal(host.continuationRunIds.size, 1);
    assert.match(await readFile(host.markerPath, "utf8"), /PENDING/);
  },
);
