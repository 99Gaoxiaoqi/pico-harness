import { parseDesktopToolApproval } from "../runtime-projections/approval.js";
import { subagentMetadata } from "./subagent-navigation.js";
import {
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

export type RuntimeTranscriptCursor = {
  readonly revision: string;
  readonly throughTranscriptSequence: number;
  readonly position: number;
  readonly ordinal: number;
  readonly byteOffset: number;
  readonly direction: "older" | "newer";
};

export type RuntimeTranscriptFragment = {
  readonly itemId: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly totalBytes: number;
  readonly json: string;
};

export function approvalFromPlanProjection(
  value: unknown,
  sessionId: string,
): ApprovalView | undefined {
  const projection = isRecord(value) ? value : undefined;
  const controlEpoch = projection ? stringValue(projection.controlEpoch) : "";
  const pending =
    projection && isRecord(projection.pendingProposal) ? projection.pendingProposal : undefined;
  const execution = projection && isRecord(projection.execution) ? projection.execution : undefined;
  const revisionRequest =
    projection && isRecord(projection.revisionRequest) ? projection.revisionRequest : undefined;
  const graphExecution = execution?.status === "active" && isRecord(execution.graph);
  if (
    !projection ||
    !controlEpoch ||
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
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.status !== "string" ||
    typeof value.rawSizeBytes !== "number" ||
    typeof value.sha256 !== "string" ||
    typeof value.deliveryTruncated !== "boolean" ||
    !isRecord(value.projection) ||
    value.projection.version !== 1 ||
    typeof value.projection.mode !== "string" ||
    typeof value.projection.text !== "string" ||
    typeof value.projection.strategy !== "string" ||
    typeof value.projection.truncated !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as RuntimeToolResultEnvelope;
}

export function toolEvidencePage(value: unknown, expectedUri: string): ToolEvidencePage {
  if (
    !isRecord(value) ||
    value.evidenceUri !== expectedUri ||
    typeof value.content !== "string" ||
    typeof value.offsetBytes !== "number" ||
    typeof value.endOffsetBytes !== "number" ||
    typeof value.totalBytes !== "number" ||
    typeof value.truncated !== "boolean" ||
    (value.nextOffsetBytes !== undefined && typeof value.nextOffsetBytes !== "number")
  ) {
    throw new Error("Evidence 分页响应格式无效");
  }
  return {
    evidenceUri: expectedUri,
    content: value.content,
    offsetBytes: value.offsetBytes,
    endOffsetBytes: value.endOffsetBytes,
    totalBytes: value.totalBytes,
    truncated: value.truncated,
    ...(typeof value.nextOffsetBytes === "number"
      ? { nextOffsetBytes: value.nextOffsetBytes }
      : {}),
  };
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
    const result = runtimeToolResultEnvelope(item.result);
    return {
      id,
      kind: "tool",
      toolName: stringValue(item.name, "tool"),
      toolCallId: stringValue(item.providerCallId) || undefined,
      title: stringValue(item.name, "工具调用"),
      detail: stringValue(item.args) || undefined,
      output: result?.projection.text || stringValue(item.summary) || undefined,
      state: item.status === "success" ? "done" : item.status === "error" ? "failed" : "active",
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
    const status = stringValue(item.status);
    const viewStatus =
      status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "interrupted"
          : status === "succeeded" || status === "completed"
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
      ...(stringValue(item.detail ?? item.error)
        ? { detail: stringValue(item.detail ?? item.error) }
        : {}),
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
      ...subagentMetadata(isRecord(item.data) ? item.data : {}, id),
      ...meta,
    };
  }
  if (item.kind === "approval") {
    const data = isRecord(item.data) ? item.data : {};
    const decision = stringValue(data.decision ?? item.state);
    const approval = parseDesktopToolApproval({
      approvalId: stringValue(data.approvalId, id),
      request: data,
    });
    return {
      id: structuredItemId("approval", data, id),
      kind: "approval",
      runId: stringValue(data.runId) || undefined,
      approvalKind: data.kind === "plan" || data.planId || data.plan ? "plan" : "tool",
      command: approval?.command,
      risk: approval?.risk,
      diff: approval?.diff,
      sessionScope: approval?.sessionScope,
      toolName: approval?.toolName,
      providerCallId: approval?.providerCallId,
      title: stringValue(item.title, "需要你的批准"),
      detail: stringValue(item.detail, "Runtime 请求执行受保护操作。"),
      state:
        decision === "deny" || decision === "denied"
          ? "denied"
          : decision === "allow_once" || decision === "allow_session" || decision === "allowed"
            ? "allowed"
            : "pending",
      ...meta,
    };
  }
  if (item.kind === "prompt") {
    const data = isRecord(item.data) ? item.data : {};
    const state = stringValue(item.state);
    return {
      id: structuredItemId("prompt", data, id),
      kind: "prompt",
      question: stringValue(item.title, "Pico 需要你的回答"),
      detail: stringValue(item.detail) || undefined,
      state: state === "answered" || state === "resolved" ? "answered" : "pending",
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

interface ParsedConversation extends ConversationView {
  readonly nextCursor?: RuntimeTranscriptCursor;
}

function transcriptCursor(value: unknown): RuntimeTranscriptCursor | undefined {
  if (!isRecord(value)) return undefined;
  const cursor = value as Record<string, unknown>;
  if (
    Object.keys(cursor).length !== 6 ||
    typeof cursor.revision !== "string" ||
    !cursor.revision ||
    !Number.isSafeInteger(cursor.throughTranscriptSequence) ||
    (cursor.throughTranscriptSequence as number) < 1 ||
    !Number.isSafeInteger(cursor.position) ||
    (cursor.position as number) < 0 ||
    !Number.isSafeInteger(cursor.ordinal) ||
    (cursor.ordinal as number) < 0 ||
    !Number.isSafeInteger(cursor.byteOffset) ||
    (cursor.byteOffset as number) < 0 ||
    (cursor.direction !== "older" && cursor.direction !== "newer")
  ) {
    return undefined;
  }
  return cursor as RuntimeTranscriptCursor;
}

export function parseConversation(
  value: unknown,
  workspacePath: string,
  sessionId: string,
  fragmentParts?: Map<string, RuntimeTranscriptFragment[]>,
): ParsedConversation {
  const result = isRecord(value) ? value : {};
  const nextCursor = transcriptCursor(result.nextCursor);
  const nextBefore = stringValue(result.nextBefore) || undefined;
  return {
    workspacePath,
    sessionId,
    items: [
      ...assembleConversationFragments(result.fragments, fragmentParts),
      ...recordArray(result.items),
    ]
      .map(conversationItem)
      .filter((item): item is ConversationItemView => item !== undefined),
    revision: stringValue(result.revision) || undefined,
    // ConversationView keeps the legacy field as the UI's "has earlier" flag.
    // The request path below uses the structured cursor whenever it is present.
    nextBefore: nextBefore ?? (nextCursor ? "structured-cursor" : undefined),
    ...(nextCursor ? { nextCursor } : {}),
    queuedCount: recordArray(result.queuedInputs).length,
    discoveryItem: discoveryItemFromProjection(result.discoveryProjection),
  };
}

export function assembleConversationFragments(
  value: unknown,
  fragmentParts: Map<string, RuntimeTranscriptFragment[]> | undefined,
): JsonRecord[] {
  if (!fragmentParts) return [];
  const completed: JsonRecord[] = [];
  for (const candidate of recordArray(value)) {
    const itemId = stringValue(candidate.itemId);
    const json = stringValue(candidate.json);
    const byteOffset = numberValue(candidate.byteOffset);
    const byteLength = numberValue(candidate.byteLength);
    const totalBytes = numberValue(candidate.totalBytes);
    if (!itemId || !json || byteOffset < 0 || byteLength < 1 || totalBytes < 1) continue;
    const fragment = { itemId, json, byteOffset, byteLength, totalBytes };
    if (
      byteLength !== new TextEncoder().encode(json).byteLength ||
      byteOffset + byteLength > totalBytes
    ) {
      throw new Error("Session transcript fragment byte range is invalid");
    }
    const prior = fragmentParts.get(itemId) ?? [];
    for (const part of prior) {
      if (part.totalBytes !== totalBytes) {
        throw new Error("Session transcript fragments disagree on total bytes");
      }
      const sameRange = part.byteOffset === byteOffset && part.byteLength === byteLength;
      if (sameRange && part.json !== json) {
        throw new Error("Session transcript fragments disagree on range content");
      }
      const overlaps =
        part.byteOffset < byteOffset + byteLength && byteOffset < part.byteOffset + part.byteLength;
      if (overlaps && !sameRange) {
        throw new Error("Session transcript fragment ranges overlap");
      }
    }
    const duplicate = prior.some(
      (part) => part.byteOffset === byteOffset && part.byteLength === byteLength,
    );
    const parts = [...prior, ...(duplicate ? [] : [fragment])].toSorted(
      (left, right) => left.byteOffset - right.byteOffset,
    );
    fragmentParts.set(itemId, parts);
    let offset = 0;
    for (const part of parts) {
      if (part.byteOffset !== offset) break;
      offset += part.byteLength;
    }
    if (offset !== totalBytes) continue;
    const parsed: unknown = JSON.parse(parts.map((part) => part.json).join(""));
    if (!isRecord(parsed) || parsed.id !== itemId) continue;
    completed.push(parsed);
    fragmentParts.delete(itemId);
  }
  return completed;
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
  const state: "allowed" | "denied" =
    input.decision === "deny" || input.decision === "denied" ? "denied" : "allowed";

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

export interface ToolEvidencePage {
  readonly evidenceUri: string;
  readonly content: string;
  readonly offsetBytes: number;
  readonly endOffsetBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly nextOffsetBytes?: number;
}
