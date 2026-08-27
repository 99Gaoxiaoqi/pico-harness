import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  parseStrictRuntimeParams,
} from "../../packages/protocol/src/runtime.js";
import {
  approvalFromPlanControlSnapshot,
  approvalFromPlanProjection,
} from "../../apps/desktop/src/renderer/runtime.js";
import { planReviewOperationId } from "../../src/plan/review-identity.js";

test("Plan review protocol exposes CAS-protected three-action requests", () => {
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("plan.respond"));
  const parsed = parseStrictRuntimeParams("plan.respond", {
    workspacePath: "/workspace",
    sessionId: "session-1",
    planId: "plan-1",
    action: "continue_editing",
    expectedRevision: 2,
    expectedSessionSequence: 7,
    controlEpoch: "plan:proposal:2",
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
        controlEpoch: "plan:proposal:2",
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
      controlEpoch: "plan:interrupted:2",
    });
    assert.equal(parsed.action, action);
  }
});

test("Desktop hydration rebuilds pending, revision, and interrupted Plan controls", () => {
  const pending = approvalFromPlanProjection(
    {
      sessionId: "session-1",
      sessionSequence: 7,
      controlEpoch: "plan:pending:2",
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

  const revision = approvalFromPlanProjection(
    {
      sessionId: "session-1",
      sessionSequence: 9,
      controlEpoch: "plan:revision:2",
      revisionRequest: {
        planId: "plan-1",
        expectedRevision: 2,
        operationId: "revision-operation-1",
        feedback: "补充回滚验证",
      },
    },
    "session-1",
  );
  assert.equal(revision?.planControlMode, "revision");
  assert.equal(revision?.planOperationId, "revision-operation-1");
  assert.equal(revision?.planFeedback, "补充回滚验证");
  assert.equal(revision?.expectedRevision, 2);
  assert.equal(revision?.expectedSessionSequence, 9);

  const interrupted = approvalFromPlanProjection(
    {
      sessionId: "session-1",
      sessionSequence: 11,
      controlEpoch: "plan:interrupted:2",
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

test("Plan review identity is stable across ledger-only movement and isolated by Session/revision", () => {
  const base = {
    sessionId: "session-1",
    planId: "plan-1",
    revision: 2,
    controlEpoch: "plan:proposal:2",
    action: "execute" as const,
  };
  const first = planReviewOperationId(base);
  assert.equal(planReviewOperationId(base), first);
  assert.notEqual(planReviewOperationId({ ...base, sessionId: "session-2" }), first);
  assert.notEqual(planReviewOperationId({ ...base, revision: 3 }), first);
  assert.notEqual(planReviewOperationId({ ...base, controlEpoch: "plan:interrupted:2" }), first);
});

test("Desktop consumes the versioned PlanControl snapshot and hides unavailable/terminal controls", () => {
  const projection = {
    sessionId: "session-1",
    sessionSequence: 7,
    controlEpoch: "plan:proposal:1",
    proposals: [],
    pendingProposal: {
      planId: "plan-1",
      revision: 1,
      title: "Ship it",
      steps: [],
      status: "pending" as const,
      proposedAt: "2026-08-27T00:00:00.000Z",
    },
  };
  assert.ok(
    approvalFromPlanControlSnapshot(
      { version: 1, availability: "ready", state: "pending_review", projection },
      "session-1",
    ),
  );
  assert.equal(
    approvalFromPlanControlSnapshot(
      { version: 1, availability: "unavailable", state: "pending_review", projection },
      "session-1",
    ),
    undefined,
  );
  assert.equal(
    approvalFromPlanControlSnapshot(
      { version: 1, availability: "ready", state: "terminal", projection },
      "session-1",
    ),
    undefined,
  );
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
