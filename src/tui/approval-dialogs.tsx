import { createHash } from "node:crypto";
import { globalApprovalManager, type ApprovalNotice } from "../approval/manager.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { approvalDialogId, InteractiveApprovalPanel } from "./approval-panel.js";
import type { ApprovalPanelAction } from "./approval-panel.js";
import type { TuiReporter } from "./tui-reporter.js";

/**
 * 审批对话框共享装配（3-D Phase 2 提取，repl.tsx 与 client-repl.tsx 共同消费）。
 *
 * 两路 action 路由：普通审批（approve/approve-session/reject/modify）默认走
 * 进程内 globalApprovalManager——client 模式不复用该实现（跨进程不可达），但
 * 复用对话框工厂与 plan 路由的操作映射；plan 类动作经 deps.planControl.respond
 * （进程内 = AgentRuntime 计划控制；client 模式 = plan.respond RPC 的同形适配器）。
 */

export const APPROVAL_DIALOG_PRIORITY = 80;

export type PlanApprovalAction = Extract<
  ApprovalPanelAction,
  | "execute"
  | "continue-editing"
  | "reject-exit"
  | "resume-execution"
  | "cancel-execution"
  | "replan-execution"
>;

/** plan 动作之外的普通审批动作（modify 仅来自命令解析，不在面板联合内）。 */
export type PlainApprovalAction = Exclude<ApprovalPanelAction, PlanApprovalAction>;

export interface PlanApprovalControl {
  respond(input: {
    readonly sessionId: string;
    readonly planId: string;
    readonly action:
      | "execute"
      | "continue_editing"
      | "reject_exit"
      | "resume_execution"
      | "cancel_execution"
      | "replan_execution";
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
    readonly operationId: string;
    readonly feedback?: string;
  }): Promise<unknown>;
}

export interface ApprovalDialogDeps {
  readonly reporter: Pick<TuiReporter, "pushSystemMessage">;
  readonly closeDialog?: ((id: string) => void) | undefined;
  readonly sessionId?: string | undefined;
  readonly planControl?: PlanApprovalControl | undefined;
  /**
   * 覆盖普通审批动作解析（client 模式注入：approval.respond RPC，异步）。
   * 缺省走进程内 globalApprovalManager（跨进程不可达）。
   */
  readonly resolvePlain?:
    | ((
        action: "approve" | "approve-session" | "reject",
        taskId: string,
      ) => boolean | Promise<boolean>)
    | undefined;
}

export function isPlanApprovalAction(action: ApprovalPanelAction): action is PlanApprovalAction {
  return (
    action === "execute" ||
    action === "continue-editing" ||
    action === "reject-exit" ||
    action === "resume-execution" ||
    action === "cancel-execution" ||
    action === "replan-execution"
  );
}

export function createApprovalDialogRequest(
  notice: ApprovalNotice,
  deps: ApprovalDialogDeps,
): DialogRequest {
  return {
    id: approvalDialogId(notice.taskId),
    layer: "modal",
    priority: APPROVAL_DIALOG_PRIORITY,
    content: (
      <InteractiveApprovalPanel
        {...notice}
        onAction={(action, feedback) => {
          if (isPlanApprovalAction(action)) {
            void resolvePlanApprovalAction(notice, action, feedback, deps);
            return;
          }
          if (deps.resolvePlain) {
            resolveApprovalActionVia(deps.resolvePlain, action, notice.taskId, deps);
            return;
          }
          resolveApprovalAction({ action, taskId: notice.taskId }, deps);
        }}
      />
    ),
  };
}

