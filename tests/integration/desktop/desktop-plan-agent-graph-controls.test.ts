import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationInteractionSlot } from "../../../apps/desktop/src/renderer/conversation/ConversationInteractionSlot.js";
import {
  approvalFromPlanControlSnapshot,
  conversationItemsFromReplica,
  pendingToolApprovalFromTranscript,
} from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import { parseStrictRuntimeParams } from "../../../packages/protocol/src/runtime.js";

test("Desktop restores an active Graph Plan as progress with only CAS-protected cancellation", () => {
  const projection = {
    sessionId: "session-graph-plan",
    sessionSequence: 12,
    controlEpoch: "plan-step-a-completed",
    operationId: "update-plan:step-a",
    proposals: [],
    execution: {
      planId: "plan-graph",
      revision: 1,
      status: "active" as const,
      steps: [
        { id: "a", title: "调查分支 A", description: "Read A", status: "completed" as const },
        { id: "b", title: "调查分支 B", description: "Read B", status: "pending" as const },
      ],
      graph: { graphId: "graph-1", epoch: 1 },
      startedAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:01.000Z",
    },
  };
  const approval = approvalFromPlanControlSnapshot(
    { version: 1, availability: "ready", state: "committed_executing", projection },
    projection.sessionId,
  );
  assert.ok(approval);
  assert.equal(approval.planControlMode, "graph_active");
  assert.equal(approval.title, "计划执行中");
  assert.match(approval.detail, /计划由 Graph 执行，等待或处理子任务结果/u);
  const transcript = conversationItemsFromReplica({
    phase: "ready",
    generation: 1,
    sessionId: projection.sessionId,
    records: [
      {
        itemId: "historical-plan-handoff",
        itemRevision: 1,
        positionSequence: 1,
        positionOrdinal: 0,
        item: {
          id: "historical-plan-handoff",
          kind: "approval",
          title: "双分支读取",
          state: "waiting",
          data: { approvalId: "plan-graph", kind: "plan", planId: "plan-graph" },
        },
      },
    ],
    activeOverlay: [],
    queuedInputs: [],
  });
  assert.equal(
    pendingToolApprovalFromTranscript(transcript),
    undefined,
    "a historical Plan handoff must not replace Graph progress with tool permission buttons",
  );
  const toolApproval = {
    id: "approval:tool-1",
    kind: "approval" as const,
    approvalKind: "tool" as const,
    title: "执行命令",
    detail: "需要授权",
    state: "pending" as const,
  };
  assert.equal(pendingToolApprovalFromTranscript([toolApproval, ...transcript]), toolApproval);
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    React.createElement(ConversationInteractionSlot, {
      approval,
      busy: false,
      onApprovalDecision: () => undefined,
      onPromptAnswer: () => undefined,
    }),
  );
  assert.match(html, /计划执行进度/u);
  assert.match(html, /调查分支 A/u);
  assert.match(html, /调查分支 B/u);
  assert.equal((html.match(/<button\b/gu) ?? []).length, 1);
  assert.match(html, /取消执行/u);
  assert.doesNotMatch(html, /中断|重新规划|继续执行|确认执行计划|<textarea/u);
  const cancellation = parseStrictRuntimeParams("plan.respond", {
    workspacePath: "/workspace",
    sessionId: approval.sessionId!,
    planId: approval.planId!,
    action: "cancel_execution",
    expectedRevision: approval.expectedRevision!,
    expectedSessionSequence: approval.expectedSessionSequence!,
    controlEpoch: approval.controlEpoch!,
  });
  assert.equal(cancellation.controlEpoch, projection.controlEpoch);
  assert.equal(cancellation.expectedSessionSequence, projection.sessionSequence);
  assert.equal(cancellation.action, "cancel_execution");

  const ordinaryExecution = { ...projection.execution };
  Reflect.deleteProperty(ordinaryExecution, "graph");
  assert.equal(
    approvalFromPlanControlSnapshot(
      {
        version: 1,
        availability: "ready",
        state: "committed_executing",
        projection: { ...projection, execution: ordinaryExecution },
      },
      projection.sessionId,
    ),
    undefined,
    "ordinary active Plans must not get Graph controls",
  );
  assert.equal(
    approvalFromPlanControlSnapshot(
      {
        version: 1,
        availability: "ready",
        state: "terminal",
        projection: { ...projection, execution: { ...projection.execution, status: "completed" } },
      },
      projection.sessionId,
    ),
    undefined,
    "completed Graph Plans must remove execution controls",
  );
});
