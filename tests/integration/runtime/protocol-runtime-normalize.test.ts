import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRuntimeNotification,
  isActiveRunStatus,
  isInterruptedRunStatus,
  isStreamingRunStatus,
  isTerminalRunStatus,
  isApprovalRequestedRuntimeNotification,
  parseApprovalRequestedPayload,
  type RuntimeRunStatus,
} from "@pico/protocol";

/**
 * 3-D Phase 3 wire 归一化共享模块（packages/protocol/src/runtime-normalize.ts）。
 * 枚举校真：分类断言逐一遍历 RuntimeRunStatus 全值——非枚举字符串
 * （"completed"/"interrupted" 等拷贝漂移产物）三谓词必须全 false。
 * 经 @pico/protocol（dist）导入：模块身份与生产消费一致。
 */

const RUN_STATUS_CLASSIFICATION: readonly (readonly [
  RuntimeRunStatus,
  boolean,
  boolean,
  boolean,
])[] = [
  // [status, terminal, active(水化对账), streaming(相位灯)]
  ["queued", false, true, true],
  ["running", false, true, true],
  ["pause_requested", false, true, true],
  ["paused", false, true, false],
  ["cancelling", false, true, false],
  ["cancelled", true, false, false],
  ["failed", true, false, false],
  ["succeeded", true, false, false],
];

test("run 状态分类：全枚举值逐一遍历（枚举校真）", () => {
  for (const [status, terminal, active, streaming] of RUN_STATUS_CLASSIFICATION) {
    assert.equal(isTerminalRunStatus(status), terminal, `terminal(${status})`);
    assert.equal(isActiveRunStatus(status), active, `active(${status})`);
    assert.equal(isStreamingRunStatus(status), streaming, `streaming(${status})`);
  }
});

test("非枚举值三谓词全 false（拷贝漂移防护：completed/interrupted 不是枚举值）", () => {
  for (const bogus of ["completed", "interrupted", "", "running ", "SUCCEEDED"]) {
    assert.equal(isTerminalRunStatus(bogus), false, `terminal(${JSON.stringify(bogus)})`);
    assert.equal(isActiveRunStatus(bogus), false, `active(${JSON.stringify(bogus)})`);
    assert.equal(isStreamingRunStatus(bogus), false, `streaming(${JSON.stringify(bogus)})`);
  }
});

test("isInterruptedRunStatus：cancelled/failed 走 onInterrupted 分支，succeeded 不算", () => {
  assert.equal(isInterruptedRunStatus("cancelled"), true);
  assert.equal(isInterruptedRunStatus("failed"), true);
  assert.equal(isInterruptedRunStatus("succeeded"), false);
  assert.equal(isInterruptedRunStatus("paused"), false);
});

function toolApprovalPayload(request: Readonly<Record<string, unknown>> = {}) {
  return {
    approvalId: "apr-tool",
    runId: "run-tool",
    request: {
      kind: "tool",
      title: "需要批准",
      detail: "执行受保护操作",
      risk: "high",
      toolName: "edit_file",
      args: "{}",
      providerCallId: "call-tool",
      ...request,
    },
  };
}

test("parseApprovalRequestedPayload：严格解析当前工具审批", () => {
  const view = parseApprovalRequestedPayload(
    toolApprovalPayload({
      command: "a.txt",
      diff: "--- a\n+++ b",
      sessionScope: { type: "file", path: "a.txt", access: "edit" },
    }),
  );
  assert.ok(view && view.kind === "tool");
  assert.equal(view.approvalId, "apr-tool");
  assert.equal(view.runId, "run-tool");
  assert.equal(view.toolName, "edit_file");
  assert.equal(view.providerCallId, "call-tool");
  assert.equal(view.command, "a.txt");
  assert.deepEqual(view.sessionScope, { type: "file", path: "a.txt", access: "edit" });
});

test("parseApprovalRequestedPayload：严格解析 durable Plan handoff", () => {
  const view = parseApprovalRequestedPayload({
    approvalId: "plan-1",
    runId: "run-plan",
    request: {
      kind: "plan",
      title: "执行计划",
      detail: "计划详情",
      risk: "high",
      planId: "plan-1",
      expectedRevision: 3,
      expectedSessionSequence: 7,
      controlEpoch: "plan:event:3",
      operationId: "submit-plan:3",
      plan: {
        planId: "plan-1",
        revision: 3,
        title: "计划",
        overview: "总览",
        steps: [{ title: "步骤一" }, { title: "步骤二" }],
      },
    },
  });
  assert.ok(view && view.kind === "plan");
  assert.equal(view.planId, "plan-1");
  assert.equal(view.expectedRevision, 3);
  assert.equal(view.expectedSessionSequence, 7);
  assert.equal(view.controlEpoch, "plan:event:3");
  assert.equal(view.operationId, "submit-plan:3");
  assert.deepEqual(view.planSteps, ["步骤一", "步骤二"]);
});

