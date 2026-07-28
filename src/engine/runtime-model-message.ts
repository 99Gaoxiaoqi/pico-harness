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
    `需要完整原文时调用 read_evidence(ref="${evidenceUri}", offsetBytes?, limitBytes?)。`,
  ].join("\n");
  return event.data.projection.text
    ? `${metadata}\n\n预览:\n${event.data.projection.text}`
    : metadata;
}
