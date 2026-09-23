import type { ToolCall, ToolRecoveryMode, ToolResult, ToolResultEnvelope } from "@pico/core";

export type ToolOutputStream = "stdout" | "stderr";

export interface ToolOutputChunk {
  readonly stream: ToolOutputStream;
  readonly chunk: string;
}

export interface ToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly onOutput?: (output: ToolOutputChunk) => void;
  readonly toolCallId?: string;
  readonly step?: ToolExecutionStep;
  readonly origin?: "model" | "code_mode";
  readonly parentToolCallId?: string;
  readonly recoveryPolicy?: ToolRecoveryPolicy;
  readonly argumentRedactionSecrets?: readonly string[];
  readonly beforeDispatch?: (call: ToolCall) => Promise<void>;
  readonly sanitizeResult?: (result: ToolResult) => ToolResult;
  readonly onCommittedResult?: (call: ToolCall, envelope: ToolResultEnvelope) => Promise<void>;
}

export interface ToolRecoveryProbeInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly argumentsRedacted: boolean;
  readonly signal?: AbortSignal;
}

export type ToolRecoveryProbeResult =
  | { readonly outcome: "park"; readonly reason: string }
  | {
      readonly outcome: "effects_verified" | "not_dispatched_verified";
      readonly evidenceUri: string;
      readonly summary: string;
    };

export interface ToolRecoveryPolicy {
  readonly mode: ToolRecoveryMode;
  readonly key?: string;
  readonly reconcile?: (input: ToolRecoveryProbeInput) => Promise<ToolRecoveryProbeResult>;
}

export interface ToolExecutionStep {
  readonly id: string;
  readonly visibleToolNames: ReadonlySet<string>;
}

/** Commit failures must escape ordinary tool-error conversion. */
export class ToolCommitBoundaryError extends Error {
  constructor(
    readonly phase: "T1" | "T2",
    cause: unknown,
  ) {
    super(
      `Tool ${phase} commit failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
    this.name = "ToolCommitBoundaryError";
  }
}

/** Narrow tool-dispatch surface required by the durable RuntimeRun coordinator. */
export interface RuntimeToolRegistry {
  isToolResultArchiveReader?(name: string): boolean;
  captureStep?(
    id: string,
    visibleToolNames: readonly string[],
    boundStep?: ToolExecutionStep,
  ): ToolExecutionStep;
  getRecoveryPolicy?(name: string, step?: ToolExecutionStep): ToolRecoveryPolicy;
  execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult>;
}

export type { ToolRecoveryMode } from "@pico/core";
