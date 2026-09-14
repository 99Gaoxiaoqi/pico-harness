import { PlanConflictError, type PlanProjection, type PlanProposal } from "@pico/core";

const PLAN_REVISION_FEEDBACK_MAX_CHARS = 4_000;
const PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS = 256;

export function approvedPlanExecutionPrompt(proposal: PlanProposal): string {
  return [
    "[APPROVED PLAN EXECUTION] 用户已批准以下计划。现在按当前权限模式执行；不要重新进入 Plan Mode。",
    `Plan: ${proposal.title} (${proposal.planId}@${proposal.revision})`,
    proposal.overview ? `Overview: ${proposal.overview}` : undefined,
    "Steps:",
    ...proposal.steps.map((step) => `- ${step.id}: ${step.title}\n  ${step.description}`),
    proposal.risks?.length
      ? `Risks:\n${proposal.risks.map((risk) => `- ${risk}`).join("\n")}`
      : undefined,
    "开始执行某一步前，先调用 update_plan 将它标记为 in_progress；实施并验证成功后，再调用 update_plan 将它标记为 completed（不再需要的步骤标记为 skipped）。",
    "Graph 模式允许通过 yield_agent_graph 持久化等待子任务，并在唤醒后继续。除此之外，只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

export function resumedPlanExecutionPrompt(projection: PlanProjection): string {
  const execution = projection.execution;
  if (!execution) throw new PlanConflictError("Plan execution is unavailable");
  return [
    "[RESUMED PLAN EXECUTION] 用户明确恢复此前中断的计划。只继续尚未完成的步骤。",
    `Plan: ${execution.planId}@${execution.revision}`,
    ...execution.steps.map(
      (step) => `- [${step.status}] ${step.id}: ${step.title}\n  ${step.description}`,
    ),
    "恢复某一步前，先调用 update_plan 将它标记为 in_progress；实施并验证成功后，再调用 update_plan 将它标记为 completed（不再需要的步骤标记为 skipped）。",
    "Graph 模式允许通过 yield_agent_graph 持久化等待子任务，并在唤醒后继续。除此之外，只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
  ].join("\n\n");
}

export function planRevisionRequestTurnTail(projection: PlanProjection): string | undefined {
  const request = projection.revisionRequest;
  if (!request) return undefined;
  const context = {
    planId: request.planId.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    expectedRevision: request.expectedRevision,
    operationId: request.operationId.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    requestedAt: request.requestedAt.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    feedback: boundedPlanRevisionFeedback(request.feedback),
  };
  return [
    "<plan-revision-request>",
    "这是从持久化事件恢复的用户修订要求。请按该反馈调查并调用 submit_plan 提交同一 planId 的下一修订版；不要批准或执行旧修订。",
    JSON.stringify(context),
    "</plan-revision-request>",
  ].join("\n");
}

function boundedPlanRevisionFeedback(feedback: string): string {
  if (feedback.length <= PLAN_REVISION_FEEDBACK_MAX_CHARS) return feedback;
  const omitted = feedback.length - PLAN_REVISION_FEEDBACK_MAX_CHARS;
  return `${feedback.slice(0, PLAN_REVISION_FEEDBACK_MAX_CHARS)}\n...[truncated ${omitted} chars]`;
}
