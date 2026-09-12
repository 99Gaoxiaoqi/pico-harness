import type {
  RuntimePlanExecution,
  RuntimePlanProjection,
  RuntimePlanProposal,
} from "@pico/protocol";

interface PlanControlNoticeBase {
  readonly kind: "plan-control";
  /** Stable identity for the currently actionable control card. */
  readonly controlId: string;
  readonly sessionId: string;
  readonly planId: string;
  readonly expectedRevision: number;
  readonly expectedSessionSequence: number;
  readonly controlEpoch: string;
  readonly message: string;
}

export type PlanControlNotice =
  | (PlanControlNoticeBase & {
      readonly mode: "review";
      readonly proposal: RuntimePlanProposal;
    })
  | (PlanControlNoticeBase & {
      readonly mode: "interrupted";
      readonly execution: RuntimePlanExecution;
    });

/**
 * Projects the durable Runtime PlanControl state into the TUI's dedicated
 * control-card model. No approval/tool identity is synthesized here.
 */
export function planControlNoticeFromProjection(
  projection: RuntimePlanProjection,
  mode: PlanControlNotice["mode"],
): PlanControlNotice | undefined {
  const controlEpoch = projection.controlEpoch;
  if (!controlEpoch) return undefined;

  const pending = projection.pendingProposal;
  if (mode === "review" && pending) {
    return {
      kind: "plan-control",
      mode: "review",
      controlId: `review:${pending.planId}:${controlEpoch}`,
      sessionId: projection.sessionId,
      planId: pending.planId,
      expectedRevision: pending.revision,
      expectedSessionSequence: projection.sessionSequence,
      controlEpoch,
      message: pending.title || "计划等待审批",
      proposal: pending,
    };
  }

  const execution = projection.execution;
  if (mode === "interrupted" && execution?.status === "interrupted") {
    return {
      kind: "plan-control",
      mode: "interrupted",
      controlId: `interrupted:${execution.planId}:${controlEpoch}`,
      sessionId: projection.sessionId,
      planId: execution.planId,
      expectedRevision: execution.revision,
      expectedSessionSequence: projection.sessionSequence,
      controlEpoch,
      message: execution.reason || "计划执行已中断，请选择下一步。",
      execution,
    };
  }
  return undefined;
}
