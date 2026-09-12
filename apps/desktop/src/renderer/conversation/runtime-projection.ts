import { parseDesktopToolApproval } from "../runtime-projections/approval.js";
import { subagentMetadata } from "./subagent-navigation.js";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeActiveOverlayEntry,
  type RuntimeConversationItem,
  type RuntimePlanControlSnapshot,
  type RuntimeToolResultEnvelope,
} from "@pico/protocol";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import {
  type AppData,
  type ApprovalView,
  type ConversationView,
  type JsonRecord,
} from "../model.js";
import { isRecord, numberValue, recordArray, stringValue } from "../runtime-projections/values.js";
import { workspaceSessionKey } from "../workspace-session.js";
import { conversationItemKey } from "./items.js";
import { subagentProgressState } from "./subagent-state.js";
import type { ConversationItemView, ConversationProgressState } from "./types.js";

export function approvalFromPlanProjection(
  value: unknown,
  sessionId: string,
): ApprovalView | undefined {
  const projection = isRecord(value) ? value : undefined;
  const controlEpoch = projection ? stringValue(projection.controlEpoch) : "";
  const projectionOperationId = projection ? stringValue(projection.operationId) : "";
  const pending =
    projection && isRecord(projection.pendingProposal) ? projection.pendingProposal : undefined;
  const execution = projection && isRecord(projection.execution) ? projection.execution : undefined;
  const revisionRequest =
    projection && isRecord(projection.revisionRequest) ? projection.revisionRequest : undefined;
  const graphExecution = execution?.status === "active" && isRecord(execution.graph);
  if (
    !projection ||
    !controlEpoch ||
    !projectionOperationId ||
    isRecord(projection.reviewClaim) ||
    (!pending && execution?.status !== "interrupted" && !graphExecution && !revisionRequest)
  ) {
    return undefined;
  }
  if (!pending && revisionRequest) {
    const planId = stringValue(revisionRequest.planId);
    const revision = numberValue(revisionRequest.expectedRevision, -1);
    const sessionSequence = numberValue(projection.sessionSequence, -1);
    const operationId = stringValue(revisionRequest.operationId);
    const feedback = stringValue(revisionRequest.feedback);
    if (!planId || revision < 0 || sessionSequence < 0 || !operationId || !feedback) {
      return undefined;
    }
    return {
      id: `revision:${planId}:${controlEpoch}`,
      runId: `plan-revision:${planId}`,
      sessionId,
      title: "计划修改等待恢复",
      detail: feedback,
      risk: "medium",
      kind: "plan",
      planControlMode: "revision",
      planId,
      expectedRevision: revision,
      expectedSessionSequence: sessionSequence,
      controlEpoch,
      planOperationId: operationId,
      planFeedback: feedback,
    };
  }
  if (!pending && execution) {
    const planId = stringValue(execution.planId);
    const revision = numberValue(execution.revision, -1);
    const sessionSequence = numberValue(projection.sessionSequence, -1);
    if (!planId || revision < 0 || sessionSequence < 0) return undefined;
    return {
      id: `${graphExecution ? "graph-active" : "interrupted"}:${planId}:${controlEpoch}`,
      runId: `plan-${graphExecution ? "graph-active" : "interrupted"}:${planId}`,
      sessionId,
      title: graphExecution ? "计划执行中" : "计划执行已中断",
      detail: graphExecution
        ? "计划由 Graph 执行，等待或处理子任务结果。"
        : stringValue(execution.reason, "请选择继续执行、取消执行或重新规划。"),
      risk: graphExecution ? "low" : "medium",
      kind: "plan",
      planControlMode: graphExecution ? "graph_active" : "interrupted",
      planId,
      expectedRevision: revision,
      expectedSessionSequence: sessionSequence,
      controlEpoch,
      planOperationId: projectionOperationId,
      planSteps: recordArray(execution.steps)
        .map((step) => stringValue(step.title))
        .filter(Boolean),
    };
  }
  if (!pending) return undefined;
  const planId = stringValue(pending.planId);
  const revision = numberValue(pending.revision, -1);
  const sessionSequence = numberValue(projection.sessionSequence, -1);
  if (!planId || revision < 0 || sessionSequence < 0) return undefined;
  const steps = recordArray(pending.steps)
    .map((step) => stringValue(step.title ?? step.description))
    .filter(Boolean);
  return {
    id: `${planId}:${controlEpoch}`,
    runId: `plan-hydrate:${planId}`,
    sessionId,
    title: stringValue(pending.title, "计划等待审批"),
    detail: stringValue(pending.overview, "请审阅计划后选择下一步。"),
    risk: "high",
    kind: "plan",
    planControlMode: "review",
    planId,
    expectedRevision: revision,
    expectedSessionSequence: sessionSequence,
    controlEpoch,
    planOperationId: projectionOperationId,
    planTitle: stringValue(pending.title) || undefined,
    planOverview: stringValue(pending.overview) || undefined,
    planSteps: steps.length ? steps : undefined,
  };
}