export async function resolvePlanApprovalAction(
  notice: ApprovalNotice,
  action: PlanApprovalAction,
  feedback: string | undefined,
  deps: ApprovalDialogDeps,
): Promise<void> {
  const metadata = notice as ApprovalNotice & {
    readonly planId?: string;
    readonly expectedRevision?: number;
    readonly expectedSessionSequence?: number;
  };
  if (!deps.planControl || !deps.sessionId) {
    deps.reporter.pushSystemMessage(
      "Plan review is unavailable until the Runtime PlanControl port is connected.",
    );
    return;
  }
  try {
    await deps.planControl.respond({
      sessionId: deps.sessionId,
      planId: metadata.planId ?? notice.taskId,
      action: mapPlanActionToProtocol(action),
      expectedRevision: metadata.expectedRevision ?? 0,
      expectedSessionSequence: metadata.expectedSessionSequence ?? 0,
      operationId: planReviewOperationId(metadata, action, feedback),
      ...(feedback ? { feedback } : {}),
    });
    deps.closeDialog?.(approvalDialogId(notice.taskId));
  } catch (error) {
    deps.reporter.pushSystemMessage(
      `Plan changed while reviewing; refresh the proposal and retry. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function mapPlanActionToProtocol(
  action: PlanApprovalAction,
):
  | "execute"
  | "continue_editing"
  | "reject_exit"
  | "resume_execution"
  | "cancel_execution"
  | "replan_execution" {
  return action === "continue-editing"
    ? "continue_editing"
    : action === "resume-execution"
      ? "resume_execution"
      : action === "cancel-execution"
        ? "cancel_execution"
        : action === "replan-execution"
          ? "replan_execution"
          : action === "reject-exit"
            ? "reject_exit"
            : "execute";
}

export function planReviewOperationId(
  metadata: {
    readonly planId?: string;
    readonly expectedRevision?: number;
    readonly expectedSessionSequence?: number;
  },
  action: PlanApprovalAction,
  feedback: string | undefined,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        planId: metadata.planId ?? "unknown",
        revision: metadata.expectedRevision ?? 0,
        sessionSequence: metadata.expectedSessionSequence ?? 0,
        action,
        feedback: feedback?.trim() ?? "",
      }),
    )
    .digest("hex");
  return `tui-plan:${digest}`;
}

/** 注入式普通审批解析（client 模式：approval.respond RPC 映射；允许异步）。 */
export function resolveApprovalActionVia(
  resolve: (
    action: "approve" | "approve-session" | "reject",
    taskId: string,
  ) => boolean | Promise<boolean>,
  action: PlainApprovalAction,
  taskId: string,
  deps: Pick<ApprovalDialogDeps, "reporter" | "closeDialog">,
): boolean {
  const outcome = resolve(action, taskId);
  deps.closeDialog?.(approvalDialogId(taskId));
  if (outcome instanceof Promise) {
    void outcome.then((ok) =>
      deps.reporter.pushSystemMessage(approvalResolutionMessage(action, ok)),
    );
    return true;
  }
  deps.reporter.pushSystemMessage(approvalResolutionMessage(action, outcome));
  return outcome;
}

/**
 * 普通审批动作解析（进程内 globalApprovalManager）。client 模式不调用本函数
 * （跨进程不可达），自行映射 approval.respond RPC；提示语经
 * approvalResolutionMessage 共享。
 */
export function resolveApprovalAction(
  parsed:
    | { action: PlainApprovalAction; taskId: string }
    | { action: "modify"; taskId: string; content: string },
  deps: Pick<ApprovalDialogDeps, "reporter" | "closeDialog">,
): boolean {
  const ok =
    parsed.action === "modify"
      ? globalApprovalManager.resolveApprovalWithModify(parsed.taskId, "TUI modify", parsed.content)
      : parsed.action === "approve-session"
        ? globalApprovalManager.resolveApprovalForSession(parsed.taskId, "TUI approve-session")
        : globalApprovalManager.resolveApproval(
            parsed.taskId,
            parsed.action === "approve",
            `TUI ${parsed.action}`,
          );

  deps.closeDialog?.(approvalDialogId(parsed.taskId));
  deps.reporter.pushSystemMessage(approvalResolutionMessage(parsed.action, ok));
  return ok;
}

export function approvalResolutionMessage(
  action: PlainApprovalAction | "modify",
  ok: boolean,
): string {
  return ok
    ? action === "approve-session"
      ? "本会话内允许。"
      : action === "approve"
        ? "已允许一次。"
        : action === "reject"
          ? "已拒绝。"
          : "已带修改批准。"
    : "审批请求已失效。";
}
