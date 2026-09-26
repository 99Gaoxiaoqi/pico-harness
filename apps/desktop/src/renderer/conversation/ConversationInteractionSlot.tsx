import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextAreaField } from "../ui-controls.js";
import { GitBranch, ShieldAlert, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { ApprovalDetails, approvalActionTitle, approvalScopeLabel } from "../ApprovalDetails.js";
import type { ApprovalView, PromptView } from "../model.js";

type ApprovalDecision =
  | "allow_once"
  | "allow_session"
  | "deny"
  | "execute"
  | "continue_editing"
  | "reject_exit"
  | "resume_execution"
  | "cancel_execution"
  | "replan_execution";

export function ConversationInteractionSlot({
  approval,
  prompt,
  busy,
  onApprovalDecision,
  onPromptAnswer,
  onStop,
}: {
  readonly approval?: ApprovalView | undefined;
  readonly prompt?: PromptView | undefined;
  readonly busy: boolean;
  readonly onApprovalDecision: (decision: ApprovalDecision, feedback?: string) => void;
  readonly onPromptAnswer: (answer: string) => void;
  readonly onStop?: (() => void) | undefined;
}) {
  const [feedback, setFeedback] = useState("");
  useEffect(
    () => setFeedback(approval?.planFeedback ?? ""),
    [approval?.id, approval?.planFeedback],
  );

  if (prompt) {
    return (
      <section className="conversation-interaction-slot" aria-labelledby="pending-question-title">
        <div className="conversation-interaction-slot__heading">
          <span>需要你的回答</span>
          <h2 id="pending-question-title">{prompt.question}</h2>
          <p>选择后 Pico 会在当前轮次继续执行。</p>
        </div>
        <div className="conversation-interaction-slot__actions">
          {prompt.options.map((option) => (
            <AstryxButton
              className="pico-page-control"
              label={option}
              variant="ghost"
              key={option}
              type="button"
              isDisabled={busy}
              onClick={() => onPromptAnswer(option)}
            >
              {option}
            </AstryxButton>
          ))}
          {onStop && (
            <AstryxButton
              label="停止任务"
              variant="ghost"
              type="button"
              className="pico-page-control is-danger"
              isDisabled={busy}
              onClick={onStop}
            >
              <Square aria-hidden="true" /> 停止任务
            </AstryxButton>
          )}
        </div>
      </section>
    );
  }

  if (!approval) return null;
  const planApproval = approval.kind === "plan";
  const interruptedPlan = approval.planControlMode === "interrupted";
  const revisionPlan = approval.planControlMode === "revision";
  const activeGraphPlan = approval.planControlMode === "graph_active";
  return (
    <section className="conversation-interaction-slot" aria-labelledby="pending-approval-title">
      <div className="conversation-interaction-slot__heading">
        {planApproval && (
          <span>
            {activeGraphPlan ? (
              <GitBranch aria-hidden="true" />
            ) : (
              <ShieldAlert aria-hidden="true" />
            )}
            {activeGraphPlan ? "计划执行进度" : "确认执行计划"}
          </span>
        )}
        <h2 id="pending-approval-title">
          {!planApproval && <ShieldAlert aria-hidden="true" />}
          {planApproval
            ? (approval.planTitle ?? approval.title)
            : `允许${approvalActionTitle(approval)}？`}
        </h2>
        <p>{approval.planOverview ?? approval.detail}</p>
      </div>
      {approval.kind === "tool" && <ApprovalDetails approval={approval} />}
      {approval.planSteps && (
        <ol>
          {approval.planSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {planApproval && !revisionPlan && !interruptedPlan && !activeGraphPlan && (
        <div className="conversation-interaction-slot__feedback">
          <span>需要调整时说明原因</span>
          <TextAreaField
            label="需要调整时说明原因"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </div>
      )}
      <div className="conversation-interaction-slot__actions">
        {activeGraphPlan ? (
          <AstryxButton
            label="取消执行"
            variant="ghost"
            type="button"
            className="pico-page-control is-danger"
            isDisabled={busy}
            onClick={() => onApprovalDecision("cancel_execution")}
          >
            取消执行
          </AstryxButton>
        ) : interruptedPlan ? (
          <>
            <AstryxButton
              label="取消执行"
              variant="ghost"
              type="button"
              className="pico-page-control is-danger"
              isDisabled={busy}
              onClick={() => onApprovalDecision("cancel_execution")}
            >
              取消执行
            </AstryxButton>
            <AstryxButton
              className="pico-page-control"
              label="重新规划"
              variant="ghost"
              type="button"
              isDisabled={busy}
              onClick={() => onApprovalDecision("replan_execution")}
            >
              重新规划
            </AstryxButton>
            <AstryxButton
              label="继续执行"
              variant="ghost"
              type="button"
              className="pico-page-control is-primary"
              isDisabled={busy}
              onClick={() => onApprovalDecision("resume_execution")}
            >
              继续执行
            </AstryxButton>
          </>
        ) : revisionPlan ? (
          <AstryxButton
            label="恢复继续修改"
            variant="ghost"
            type="button"
            className="pico-page-control is-primary"
            isDisabled={busy}
            onClick={() => onApprovalDecision("continue_editing", approval.planFeedback)}
          >
            恢复继续修改
          </AstryxButton>
        ) : planApproval ? (
          <>
            <AstryxButton
              label="拒绝并退出"
              variant="ghost"
              type="button"
              className="pico-page-control is-danger"
              isDisabled={busy}
              onClick={() => onApprovalDecision("reject_exit")}
            >
              拒绝并退出
            </AstryxButton>
            <AstryxButton
              className="pico-page-control"
              label="继续修改"
              variant="ghost"
              type="button"
              isDisabled={busy || !feedback.trim()}
              onClick={() => onApprovalDecision("continue_editing", feedback.trim())}
            >
              继续修改
            </AstryxButton>
            <AstryxButton
              label="执行计划"
              variant="ghost"
              type="button"
              className="pico-page-control is-primary"
              isDisabled={busy}
              onClick={() => onApprovalDecision("execute")}
            >
              执行计划
            </AstryxButton>
          </>
        ) : (
          <>
            <AstryxButton
              label="拒绝"
              variant="ghost"
              type="button"
              className="pico-page-control is-danger"
              isDisabled={busy}
              onClick={() => onApprovalDecision("deny")}
            >
              拒绝
            </AstryxButton>
            {approval.sessionScope && (
              <AstryxButton
                className="pico-page-control"
                label={approvalScopeLabel(approval.sessionScope)}
                variant="ghost"
                type="button"
                isDisabled={busy}
                onClick={() => onApprovalDecision("allow_session")}
              >
                {approvalScopeLabel(approval.sessionScope)}
              </AstryxButton>
            )}
            <AstryxButton
              label="仅允许这次"
              variant="ghost"
              type="button"
              className="pico-page-control is-primary"
              isDisabled={busy}
              onClick={() => onApprovalDecision("allow_once")}
            >
              仅允许这次
            </AstryxButton>
          </>
        )}
      </div>
    </section>
  );
}