export function approvalFromPlanControlSnapshot(
  value: RuntimePlanControlSnapshot | undefined,
  sessionId: string,
): ApprovalView | undefined {
  if (
    !value ||
    value.version !== 1 ||
    value.availability !== "ready" ||
    (value.state !== "pending_review" &&
      value.state !== "interrupted" &&
      value.state !== "committed_executing")
  ) {
    return undefined;
  }
  return approvalFromPlanProjection(value.projection, sessionId);
}

function runtimeToolResultEnvelope(value: unknown): RuntimeToolResultEnvelope | undefined {
  const exactKeys = (
    record: JsonRecord,
    required: readonly string[],
    optional: readonly string[],
  ) => {
    const allowed = new Set([...required, ...optional]);
    return (
      required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
      Object.keys(record).every((key) => allowed.has(key))
    );
  };
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        "version",
        "toolCallId",
        "toolName",
        "status",
        "rawSizeBytes",
        "sha256",
        "deliveryTruncated",
        "projection",
      ],
      ["evidence"],
    ) ||
    value.version !== 1 ||
    typeof value.toolCallId !== "string" ||
    !value.toolCallId ||
    typeof value.toolName !== "string" ||
    !value.toolName ||
    (value.status !== "succeeded" &&
      value.status !== "failed" &&
      value.status !== "rejected" &&
      value.status !== "cancelled" &&
      value.status !== "interrupted") ||
    !Number.isSafeInteger(value.rawSizeBytes) ||
    (value.rawSizeBytes as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.deliveryTruncated !== "boolean" ||
    !isRecord(value.projection) ||
    !exactKeys(value.projection, ["version", "mode", "text", "strategy", "truncated"], []) ||
    value.projection.version !== 1 ||
    (value.projection.mode !== "full" &&
      value.projection.mode !== "preview" &&
      value.projection.mode !== "synthetic") ||
    typeof value.projection.text !== "string" ||
    typeof value.projection.strategy !== "string" ||
    !value.projection.strategy ||
    typeof value.projection.truncated !== "boolean"
  ) {
    return undefined;
  }
  if (
    value.projection.mode === "synthetic" &&
    (value.status === "succeeded" || value.status === "failed")
  ) {
    return undefined;
  }
  if (value.evidence !== undefined) {
    if (
      !isRecord(value.evidence) ||
      !exactKeys(value.evidence, ["uri", "ref"], []) ||
      typeof value.evidence.uri !== "string" ||
      !isRecord(value.evidence.ref) ||
      !exactKeys(value.evidence.ref, ["schemaVersion", "contentHash", "sessionId", "kind"], []) ||
      value.evidence.ref.schemaVersion !== 2 ||
      typeof value.evidence.ref.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.evidence.ref.contentHash) ||
      typeof value.evidence.ref.sessionId !== "string" ||
      !value.evidence.ref.sessionId ||
      value.evidence.ref.kind !== "tool-exchange" ||
      value.evidence.uri !==
        `pico://evidence/${encodeURIComponent(value.evidence.ref.sessionId)}/${value.evidence.ref.contentHash}`
    ) {
      return undefined;
    }
  }
  return value as unknown as RuntimeToolResultEnvelope;
}

function progressState(value: unknown): ConversationProgressState {
  return value === "done" || value === "failed" || value === "waiting" ? value : "active";
}

