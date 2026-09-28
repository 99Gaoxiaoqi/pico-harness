import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRealGoalHost, GOAL_E2E_TIMEOUT_MS } from "./helpers/goal-real-host.js";

test(
  "real Goal Host admits two autonomous continuations before independent acceptance",
  { skip: process.env.RUN_LLM_E2E !== "1", timeout: GOAL_E2E_TIMEOUT_MS },
  async (context) => {
    const host = await createRealGoalHost(context, { releaseAfterContinuations: 2 });
    if (!host) return;

    await host.arm(5);
    assert.equal((await host.goal())?.status, "active");
    assert.equal(host.startedRuns.size, 0, "arming alone must not dispatch a model Run");

    await host.sendInitialInput();
    const goal = await host.waitForTerminalGoal();
    await host.assertRealExecutionAndReport(goal);
    assert.equal(goal.status, "achieved", goal.lastReason);
    assert.ok(host.continuationRunIds.size >= 2, "Host must admit at least two Goal continuations");
    assert.ok(goal.iterations >= 2 && goal.iterations < 5);
    assert.match(await readFile(host.markerPath, "utf8"), /READY/);
    await host.assertNoFurtherRuns();
  },
);