test("parseApprovalRequestedPayload：缺字段、旧别名和分支混用一律拒绝", () => {
  const malformed: readonly unknown[] = [
    undefined,
    null,
    "string",
    { approvalId: "apr", request: toolApprovalPayload().request },
    toolApprovalPayload({ kind: undefined }),
    toolApprovalPayload({ risk: "critical" }),
    toolApprovalPayload({ detail: undefined, description: "旧描述" }),
    toolApprovalPayload({ providerCallId: undefined }),
    toolApprovalPayload({ planId: "plan-alias" }),
    {
      approvalId: "plan-old",
      runId: "run-old",
      request: {
        kind: "plan",
        title: "old",
        detail: "old",
        risk: "high",
        plan: { planId: "nested-only", revision: 1, title: "old", steps: [{ title: "x" }] },
      },
    },
  ];
  for (const value of malformed) {
    assert.equal(parseApprovalRequestedPayload(value), undefined, JSON.stringify(value));
  }
});

test("approval.requested 通知要求 payload.runId 与 scope.runId 一致", () => {
  const current = createRuntimeNotification({
    topic: "approval.requested",
    scope: { workspacePath: "/workspace", sessionId: "session-1", runId: "run-tool" },
    resourceVersion: 1,
    at: 1,
    payload: toolApprovalPayload(),
  });
  assert.equal(isApprovalRequestedRuntimeNotification(current), true);
  assert.equal(
    isApprovalRequestedRuntimeNotification({
      ...current,
      scope: { ...current.scope, runId: "other-run" },
    }),
    false,
  );
});

test("parseApprovalRequestedPayload：diff/sessionScope 直读（3-D 漏账补齐）", () => {
  const view = parseApprovalRequestedPayload({
    ...toolApprovalPayload({
      diff: "--- a\n+++ b\n@@\n-a\n+b",
      sessionScope: { type: "file", path: "a.txt", access: "edit", safety: true },
    }),
  });
  assert.ok(view && view.kind === "tool");
  assert.equal(view.providerCallId, "call-tool");
  assert.equal(view.diff, "--- a\n+++ b\n@@\n-a\n+b");
  assert.deepEqual(view.sessionScope, {
    type: "file",
    path: "a.txt",
    access: "edit",
    safety: true,
  });

  // 其余 scope 形状逐一过（all-edits / directories / bash-command / tool）。
  const shapes: readonly unknown[] = [
    { type: "all-edits" },
    { type: "directories", directories: ["C:\\ws"], access: "read", enableAutoEdits: false },
    { type: "bash-command", command: "npm ", match: "prefix" },
    { type: "tool", toolName: "bash" },
  ];
  for (const sessionScope of shapes) {
    const scoped = parseApprovalRequestedPayload({
      ...toolApprovalPayload({ sessionScope }),
    });
    assert.ok(
      scoped && scoped.kind === "tool",
      `sessionScope 应解析：${JSON.stringify(sessionScope)}`,
    );
    assert.deepEqual(scoped.sessionScope, sessionScope);
  }
});

test("parseApprovalRequestedPayload：sessionScope 形状不完整降级为 undefined（绝不猜形状）", () => {
  const malformed: readonly unknown[] = [
    "not-an-object",
    { type: "unknown-kind" },
    { type: "file", path: "a.txt" }, // 缺 access
    { type: "file", path: "", access: "edit" }, // 空 path
    { type: "directories", directories: [], access: "edit", enableAutoEdits: true }, // 空目录
    { type: "directories", directories: ["d"], access: "readwrite", enableAutoEdits: true }, // 非法 access
    { type: "directories", directories: ["d"], access: "read" }, // 缺 enableAutoEdits
    { type: "bash-command", command: "npm" }, // 缺 match
    { type: "bash-command", command: "npm", match: "glob" }, // 非法 match
    { type: "tool" }, // 缺 toolName
  ];
  for (const sessionScope of malformed) {
    const view = parseApprovalRequestedPayload({
      ...toolApprovalPayload({ sessionScope }),
    });
    assert.equal(
      view,
      undefined,
      `malformed sessionScope 必须整体拒绝：${JSON.stringify(sessionScope)}`,
    );
  }
});
