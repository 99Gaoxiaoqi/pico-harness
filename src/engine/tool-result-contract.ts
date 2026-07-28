export type RuntimeToolResultStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"
  | "interrupted";

export interface RuntimeEvidenceReference {
  readonly schemaVersion: 2;
  readonly contentHash: string;
  readonly sessionId: string;
  readonly kind: "tool-exchange";
}

export type RuntimeToolResultBody =
  | {
      readonly storage: "inline";
      readonly content: string;
      readonly sha256: string;
      readonly sizeBytes: number;
    }
  | {
      readonly storage: "evidence";
      readonly sha256: string;
      readonly sizeBytes: number;
    };

export interface RuntimeToolResultProjection {
  readonly version: 1;
  readonly mode: "full" | "preview" | "synthetic";
  readonly text: string;
  readonly strategy: string;
  readonly truncated: boolean;
}

/**
 * ToolResult 的唯一宿主投影。
 *
 * 原始正文只存在于 canonical body / Evidence；Reporter、Hook 与 UI 只能接收
 * 这份有界投影，避免各宿主重新从 Message 文本猜测大小、状态或回读位置。
 */
export interface ToolResultEnvelope {
  readonly version: 1;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: RuntimeToolResultStatus;
  readonly rawSizeBytes: number;
  readonly sha256: string;
  readonly projection: RuntimeToolResultProjection;
  /** canonical projection 到宿主边界是否又受 16 KiB UTF-8 上限约束。 */
  readonly deliveryTruncated: boolean;
  readonly evidence?: {
    readonly uri: string;
    readonly ref: RuntimeEvidenceReference;
  };
}

export interface ToolResultEnvelopeInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: RuntimeToolResultStatus;
  readonly body: RuntimeToolResultBody;
  readonly projection: RuntimeToolResultProjection;
  readonly evidence?: RuntimeEvidenceReference;
}

export const MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES = 16 * 1024;

export function createToolResultEnvelope(input: ToolResultEnvelopeInput): ToolResultEnvelope {
  const evidence = input.evidence;
  const projectionText = sliceUtf8Bytes(input.projection.text, MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES);
  return {
    version: 1,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    rawSizeBytes: input.body.sizeBytes,
    sha256: input.body.sha256,
    projection: {
      ...structuredClone(input.projection),
      text: projectionText,
    },
    deliveryTruncated: projectionText !== input.projection.text,
    ...(evidence
      ? {
          evidence: {
            uri: `pico://evidence/${encodeURIComponent(evidence.sessionId)}/${evidence.contentHash}`,
            ref: structuredClone(evidence),
          },
        }
      : {}),
  };
}

function sliceUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const symbol of value) {
    const symbolBytes = Buffer.byteLength(symbol, "utf8");
    if (bytes + symbolBytes > maxBytes) break;
    bytes += symbolBytes;
    end += symbol.length;
  }
  return value.slice(0, end);
}
