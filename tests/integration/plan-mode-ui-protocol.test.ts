import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  parseStrictRuntimeParams,
} from "../../packages/protocol/src/runtime.js";

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
