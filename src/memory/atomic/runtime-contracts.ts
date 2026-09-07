import type { Message, ToolDefinition } from "../../schema/message.js";
import type { MemoryItemRecord, MemoryItemStore, MemoryExtractionReceipt } from "./contracts.js";

/** Host identity, never an LLM-selected session identifier. */
export function memorySessionKey(workspaceKey: string, sessionId: string): string {
  return JSON.stringify([workspaceKey, sessionId]);
}

export interface MemoryEvidenceEvent {
  readonly ordinal: number;
  readonly eventId: string;
  readonly runId: string;
  readonly turnId: string;
  /** Timestamp from the committed RuntimeEvent, in epoch milliseconds. */
  readonly observedAt: number;
  readonly role: "user" | "assistant" | "other";
  readonly text: string;
}

export interface MemoryCheckpointBoundary {
  readonly checkpointId: string;
  readonly ordinal: number;
  readonly throughOrdinal: number;
  readonly coverageHash?: string;
  /** Old checkpoints without recoverable memory coverage may bootstrap a new cursor. */
  readonly bootstrap?: boolean;
  readonly disposition?: "eligible" | "policy_denied";
}

export interface MemoryExtractionSnapshot {
  /** Captured before queuing, never refreshed for an existing task. */
  readonly deletionRevision: number;
  readonly trigger: "remember" | "extract" | "compaction";
  /** Composite workspace/session identity used by cursors and provenance. */
  readonly sessionId: string;
  readonly workspaceKey: string;
  readonly runId: string;
  readonly turnId: string;
  readonly boundaryOrdinal: number;
  readonly boundaryEventId: string;
  readonly events: readonly MemoryEvidenceEvent[];
  readonly sourceMessages?: readonly Message[];
  readonly sourceTools?: readonly ToolDefinition[];
  readonly sourceEventMessagePositions?: Readonly<Record<string, readonly number[]>>;
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly checkpoints?: readonly MemoryCheckpointBoundary[];
  readonly compactionCheckpointId?: string;
  readonly signal?: AbortSignal;
}

export interface MemoryModelRequest {
  readonly stage: "proposal" | "localized" | "canonicalize";
  readonly prompt: string;
  readonly sourceMessages?: readonly Message[];
  readonly sourceTools?: readonly ToolDefinition[];
  readonly signal?: AbortSignal;
}

export interface MemoryExtractionModel {
  call(request: MemoryModelRequest): Promise<string>;
}

export type MemoryGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface AtomicMemorySettings {
  readonly workspaceKey: string;
  readonly enabled: boolean;
  readonly autoExtract: boolean;
  readonly recallEnabled: boolean;
  readonly version: number;
}

/** Workspace management and extraction invalidation. */
export interface AtomicMemoryStore extends MemoryItemStore {
  close(): void;
  listItems(input: {
    readonly workspaceKey: string;
    readonly includeArchived?: boolean;
    readonly limit?: number;
  }): Promise<readonly MemoryItemRecord[]>;
  readSettings(workspaceKey: string): Promise<AtomicMemorySettings>;
  updateSettings(input: {
    readonly workspaceKey: string;
    readonly expectedVersion: number;
    readonly enabled?: boolean;
    readonly autoExtract?: boolean;
    readonly recallEnabled?: boolean;
  }): Promise<AtomicMemorySettings>;
  deleteItem(input: {
    readonly itemId: string;
    readonly expectedVersion: number;
    readonly operationId: string;
  }): Promise<void>;
  readDeletionRevision(): Promise<number>;
}

export interface AtomicMemoryEngineOptions {
  readonly store: AtomicMemoryStore;
  readonly model: MemoryExtractionModel;
  readonly gate: (trigger: MemoryExtractionSnapshot["trigger"]) => Promise<MemoryGateResult>;
}

export type AtomicMemoryResult =
  | MemoryExtractionReceipt
  | {
      readonly status: "unavailable";
      readonly reason?: string;
      readonly requestedItems: readonly [];
    };
