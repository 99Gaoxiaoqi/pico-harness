import { globalApprovalManager, type ApprovalNotice } from "../approval/manager.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import {
  approvalDialogId,
  InteractiveApprovalPanel,
  InteractivePlanControlPanel,
  planControlDialogId,
} from "./approval-panel.js";
import type { ApprovalPanelAction, PlanControlPanelAction } from "./approval-panel.js";
import type { PlanControlNotice } from "./plan-control-notice.js";
import type { TuiReporter } from "./tui-reporter.js";

/**
 * 审批对话框共享装配（3-D Phase 2 提取，repl.tsx 与 client-repl.tsx 共同消费）。
 *
 * 普通工具审批与 PlanControl 使用独立的 notice、面板和 action 路由。
 * 工具审批默认走进程内 globalApprovalManager；client 模式注入
 * approval.respond。PlanControl 始终通过显式 port 发送 plan.respond。
 */

export const APPROVAL_DIALOG_PRIORITY = 80;

/** modify 仅来自命令解析，不在面板联合内。 */
export type PlainApprovalAction = ApprovalPanelAction;

export interface PlanControlPort {
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
    readonly controlEpoch: string;
    readonly feedback?: string;
  }): Promise<unknown>;
}

export interface ApprovalDialogDeps {
  readonly reporter: Pick<TuiReporter, "pushSystemMessage">;
  readonly closeDialog?: ((id: string) => void) | undefined;
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

export interface PlanControlDialogDeps {
  readonly reporter: Pick<TuiReporter, "pushSystemMessage">;
  readonly closeDialog?: ((id: string) => void) | undefined;
  readonly planControl: PlanControlPort;
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
        onAction={(action) => {
          if (deps.resolvePlain) {
            return resolveApprovalActionVia(deps.resolvePlain, action, notice.taskId, deps);
          }
          return resolveApprovalAction({ action, taskId: notice.taskId }, deps);
        }}
      />
    ),
  };
}

export function createPlanControlDialogRequest(
  notice: PlanControlNotice,
  deps: PlanControlDialogDeps,
): DialogRequest {
  return {
    id: planControlDialogId(notice.controlId),
    layer: "modal",
    priority: APPROVAL_DIALOG_PRIORITY,
    content: (
      <InteractivePlanControlPanel
        {...notice}
        onAction={(action, feedback) => resolvePlanControlAction(notice, action, feedback, deps)}
      />
    ),
  };
}

export async function resolvePlanControlAction(
  notice: PlanControlNotice,
  action: PlanControlPanelAction,
  feedback: string | undefined,
  deps: PlanControlDialogDeps,
): Promise<boolean> {
  try {
    await deps.planControl.respond({
      sessionId: notice.sessionId,
      planId: notice.planId,
      action: mapPlanActionToProtocol(action),
      expectedRevision: notice.expectedRevision,
      expectedSessionSequence: notice.expectedSessionSequence,
      controlEpoch: notice.controlEpoch,
      ...(feedback ? { feedback } : {}),
    });
    deps.closeDialog?.(planControlDialogId(notice.controlId));
    return true;
  } catch (error) {
    deps.reporter.pushSystemMessage(
      `Plan changed while reviewing; refresh the proposal and retry. ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function mapPlanActionToProtocol(
  action: PlanControlPanelAction,
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
