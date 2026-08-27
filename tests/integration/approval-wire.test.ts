import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalManager, type ApprovalNotice } from "../../src/approval/manager.js";
import { buildApprovalRequestedPayload } from "../../src/daemon/approval-wire.js";
import { parseApprovalRequestedPayload } from "@pico/protocol";
import { DEFAULT_INTERACTION_MODE } from "../../src/input/session-settings.js";
import { buildPermissionMiddleware } from "../../src/runtime/agent-runtime.js";

/**
 * approval.requested wire 构造单一来源的形状测试（3-D 漏账补齐）。
 *
 * 关键回归面：providerCallId / diff / sessionScope 三字段此前在发射点被
 * 丢弃——TUI 审批面板因此降级（无 diff 预览、仅 2 选项）。构造结果必须能
 * 被 @pico/protocol parseApprovalRequestedPayload 结构化读回（构造与解析
 * 成对锚定，防止 wire 语义漂移）。
 */

function toolNotice(overrides: Partial<ApprovalNotice> = {}): ApprovalNotice {
  return {
    taskId: "approval_1",
    toolName: "edit_file",
    args: JSON.stringify({ path: "a.txt", new_string: "b", old_string: "a" }),
    providerCallId: "call_1",
    message: "需要修改 a.txt",
    preview: { target: "a.txt", summary: "修改 a.txt" },
    ...overrides,
  };
}

test("buildApprovalRequestedPayload carries providerCallId/diff/sessionScope on the wire", () => {
  const payload = buildApprovalRequestedPayload(
    toolNotice({
      diff: "--- a.txt\n+++ a.txt\n@@\n-a\n+b",
      sessionScope: { type: "file", path: "a.txt", access: "edit" },
    }),
    "run_1",
  );
  const request = payload["request"] as Record<string, unknown>;
  assert.equal(request["providerCallId"], "call_1");
  assert.equal(request["diff"], "--- a.txt\n+++ a.txt\n@@\n-a\n+b");
  const scope = request["sessionScope"] as Record<string, unknown>;
  assert.equal(scope["type"], "file");
  assert.equal(scope["path"], "a.txt");
  assert.equal(scope["access"], "edit");
  // 基础面保持：approvalId/runId 顶层 + title/detail/toolName/args/command/risk。
  assert.equal(payload["approvalId"], "approval_1");
  assert.equal(payload["runId"], "run_1");
  assert.equal(request["command"], "a.txt");
  assert.equal(request["risk"], "high");

  // 构造 → 解析成对：view 读回全部新字段（TUI 消费面同源语义）。
  const view = parseApprovalRequestedPayload(payload);
  assert.ok(view);
  assert.equal(view.providerCallId, "call_1");
  assert.equal(view.diff, "--- a.txt\n+++ a.txt\n@@\n-a\n+b");
  assert.deepEqual(view.sessionScope, { type: "file", path: "a.txt", access: "edit" });
});

test("buildApprovalRequestedPayload omits absent optionals and keeps plan shape", () => {
  // bash 无 diff/无 sessionScope（引擎 computeApprovalDiff 对非编辑工具返回 undefined）。
  const toolPayload = buildApprovalRequestedPayload(
    toolNotice({ toolName: "bash", diff: undefined, sessionScope: undefined, preview: undefined }),
    "run_1",
  );
  const toolRequest = toolPayload["request"] as Record<string, unknown>;
  assert.ok(!("diff" in toolRequest));
  assert.ok(!("sessionScope" in toolRequest));
  assert.ok(!("command" in toolRequest));

  const planPayload = buildApprovalRequestedPayload(
    toolNotice({
      toolName: "exit_plan_mode",
      providerCallId: "",
      ...({
        kind: "plan",
        planId: "plan_42",
        expectedRevision: 3,
        expectedSessionSequence: 7,
        plan: { title: "计划", steps: [{ title: "步骤一" }] },
      } as unknown as Partial<ApprovalNotice>),
    }),
    "run_1",
  );
  const planRequest = planPayload["request"] as Record<string, unknown>;
  assert.equal(planRequest["kind"], "plan");
  assert.equal(planRequest["planId"], "plan_42");
  assert.equal(planRequest["expectedRevision"], 3);
  assert.deepEqual(planRequest["actions"], ["execute", "continue_editing", "reject_exit"]);
  assert.ok(!("providerCallId" in planRequest), "空 providerCallId 不上 wire");
  const view = parseApprovalRequestedPayload(planPayload);
  assert.equal(view?.kind, "plan");
  assert.deepEqual(view?.planSteps, ["步骤一"]);
});

test("fresh default mode asks before the first workspace write", async () => {
  const manager = new ApprovalManager(60_000);
  let requested: ApprovalNotice | undefined;
  const middleware = buildPermissionMiddleware(
    (notice) => {
      requested = notice;
      manager.resolveApproval(notice.taskId, false, "test rejection");
    },
    process.cwd(),
    undefined,
    manager,
    { sessionId: "fresh-session", mode: DEFAULT_INTERACTION_MODE },
  );

  const decision = await middleware({
    id: "write-call-1",
    name: "write_file",
    arguments: JSON.stringify({ path: "first-write.txt", content: "blocked" }),
  });

  assert.equal(DEFAULT_INTERACTION_MODE, "default");
  assert.equal(requested?.toolName, "write_file");
  assert.equal(decision.allowed, false);
});
