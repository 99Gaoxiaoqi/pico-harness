import { parseApprovalRequestedPayload } from "@pico/protocol";
import type { ApprovalView } from "../model.js";

/** Preserve the same authorized scope and preview on live notifications and replay. */
export function parseDesktopToolApproval(
  payload: unknown,
  context: { readonly runId: string; readonly sessionId?: string },
): ApprovalView | undefined {
  const approval = parseApprovalRequestedPayload(payload);
  if (!approval || approval.kind === "plan" || approval.runId !== context.runId) return undefined;
  return {
    id: approval.approvalId,
    runId: approval.runId,
    sessionId: context.sessionId,
    title: approval.title,
    detail: approval.detail,
    command: approval.command,
    risk: approval.risk,
    kind: approval.kind,
    diff: approval.diff,
    sessionScope: approval.sessionScope,
    toolName: approval.toolName,
    providerCallId: approval.providerCallId,
  };
}
