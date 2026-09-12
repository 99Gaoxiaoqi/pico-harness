import type { ApprovalNotice } from "../approval/manager.js";
import { isJsonObject, isJsonValue, type JsonObject } from "@pico/protocol";

/**
 * approval.requested 通知 payload 的唯一构造点（3-D 漏账补齐，2026-08-16）。
 *
 * 引擎拦截时 ApprovalNotice 已携带 providerCallId（工具卡精确匹配）/
 * diff（computeApprovalDiff 的 before/after 预览）/ sessionScope
 * （permissionScopeForCall 的结构化会话授权形状）；旧发射点只透传
 * title/detail/toolName/args/command，导致 TUI 客户端审批面板降级——
 * 无 diff 预览、无"本会话内允许"第三选项（面板按 notice.sessionScope
 * 有无渲染 2/3 选项）。
 *
 * wire 消费面 = @pico/protocol parseApprovalRequestedPayload（结构化读取
 * 单一来源，TUI 客户端与 Desktop renderer 同源）。超限 payload 由
 * transportSafeRuntimeNotification 分级裁剪兜底，无需发射侧截断。
 */
export function buildApprovalRequestedPayload(notice: ApprovalNotice, runId: string): JsonObject {
  return jsonObject({
    approvalId: notice.taskId,
    runId,
    request: {
      kind: "tool",
      title: "需要你的批准",
      detail: notice.preview?.summary ?? notice.message,
      toolName: notice.toolName,
      args: notice.args,
      providerCallId: notice.providerCallId,
      ...(notice.preview?.target ? { command: notice.preview.target } : {}),
      ...(notice.diff ? { diff: notice.diff } : {}),
      ...(notice.sessionScope ? { sessionScope: notice.sessionScope } : {}),
      risk: "high",
    },
  });
}

function jsonObject(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Approval payload is not JSON serializable");
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonObject(parsed) || !isJsonValue(parsed)) {
    throw new Error("Approval payload must be a JSON object");
  }
  return parsed as JsonObject;
}
