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

export interface ToolResultEnvelope {
  readonly version: 1;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: RuntimeToolResultStatus;
  readonly rawSizeBytes: number;
  readonly sha256: string;
  readonly projection: RuntimeToolResultProjection;
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

const utf8Encoder = new TextEncoder();

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
  if (utf8Encoder.encode(value).byteLength <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const symbol of value) {
    const symbolBytes = utf8Encoder.encode(symbol).byteLength;
    if (bytes + symbolBytes > maxBytes) break;
    bytes += symbolBytes;
    end += symbol.length;
  }
  return value.slice(0, end);
}
