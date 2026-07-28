export type RuntimeToolResultStatus =
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"
  | "interrupted";

export interface RuntimeEvidenceReference {
  readonly schemaVersion: 1;
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

export function createToolResultEnvelope(input: ToolResultEnvelopeInput): ToolResultEnvelope {
  const evidence = input.evidence;
  return {
    version: 1,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    status: input.status,
    rawSizeBytes: input.body.sizeBytes,
    sha256: input.body.sha256,
    projection: structuredClone(input.projection),
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
