import { PlanConflictError, type PlanProjection, type PlanProposal } from "@pico/core";

const PLAN_REVISION_FEEDBACK_MAX_CHARS = 4_000;
const PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS = 256;
const PLAN_TOOL_OPERATION_ID_INSTRUCTION =
  "调用 submit_plan、update_plan 或 cancel_plan 时，一律省略可选的 operationId，由 runtime 按本次工具调用生成；不要复用历史工具结果或其他操作中的 operationId。";

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
    PLAN_TOOL_OPERATION_ID_INSTRUCTION,
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
    PLAN_TOOL_OPERATION_ID_INSTRUCTION,
    "Graph 模式允许通过 yield_agent_graph 持久化等待子任务，并在唤醒后继续。除此之外，只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
  ].join("\n\n");
}

export function planRevisionRequestPrompt(projection: PlanProjection): string | undefined {
  const request = projection.revisionRequest;
  if (!request) return undefined;
  const context = {
    planId: request.planId.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    expectedRevision: request.expectedRevision,
    requestedAt: request.requestedAt.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    feedback: boundedPlanRevisionFeedback(request.feedback),
  };
  return [
    "<plan-revision-request>",
    "这是用户在上一版计划提交后发出的最新修订要求，由持久化事件恢复。反馈与此前用户要求或旧计划冲突的部分，以本次反馈为准；其余要求仍然有效。不要仅因这些已明确的变更再次请求确认。",
    "请按该反馈调查并调用 submit_plan 提交同一 planId 的下一修订版，然后等待用户批准；本次修订要求不构成执行授权，不要批准计划或执行任何修订版。",
    "调用 submit_plan 时省略可选的 operationId，由 runtime 自动分配本次提交的幂等标识。",
    JSON.stringify(context),
    "</plan-revision-request>",
  ].join("\n");
}

function boundedPlanRevisionFeedback(feedback: string): string {
  if (feedback.length <= PLAN_REVISION_FEEDBACK_MAX_CHARS) return feedback;
  const omitted = feedback.length - PLAN_REVISION_FEEDBACK_MAX_CHARS;
  return `${feedback.slice(0, PLAN_REVISION_FEEDBACK_MAX_CHARS)}\n...[truncated ${omitted} chars]`;
}
