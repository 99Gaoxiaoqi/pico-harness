import type { ForegroundProcessFacts, RuntimeToolResultStatus } from "@pico/core";

export interface GoalEvidenceRunAnchor {
  readonly eventId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly invocationId: string;
  readonly status?: string;
}

/** Narrow read DTO: excerpts are never represented as canonical, hash-validated events. */
export interface GoalEvidenceTool {
  readonly eventId: string;
  readonly sequence: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: RuntimeToolResultStatus;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly projectionMode: "full" | "preview" | "synthetic";
  readonly executionFacts?: ForegroundProcessFacts;
  readonly recoveryClassification?: "indeterminate" | "not_dispatched";
  readonly start?: {
    readonly eventId: string;
    readonly sequence: number;
    readonly argumentsJson: string;
    readonly argumentsTruncated: boolean;
  };
}

export interface GoalEvidenceMessage {
  readonly eventId: string;
  readonly sequence: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export interface GoalEvidenceRunSlice {
  readonly throughSequence: number;
  readonly identity: {
    readonly started?: GoalEvidenceRunAnchor;
    readonly terminal?: GoalEvidenceRunAnchor;
  };
  readonly tools: readonly GoalEvidenceTool[];
  readonly messages: readonly GoalEvidenceMessage[];
  readonly finalReply?: GoalEvidenceMessage;
  readonly toolResultCount: number;
  readonly messageCount: number;
  readonly incompleteToolCallCount: number;
  readonly latestPotentialMutationSequence?: number;
  readonly potentialMutationCount: number;
  readonly potentialMutations: readonly {
    readonly eventId: string;
    readonly sequence: number;
    readonly toolName: string;
  }[];
}
