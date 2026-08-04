import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  parseStrictRuntimeParams,
} from "../../packages/protocol/src/runtime.js";
import { approvalFromPlanProjection } from "../../apps/desktop/src/renderer/runtime.js";

test("Plan review protocol exposes CAS-protected three-action requests", () => {
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("plan.respond"));
  const parsed = parseStrictRuntimeParams("plan.respond", {
    workspacePath: "/workspace",
    sessionId: "session-1",
    planId: "plan-1",
    action: "continue_editing",
    expectedRevision: 2,
    expectedSessionSequence: 7,
    operationId: "operation-1",
    feedback: "补充回滚验证",
  });
  assert.equal(parsed.action, "continue_editing");
  assert.throws(
    () =>
      parseStrictRuntimeParams("plan.respond", {
        workspacePath: "/workspace",
        sessionId: "session-1",
        planId: "plan-1",
        action: "continue_editing",
        expectedRevision: 2,
        expectedSessionSequence: 7,
        operationId: "operation-2",
      }),
    /feedback/u,
  );
});

test("Plan protocol accepts interrupted execution controls", () => {
  for (const action of ["resume_execution", "cancel_execution", "replan_execution"] as const) {
    const parsed = parseStrictRuntimeParams("plan.respond", {
      workspacePath: "/workspace",
      sessionId: "session-1",
      planId: "plan-1",
      action,
      expectedRevision: 2,
      expectedSessionSequence: 9,
      operationId: `operation-${action}`,
    });
    assert.equal(parsed.action, action);
  }
});

test("Desktop hydration rebuilds pending and interrupted Plan controls", () => {
  const pending = approvalFromPlanProjection(
    {
      sessionId: "session-1",
      sessionSequence: 7,
      pendingProposal: {
        planId: "plan-1",
        revision: 2,
        title: "Ship it",
        steps: [{ title: "Test" }],
      },
    },
    "session-1",
  );
  assert.equal(pending?.planControlMode, "review");
  assert.equal(pending?.expectedSessionSequence, 7);

  const interrupted = approvalFromPlanProjection(
    {
      sessionId: "session-1",
      sessionSequence: 11,
      execution: {
        planId: "plan-1",
        revision: 2,
        status: "interrupted",
        reason: "stopped",
        steps: [{ title: "Resume me" }],
      },
    },
    "session-1",
  );
  assert.equal(interrupted?.planControlMode, "interrupted");
  assert.equal(interrupted?.planId, "plan-1");
});

test("session settings protocol separates collaboration and permission axes", () => {
  const parsed = parseStrictRuntimeParams("session.settings.update", {
    workspacePath: "/workspace",
    sessionId: "session-1",
    collaborationMode: "plan",
    permissionMode: "auto",
  });
  assert.equal(parsed.collaborationMode, "plan");
  assert.equal(parsed.permissionMode, "auto");
});
