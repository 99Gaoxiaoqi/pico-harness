import type { Message } from "../schema/message.js";
import { createToolResultEnvelope, type ToolResultEnvelope } from "./tool-result-contract.js";
import type {
  RuntimeEvent,
  RuntimeMessageCommittedEvent,
  RuntimeToolResultRecordedEvent,
} from "./session-runtime-event.js";

export type RuntimeModelHistoryEvent =
  | RuntimeMessageCommittedEvent
  | RuntimeToolResultRecordedEvent;

export function runtimeEventHasModelHistoryEntry(
  event: RuntimeEvent,
): event is RuntimeModelHistoryEvent {
  return (
    (event.kind === "message.committed" || event.kind === "tool.result.recorded") &&
    event.visibility === "model" &&
    !event.partial
  );
}

/**
 * Claim coverage 契约：每个事件 kind 必须显式标注它在投影里如何被 claim。
 * 参考 maka 的 claim coverage 不变量——reader 可见的 kind 落空时要么是
 * unclaimed_control_fact（soft），要么是 unsupported_event_kind（hard）。
 *
 * - "message"：产出行（message.committed / tool.result.recorded）
 * - "control"：控制事实，无 chat 行，正常（产 soft 诊断）
 * - undefined：未知 kind（纵深防御——解码层已拦截 unknown_kind，但投影层再防一道）
 */
export type RuntimeEventClaimKind = "message" | "control";

const CLAIM_BY_KIND: Record<RuntimeEvent["kind"], RuntimeEventClaimKind> = {
  "run.started": "control",
  "message.committed": "message",
  "tool.started": "control",
  "tool.group.loaded": "control",
  "tool.result.recorded": "message",
  "approval.requested": "control",
  "approval.settled": "control",
  "model.call.started": "control",
  "model.call.settled": "control",
  "context.checkpoint.recorded": "control",
  "history.rewound": "control",
  "session.forked": "control",
  "session.state.committed": "control",
  "transcript.event.recorded": "control",
  "run.terminal": "control",
  // Plan 生命周期事件（12 种全部覆盖）
  "plan.proposed": "control",
  "plan.revised": "control",
  "plan.revision.requested": "control",
  "plan.approved": "control",
  "plan.rejected": "control",
  "plan.execution.started": "control",
  "plan.step.updated": "control",
  "plan.step.recovered": "control",
  "plan.execution.completed": "control",
  "plan.execution.cancelled": "control",
  "plan.execution.interrupted": "control",
  "plan.execution.resumed": "control",
  "plan.execution.replanned": "control",
  // Graph Mode 事件（5 种全部覆盖）
  "graph.work.added": "control",
  "graph.work.dispatched": "control",
  "graph.work.recorded": "control",
  "graph.work.failed": "control",
  "graph.closed": "control",
};

export function claimKindForEvent(event: RuntimeEvent): RuntimeEventClaimKind | undefined {
  return CLAIM_BY_KIND[event.kind];
}

/**
 * The single projection from durable model-visible facts to provider Messages.
 * Callers must never reconstruct a tool-result Message independently.
 */
export function projectRuntimeModelMessage(event: RuntimeEvent): Message | undefined {
  if (!runtimeEventHasModelHistoryEntry(event)) return undefined;
  if (event.kind === "message.committed") {
    if (event.data.message.toolCallId !== undefined) {
      throw new Error(`Runtime message.committed ${event.eventId} cannot contain a ToolResult`);
    }
    return structuredClone(event.data.message);
  }
  return projectRuntimeToolResultMessage(event);
}

/** Shared projection for model-visible and transcript-only structured ToolResult facts. */
export function projectRuntimeToolResultMessage(event: RuntimeToolResultRecordedEvent): Message {
  const evidence = event.refs.evidence;
  const evidenceUri = evidence
    ? `pico://evidence/${encodeURIComponent(evidence.sessionId)}/${evidence.contentHash}`
    : undefined;
  const content =
    event.data.body.storage === "evidence" && evidence && evidenceUri
      ? renderEvidenceProjection(event, evidenceUri)
      : event.data.projection.text;
  return {
    role: "user",
    content,
    toolCallId: event.refs.toolCallId,
    ...(evidenceUri ? { toolResultEvidenceUri: evidenceUri } : {}),
  };
}

/** Shared bounded host projection derived directly from the canonical fact. */
export function projectRuntimeToolResultEnvelope(
  event: RuntimeToolResultRecordedEvent,
): ToolResultEnvelope {
  return createToolResultEnvelope({
    toolCallId: event.refs.toolCallId,
    toolName: event.data.toolName,
    status: event.data.status,
    body: event.data.body,
    projection: event.data.projection,
    ...(event.refs.evidence ? { evidence: event.refs.evidence } : {}),
  });
}

/**
 * 旧账本 `storage:"evidence"` 事件的只读投影(ADR 26 §2.5):decode 容忍、
 * 预览仍在,但回读协议已退役——投影明示"不可回读",不再指引模型调用
 * 已不存在的 read_evidence。
 */
function renderEvidenceProjection(
  event: RuntimeToolResultRecordedEvent,
  evidenceUri: string,
): string {
  const metadata = [
    `工具: ${event.data.toolName}`,
    `状态: ${event.data.status}`,
    `原始输出: ${event.data.body.sizeBytes} bytes`,
    `SHA-256: ${event.data.body.sha256}`,
    `Evidence: ${evidenceUri}`,
    "Evidence 回读协议已退役(ADR 26):完整原文不可回读,以下仅为入库预览。",
  ].join("\n");
  return event.data.projection.text
    ? `${metadata}\n\n预览:\n${event.data.projection.text}`
    : metadata;
}
