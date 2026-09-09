import { parseApprovalRequestedPayload } from "@pico/protocol";
import type { ApprovalView } from "../model.js";

/** Preserve the same authorized scope and preview on live notifications and replay. */
export function parseDesktopToolApproval(
  payload: unknown,
  context: { readonly runId?: string; readonly sessionId?: string } = {},
): ApprovalView | undefined {
  const approval = parseApprovalRequestedPayload(payload);
  if (!approval || approval.kind === "plan") return undefined;
  return {
    id: approval.approvalId,
    runId: approval.runId ?? context.runId ?? "",
    sessionId: context.sessionId,
    title: approval.title ?? "需要你的批准",
    detail: approval.detail ?? "Runtime 请求执行受保护操作。",
    command: approval.command,
    risk: approval.risk,
    kind: approval.kind,
    diff: approval.diff,
    sessionScope: approval.sessionScope,
    toolName: approval.toolName,
    providerCallId: approval.providerCallId,
  };
}
