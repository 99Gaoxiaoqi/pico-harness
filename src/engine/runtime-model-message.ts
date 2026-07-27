import { PICO_TOOL_RESULT_ERROR_KEY, type Message } from "../schema/message.js";
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
    return structuredClone(event.data.message);
  }

  const synthetic = event.data.projection.mode === "synthetic";
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
    providerData: {
      [PICO_TOOL_RESULT_ERROR_KEY]: event.data.status !== "succeeded",
      picoToolResultToolName: event.data.toolName,
      picoToolResultStatus: event.data.status,
      picoToolResultSha256: event.data.body.sha256,
      picoToolResultSizeBytes: event.data.body.sizeBytes,
      ...(evidence
        ? {
            picoToolResultEvidence: structuredClone(evidence),
            picoToolResultEvidenceUri: evidenceUri,
          }
        : {}),
      ...(synthetic
        ? {
            picoKind: "synthetic_tool_result",
          }
        : {}),
    },
  };
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