function formatRunDuration(startedAt: number, finishedAt: number): string | undefined {
  if (startedAt <= 0 || finishedAt <= startedAt) return undefined;
  const seconds = Math.max(1, Math.round((finishedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
}

function structuredItemId(
  kind: "approval" | "prompt" | "changes",
  data: JsonRecord,
  fallback: string,
): string {
  const sourceId = stringValue(
    kind === "approval" ? data.approvalId : kind === "prompt" ? data.promptId : data.runId,
  );
  return sourceId ? `${kind}:${sourceId}` : fallback;
}

function conversationItem(item: JsonRecord, index: number): ConversationItemView | undefined {
  const id = stringValue(item.id, `conversation-item-${index}`);
  const at = numberValue(item.at ?? item.startedAt) || undefined;
  const meta = {
    ...(at ? { at } : {}),
    ...(item.truncated === true
      ? { truncated: true, originalBytes: numberValue(item.originalBytes) || undefined }
      : {}),
  };
  if (item.kind === "userMessage" || item.kind === "assistantMessage") {
    const text = stringValue(item.content);
    if (!text) return undefined;
    return {
      id,
      kind: item.kind,
      text,
      ...(item.kind === "assistantMessage" && stringValue(item.runId)
        ? { runId: stringValue(item.runId) }
        : {}),
      ...(item.kind === "assistantMessage" && stringValue(item.turnId)
        ? { turnId: stringValue(item.turnId) }
        : {}),
      ...meta,
    };
  }
  if (item.kind === "thinking") {
    const text = stringValue(item.content);
    if (!text) return undefined;
    return {
      id,
      kind: "thinking",
      text,
      ...(stringValue(item.runId) ? { runId: stringValue(item.runId) } : {}),
      ...(stringValue(item.turnId) ? { turnId: stringValue(item.turnId) } : {}),
      ...meta,
    };
  }
  if (item.kind === "skill") {
    return {
      id,
      kind: "skill",
      name: stringValue(item.name, "Skill"),
      args: stringValue(item.args),
      trigger: item.trigger === "model-tool" ? "model-tool" : "user-slash",
      ...meta,
    };
  }
  if (item.kind === "tool") {
    const status = item.status;
    const result = runtimeToolResultEnvelope(item.result);
    const runningData = isRecord(item.data) ? item.data : undefined;
    if (
      (status !== "running" && status !== "success" && status !== "error") ||
      (status === "running" && (!runningData || !stringValue(runningData.toolCallId))) ||
      (status === "running" && result !== undefined) ||
      (status !== "running" &&
        (!result ||
          result.toolName !== item.name ||
          (status === "success" ? result.status !== "succeeded" : result.status === "succeeded")))
    ) {
      return undefined;
    }
    return {
      id,
      kind: "tool",
      toolName: stringValue(item.name, "tool"),
      toolCallId: status === "running" ? stringValue(runningData?.toolCallId) : result?.toolCallId,
      title: stringValue(item.name, "工具调用"),
      detail: stringValue(item.args) || undefined,
      output: status === "running" ? undefined : result?.projection.text || undefined,
      state: status === "success" ? "done" : status === "error" ? "failed" : "active",
      ...(result ? { result } : {}),
      ...meta,
    };
  }
  if (item.kind === "plan") {
    return {
      id,
      kind: "plan",
      title: stringValue(item.title, "执行计划"),
      steps: [
        {
          id: `${id}:step`,
          title: stringValue(item.detail ?? item.title, "计划已更新"),
          state: progressState(item.state),
        },
      ],
      ...meta,
    };
  }
  if (item.kind === "runBoundary") {
    const status = item.status;
    if (
      status !== "queued" &&
      status !== "running" &&
      status !== "pause_requested" &&
      status !== "paused" &&
      status !== "cancelling" &&
      status !== "cancelled" &&
      status !== "failed" &&
      status !== "succeeded"
    ) {
      return undefined;
    }
    const viewStatus =
      status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "interrupted"
          : status === "succeeded"
            ? "completed"
            : "started";
    const labels = {
      started: "运行中",
      completed: "运行完成",
      interrupted: "运行已停止",
      failed: "运行失败",
    } as const;
    const duration = formatRunDuration(numberValue(item.startedAt), numberValue(item.finishedAt));
    return {
      id,
      kind: "runBoundary",
      runId: stringValue(item.runId) || undefined,
      status: viewStatus,
      label: labels[viewStatus],
      ...(duration ? { duration } : {}),
      ...(stringValue(item.error) ? { detail: stringValue(item.error) } : {}),
      ...meta,
    };
  }
  if (item.kind === "goal") {
    return {
      id,
      kind: "goal",
      title: stringValue(item.title, "当前目标"),
      detail: stringValue(item.detail) || undefined,
      state: progressState(item.state),
      ...meta,
    };
  }
  if (item.kind === "subagent") {
    return {
      id,
      kind: "subagent",
      name: stringValue(item.name, "Agent"),
      title: stringValue(item.title, "子代理活动"),
      detail: stringValue(item.detail) || undefined,
      state: subagentProgressState(item.state),
      ...subagentMetadata(isRecord(item.data) ? item.data : {}),
      ...meta,
    };
  }
  if (item.kind === "approval") {
    const data = isRecord(item.data) ? item.data : {};
    const decision = item.state;
    if (
      decision !== "waiting" &&
      decision !== "allow_once" &&
      decision !== "allow_session" &&
      decision !== "deny"
    ) {
      return undefined;
    }
    const runId = stringValue(data.runId);
    const approval =
      data.kind === "tool" && runId
        ? parseDesktopToolApproval(
            {
              approvalId: stringValue(data.approvalId),
              runId,
              request: {
                kind: data.kind,
                title: data.title,
                detail: data.detail,
                risk: data.risk,
                toolName: data.toolName,
                args: data.args,
                providerCallId: data.providerCallId,
                ...(data.command === undefined ? {} : { command: data.command }),
                ...(data.diff === undefined ? {} : { diff: data.diff }),
                ...(data.sessionScope === undefined ? {} : { sessionScope: data.sessionScope }),
              },
            },
            { runId },
          )
        : undefined;
    if (item.state === "waiting" && data.kind !== "plan" && !approval) return undefined;
    return {
      id: structuredItemId("approval", data, id),
      kind: "approval",
      runId: runId || undefined,
      approvalKind: data.kind === "plan" ? "plan" : data.kind === "tool" ? "tool" : undefined,
      command: approval?.command,
      risk: approval?.risk,
      diff: approval?.diff,
      sessionScope: approval?.sessionScope,
      toolName: approval?.toolName,
      providerCallId: approval?.providerCallId,
      title: stringValue(item.title, "需要你的批准"),
      detail: stringValue(item.detail, "Runtime 请求执行受保护操作。"),
      state:
        decision === "deny"
          ? "denied"
          : decision === "allow_once" || decision === "allow_session"
            ? "allowed"
            : "pending",
      ...meta,
    };
  }
  if (item.kind === "prompt") {
    const data = isRecord(item.data) ? item.data : {};
    const state = item.state;
    if (state !== "waiting" && state !== "answered") return undefined;
    return {
      id: structuredItemId("prompt", data, id),
      kind: "prompt",
      question: stringValue(item.title, "Pico 需要你的回答"),
      detail: stringValue(item.detail) || undefined,
      state: state === "answered" ? "answered" : "pending",
      ...meta,
    };
  }
  if (item.kind === "changes") {
    const data = isRecord(item.data) ? item.data : {};
    return {
      id: structuredItemId("changes", data, id),
      kind: "changes",
      title: stringValue(item.title, "文件已修改"),
      detail: stringValue(item.detail) || undefined,
      files: Array.isArray(data.files)
        ? data.files.map((file) => stringValue(file)).filter(Boolean)
        : [],
      state: item.state === "applied" || item.state === "conflict" ? item.state : "pending",
      ...meta,
    };
  }
  if (item.kind === "systemNotice" || item.kind === "error") {
    return {
      id,
      kind: "status",
      title: stringValue(item.content, item.kind === "error" ? "运行失败" : "状态更新"),
      tone: item.kind === "error" ? "error" : "neutral",
      ...meta,
    };
  }
  return undefined;
}

export function overlayRuntimeItem(overlay: RuntimeActiveOverlayEntry): RuntimeConversationItem {
  if (overlay.kind === "thinking") {
    return {
      id: overlay.itemId,
      kind: "thinking",
      content: overlay.text,
      runId: overlay.runId,
      turnId: overlay.turnId,
    };
  }
  if (overlay.kind === "text") {
    return {
      id: overlay.itemId,
      kind: "assistantMessage",
      content: overlay.text,
      runId: overlay.runId,
      turnId: overlay.turnId,
    };
  }
  return {
    id: overlay.itemId,
    kind: "systemNotice",
    content: overlay.stream ? `[${overlay.stream}] ${overlay.text}` : overlay.text,
  };
}

export function conversationItemsFromReplica(view: TranscriptReplicaView): ConversationItemView[] {
  return [
    ...view.records.map((record) => record.item),
    ...view.activeOverlay.map(overlayRuntimeItem),
  ]
    .map(conversationItem)
    .filter((item): item is ConversationItemView => item !== undefined);
}

export function pendingToolApprovalFromTranscript(
  items: readonly ConversationItemView[],
  activeRunId?: string,
): Extract<ConversationItemView, { readonly kind: "approval" }> | undefined {
  // Plan controls come from the current projection, never from historical handoff cards.
  // A new active run must never lend its identity to an old unresolved receipt.
  // Unknown legacy identities cannot authorize a card for an explicit live run.
  const boundaryIndex = items.findLastIndex(
    (item) => item.kind === "userMessage" || item.kind === "runBoundary",
  );
  const terminalRunIds = new Set(
    items.flatMap((item) =>
      item.kind === "runBoundary" && item.status !== "started" && item.runId ? [item.runId] : [],
    ),
  );
  return items.findLast(
    (item, index): item is Extract<ConversationItemView, { readonly kind: "approval" }> =>
      (activeRunId !== undefined || index > boundaryIndex) &&
      item.kind === "approval" &&
      (activeRunId === undefined || item.runId === activeRunId) &&
      !terminalRunIds.has(item.runId ?? "") &&
      item.approvalKind !== "plan" &&
      item.state === "pending" &&
      item.id.startsWith("approval:"),
  );
}

function isTranscriptPageCursor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const cursor = value as Record<string, unknown>;
  return (
    Object.keys(cursor).length === 6 &&
    typeof cursor.historyEpoch === "string" &&
    Boolean(cursor.historyEpoch) &&
    cursor.projectorVersion === TRANSCRIPT_PROJECTOR_VERSION &&
    Number.isSafeInteger(cursor.throughSequence) &&
    (cursor.throughSequence as number) >= 0 &&
    Number.isSafeInteger(cursor.positionSequence) &&
    (cursor.positionSequence as number) >= 0 &&
    Number.isSafeInteger(cursor.positionOrdinal) &&
    (cursor.positionOrdinal as number) >= 0 &&
    Number.isSafeInteger(cursor.byteOffset) &&
    (cursor.byteOffset as number) >= 0
  );
}

export function parseConversation(
  value: unknown,
  workspacePath: string,
  sessionId: string,
): ConversationView {
  const result = isRecord(value) ? value : {};
  return {
    workspacePath,
    sessionId,
    items: recordArray(result.items)
      .map(conversationItem)
      .filter((item): item is ConversationItemView => item !== undefined),
    hasEarlier: isTranscriptPageCursor(result.nextCursor),
    queuedCount: recordArray(result.queuedInputs).length,
    discoveryItem: discoveryItemFromProjection(result.discoveryProjection),
  };
}

function discoveryItemFromProjection(value: unknown): ConversationItemView | undefined {
  const projection = isRecord(value) ? value : undefined;
  const latest = projection && isRecord(projection.latest) ? projection.latest : undefined;
  if (!latest) return undefined;
  const discoveryId = stringValue(latest.discoveryId);
  const depth = latest.depth;
  const phase = latest.phase;
  const status = latest.status;
  if (
    !discoveryId ||
    (depth !== "quick" && depth !== "balanced" && depth !== "deep") ||
    (phase !== "forage" && phase !== "focus" && phase !== "deepen" && phase !== "verify") ||
    (status !== "active" &&
      status !== "interrupted" &&
      status !== "completed" &&
      status !== "cancelled")
  ) {
    return undefined;
  }
  return {
    id: `discovery:${discoveryId}`,
    kind: "discovery",
    discoveryId,
    objective: stringValue(latest.objective, "代码库探索"),
    depth,
    phase,
    status,
    inspectedFiles: recordArray(latest.inspectedFiles).length,
    evidenceCount: recordArray(latest.evidenceRefs).length,
    openQuestions: recordArray(latest.openQuestions).length,
    reason: stringValue(latest.reason) || undefined,
  };
}

// 终态判定经 @pico/protocol isTerminalRunStatus（wire 归一化唯一来源；本地
// 版曾含非枚举值 "completed"——拷贝漂移）。

function interactionSessionId(
  data: AppData,
  workspacePath: string,
  explicitSessionId: string,
  runId: string,
): string | undefined {
  if (explicitSessionId) return explicitSessionId;
  return data.runs.find((run) => run.workspacePath === workspacePath && run.id === runId)
    ?.sessionId;
}

export function resolveApprovalState(
  current: AppData,
  input: {
    readonly approvalId: string;
    readonly decision: string;
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly runId: string;
  },
): AppData {
  const pending = current.approvals.find((approval) => approval.id === input.approvalId);
  const sessionId = interactionSessionId(
    current,
    input.workspacePath,
    input.sessionId,
    input.runId || pending?.runId || "",
  );
  const conversationKey = sessionId
    ? workspaceSessionKey({ workspacePath: input.workspacePath, sessionId })
    : undefined;
  const conversation = conversationKey ? current.conversations[conversationKey] : undefined;
  const state: "allowed" | "denied" = input.decision === "deny" ? "denied" : "allowed";

  if (!sessionId || !conversationKey || !conversation) {
    return {
      ...current,
      approvals: current.approvals.filter((approval) => approval.id !== input.approvalId),
    };
  }

  const stableKey = `approval:${input.approvalId}`;
  let found = false;
  const items = conversation.items.map((item) => {
    if (item.kind !== "approval" || conversationItemKey(item) !== stableKey) return item;
    found = true;
    return { ...item, id: stableKey, state };
  });
  const resolvedItems =
    found || !pending
      ? items
      : [
          ...items,
          {
            id: stableKey,
            kind: "approval" as const,
            title: pending.title,
            detail: pending.detail,
            state,
          },
        ];

  return {
    ...current,
    approvals: current.approvals.filter((approval) => approval.id !== input.approvalId),
    conversations: {
      ...current.conversations,
      [conversationKey]: { ...conversation, items: resolvedItems },
    },
  };
}

export function resolvePromptState(
  current: AppData,
  input: {
    readonly promptId: string;
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly runId: string;
  },
): AppData {
  const pending = current.prompts.find((prompt) => prompt.id === input.promptId);
  const sessionId = interactionSessionId(
    current,
    input.workspacePath,
    input.sessionId,
    input.runId || pending?.runId || "",
  );
  const conversationKey = sessionId
    ? workspaceSessionKey({ workspacePath: input.workspacePath, sessionId })
    : undefined;
  const conversation = conversationKey ? current.conversations[conversationKey] : undefined;

  if (!sessionId || !conversationKey || !conversation) {
    return {
      ...current,
      prompts: current.prompts.filter((prompt) => prompt.id !== input.promptId),
    };
  }

  const stableKey = `prompt:${input.promptId}`;
  let found = false;
  const items = conversation.items.map((item) => {
    if (item.kind !== "prompt" || conversationItemKey(item) !== stableKey) return item;
    found = true;
    return { ...item, id: stableKey, state: "answered" as const };
  });
  const resolvedItems =
    found || !pending
      ? items
      : [
          ...items,
          {
            id: stableKey,
            kind: "prompt" as const,
            question: pending.question,
            state: "answered" as const,
          },
        ];

  return {
    ...current,
    prompts: current.prompts.filter((prompt) => prompt.id !== input.promptId),
    conversations: {
      ...current.conversations,
      [conversationKey]: { ...conversation, items: resolvedItems },
    },
  };
}

export function parseGoalItem(value: unknown): ConversationItemView | undefined {
  const result = isRecord(value) ? value : {};
  const snapshot = isRecord(result.goal) ? result.goal : undefined;
  if (!snapshot) return undefined;
  const activeGoalId = stringValue(snapshot.activeGoalId);
  const goal = recordArray(snapshot.goals).find(
    (candidate) => stringValue(candidate.id) === activeGoalId,
  );
  if (!goal) return undefined;
  const status = stringValue(goal.status);
  return {
    id: `goal:${activeGoalId}`,
    kind: "goal",
    title: stringValue(goal.title, "当前目标"),
    detail: stringValue(goal.progress ?? goal.description) || undefined,
    state:
      status === "complete"
        ? "done"
        : status === "blocked"
          ? "failed"
          : status === "paused"
            ? "waiting"
            : "active",
  };
}
