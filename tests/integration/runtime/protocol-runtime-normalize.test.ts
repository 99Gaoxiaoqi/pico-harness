import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isActiveRunStatus,
  isInterruptedRunStatus,
  isStreamingRunStatus,
  isTerminalRunStatus,
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

test("parseApprovalRequestedPayload：全字段直读", () => {
  const view = parseApprovalRequestedPayload({
    approvalId: "apr1",
    runId: "run1",
    request: {
      kind: "plan",
      title: "执行计划",
      detail: "计划详情",
      command: "npm test",
      risk: "high",
      planId: "plan1",
      expectedRevision: 3,
      expectedSessionSequence: 7,
      plan: {
        planId: "plan-nested",
        revision: 1,
        title: "计划",
        overview: "总览",
        steps: [{ title: "步骤一" }, { description: "步骤二描述" }],
      },
    },
  });
  assert.ok(view);
  assert.equal(view.approvalId, "apr1");
  assert.equal(view.runId, "run1");
  assert.equal(view.kind, "plan");
  assert.equal(view.title, "执行计划");
  assert.equal(view.detail, "计划详情");
  assert.equal(view.command, "npm test");
  assert.equal(view.risk, "high");
  // request 层优先，嵌套 plan 兜底。
  assert.equal(view.planId, "plan1");
  assert.equal(view.expectedRevision, 3);
  assert.deepEqual(view.planSteps, ["步骤一", "步骤二描述"]);
  assert.equal(view.planTitle, "计划");
  assert.equal(view.planOverview, "总览");
});

test("parseApprovalRequestedPayload：request.plan 嵌套兜底与 detail/description 双名", () => {
  const view = parseApprovalRequestedPayload({
    approvalId: "apr2",
    runId: "run2",
    request: {
      plan: { planId: "plan-only-nested", revision: 5 },
      description: "描述字段",
    },
  });
  assert.ok(view);
  assert.equal(view.kind, "tool");
  assert.equal(view.detail, "描述字段");
  assert.equal(view.planId, "plan-only-nested");
  assert.equal(view.expectedRevision, 5);
  // 嵌套 planId 兜底也不存在时：undefined（不回退 approvalId——bogus plan.respond 防护）。
  const bare = parseApprovalRequestedPayload({ approvalId: "apr3", runId: "run3", request: {} });
  assert.ok(bare);
  assert.equal(bare.planId, undefined);
  assert.equal(bare.risk, "low");
  assert.equal(bare.title, undefined);
});

test("parseApprovalRequestedPayload：malformed 输入返回 undefined / risk 收紧", () => {
  assert.equal(parseApprovalRequestedPayload(undefined), undefined);
  assert.equal(parseApprovalRequestedPayload(null), undefined);
  assert.equal(parseApprovalRequestedPayload("string"), undefined);
  assert.equal(parseApprovalRequestedPayload({ runId: "run" }), undefined);
  assert.equal(parseApprovalRequestedPayload({ approvalId: "", runId: "run" }), undefined);
  // runId 缺失不致命（调用方按事件 scope 兜底——Desktop 行为）。
  const noRunId = parseApprovalRequestedPayload({ approvalId: "apr-no-run", request: {} });
  assert.ok(noRunId);
  assert.equal(noRunId.runId, undefined);
  // risk 只认 high/medium，其余收紧为 low；expectedRevision 非有限数丢弃。
  const view = parseApprovalRequestedPayload({
    approvalId: "apr4",
    runId: "run4",
    request: { risk: "critical", expectedRevision: Number.NaN },
  });
  assert.ok(view);
  assert.equal(view.risk, "low");
  assert.equal(view.expectedRevision, undefined);
});

test("parseApprovalRequestedPayload：diff/sessionScope 直读（3-D 漏账补齐）", () => {
  const view = parseApprovalRequestedPayload({
    approvalId: "apr5",
    runId: "run5",
    request: {
      toolName: "edit_file",
      providerCallId: "call_5",
      diff: "--- a\n+++ b\n@@\n-a\n+b",
      sessionScope: { type: "file", path: "a.txt", access: "edit", safety: true },
    },
  });
  assert.ok(view);
  assert.equal(view.providerCallId, "call_5");
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
      approvalId: "apr6",
      request: { sessionScope },
    });
    assert.ok(scoped, `sessionScope 应解析：${JSON.stringify(sessionScope)}`);
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
      approvalId: "apr7",
      request: { sessionScope },
    });
    assert.ok(view, `外层 payload 应照常解析：${JSON.stringify(sessionScope)}`);
    assert.equal(
      view.sessionScope,
      undefined,
      `malformed sessionScope 必须降级 undefined：${JSON.stringify(sessionScope)}`,
    );
  }
});
