import { ShieldAlert, Square } from "lucide-react";
import { useEffect, useState } from "react";
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
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => onPromptAnswer(option)}
            >
              {option}
            </button>
          ))}
          {onStop && (
            <button type="button" className="is-danger" disabled={busy} onClick={onStop}>
              <Square aria-hidden="true" /> 停止任务
            </button>
          )}
        </div>
      </section>
    );
  }

  if (!approval) return null;
  const planApproval = approval.kind === "plan";
  const interruptedPlan = approval.planControlMode === "interrupted";
  const revisionPlan = approval.planControlMode === "revision";
  return (
    <section className="conversation-interaction-slot" aria-labelledby="pending-approval-title">
      <div className="conversation-interaction-slot__heading">
        <span>
          <ShieldAlert aria-hidden="true" /> {planApproval ? "确认执行计划" : "等待操作授权"}
        </span>
        <h2 id="pending-approval-title">{approval.planTitle ?? approval.title}</h2>
        <p>{approval.planOverview ?? approval.detail}</p>
      </div>
      {approval.command && <pre>{approval.command}</pre>}
      {approval.planSteps && (
        <ol>
          {approval.planSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {planApproval && !revisionPlan && !interruptedPlan && (
        <label className="conversation-interaction-slot__feedback">
          <span>需要调整时说明原因</span>
          <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} />
        </label>
      )}
      <div className="conversation-interaction-slot__actions">
        {interruptedPlan ? (
          <>
            <button
              type="button"
              className="is-danger"
              disabled={busy}
              onClick={() => onApprovalDecision("cancel_execution")}
            >
              取消执行
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprovalDecision("replan_execution")}
            >
              重新规划
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={busy}
              onClick={() => onApprovalDecision("resume_execution")}
            >
              继续执行
            </button>
          </>
        ) : revisionPlan ? (
          <button
            type="button"
            className="is-primary"
            disabled={busy}
            onClick={() => onApprovalDecision("continue_editing", approval.planFeedback)}
          >
            恢复继续修改
          </button>
        ) : planApproval ? (
          <>
            <button
              type="button"
              className="is-danger"
              disabled={busy}
              onClick={() => onApprovalDecision("reject_exit")}
            >
              拒绝并退出
            </button>
            <button
              type="button"
              disabled={busy || !feedback.trim()}
              onClick={() => onApprovalDecision("continue_editing", feedback.trim())}
            >
              继续修改
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={busy}
              onClick={() => onApprovalDecision("execute")}
            >
              执行计划
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="is-danger"
              disabled={busy}
              onClick={() => onApprovalDecision("deny")}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprovalDecision("allow_session")}
            >
              本任务内允许
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={busy}
              onClick={() => onApprovalDecision("allow_once")}
            >
              仅允许这次
            </button>
          </>
        )}
      </div>
    </section>
  );
}
