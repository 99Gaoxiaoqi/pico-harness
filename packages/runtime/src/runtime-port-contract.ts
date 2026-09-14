import type {
  CanonicalTranscriptToolStart,
  CommitReceipt,
  Message,
  ToolCall,
  ToolResult,
  ToolResultEnvelopeInput,
} from "@pico/core";
import type {
  RuntimePartialSegment,
  RuntimePartialSnapshot,
  RuntimeRunPartials,
} from "@pico/storage";
import type { EngineRuntimeCapability, EngineRuntimeWriteGuard } from "./runtime-capability.js";

/** A single immutable-model-history entry projected from the durable ledger. */
export interface RuntimeHistoryEntry {
  /** False when this model prefix is not also an immutable source prefix. */
  readonly compactionBoundarySafe?: boolean;
  readonly eventId: string;
  readonly message: Message;
}

/** Stable payload accepted by the durable tool-result registration boundary. */
export type RuntimeToolResultInput = ToolResultEnvelopeInput;

export interface RuntimeCheckpointInput {
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
  readonly throughEventId: string;
  readonly memoryExtractionBoundary?: {
    readonly runtimeEventId: string;
    readonly disposition: "eligible" | "policy_denied";
  };
  readonly summary: Message;
  /** 滚动摘要链:上一个 checkpoint 的 id(若存在)。 */
  readonly previousCheckpointId?: string;
}

/** Last compaction checkpoint data used as the base of the next incremental summary. */
export interface RuntimeLastCompactionCheckpoint {
  readonly checkpointId: string;
  readonly summaryText: string;
}

/**
 * Runtime's durable-run surface, parameterized by the outer Engine's Session
 * and tool registry types. Runtime owns ledger semantics; callers own the
 * concrete Session and physical tool dispatch.
 */
export interface RuntimeRunPort<Session, Registry, ToolContext, RecoveryProbeResult> {
  readonly runId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly runtimeEventWriteGuard?: EngineRuntimeWriteGuard | undefined;
  readonly runtimeCapability?: EngineRuntimeCapability | undefined;

  claimsSession(session: Session): boolean;
  commitMessages(session: Session, messages: readonly Message[]): Promise<void>;
  commitMessageOnce(session: Session, eventId: string, message: Message): Promise<CommitReceipt>;
  readModelHistory(includeEventIds?: boolean): Promise<Message[]>;
  readModelHistoryEntries(): Promise<readonly RuntimeHistoryEntry[]>;
  readSessionProjectionEntries(): Promise<readonly RuntimeHistoryEntry[]>;
  findLastCompactionCheckpoint(): Promise<RuntimeLastCompactionCheckpoint | undefined>;
  run<Result>(execute: () => Promise<Result>, signal?: AbortSignal): Promise<Result>;
  recordTurnStarted(turn: number): Promise<void>;
  recordCheckpoint(input: RuntimeCheckpointInput): Promise<void>;
  recordToolStarted(
    toolCallId: string,
    toolName: string,
    argumentsJson: string,
    context?: ToolContext,
  ): Promise<void>;
  executeNestedTool(call: ToolCall, registry: Registry, context: ToolContext): Promise<ToolResult>;
  assertNoUnresolvedToolEffects(): Promise<void>;
  /** Host-only evidence probe; never dispatches or replays the original tool. */
  reconcileToolRecovery(input: {
    readonly recoveryEventId: string;
    readonly registry: Registry;
    readonly signal?: AbortSignal;
  }): Promise<RecoveryProbeResult>;
  resolveToolRecovery(
    input: {
      readonly recoveryEventId: string;
      readonly outcome: "effects_verified" | "not_dispatched_verified";
      readonly evidenceUri: string;
      readonly summary: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  recordTranscriptToolStarts(
    session: Session,
    toolCalls: readonly ToolCall[],
  ): Promise<readonly CanonicalTranscriptToolStart[]>;
  recordTranscriptMessage(message: Message): Promise<void>;
  recordToolGroupLoaded(groupId: string, toolNames: readonly string[]): Promise<void>;
  recordTranscriptToolResults(
    inputs: readonly RuntimeToolResultInput[],
  ): Promise<readonly Message[]>;
  registerToolResult(input: RuntimeToolResultInput): Message;
  /** Records an explicit local rejection/interruption that was never dispatched to a tool. */
  registerUndispatchedToolResult(input: RuntimeToolResultInput): Message;
  /** Closes an abnormal batch, settling T2 when dispatch already reached T1. */
  registerProtocolClosureToolResult(input: RuntimeToolResultInput): Message;
  upsertPartialSnapshot(
    partialId: string,
    kind: string,
    expectedVersion: number,
    payload: unknown,
  ): Promise<RuntimePartialSnapshot>;
  appendPartialSegment(
    partialId: string,
    segmentIndex: number,
    payload: unknown,
  ): Promise<{ readonly inserted: boolean; readonly segment: RuntimePartialSegment }>;
  readPartials(): Promise<RuntimeRunPartials>;
  clearPartials(): Promise<number>;
}

export interface RuntimeRunStartOptions {
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
  readonly capability: EngineRuntimeCapability;
}

export interface RuntimeReconcileOptions {
  readonly capability: EngineRuntimeCapability;
}

export interface RuntimeRepairProjectionOptions {
  readonly capability: EngineRuntimeCapability;
}

/** Runtime lifecycle and ambient-context port consumed by an outer Engine. */
export interface RuntimePort<Session, Registry, ToolContext, RecoveryProbeResult> {
  currentRun(): RuntimeRunPort<Session, Registry, ToolContext, RecoveryProbeResult> | undefined;
  currentToolCallId(): string | undefined;
  runWithToolCall<Result>(toolCallId: string, execute: () => Result): Result;
  reconcileIncompleteRuns(options: RuntimeReconcileOptions): Promise<readonly string[]>;
  repairSessionProjection(
    session: Session,
    options: RuntimeRepairProjectionOptions,
  ): Promise<boolean>;
  startRun(
    options: RuntimeRunStartOptions,
  ): Promise<RuntimeRunPort<Session, Registry, ToolContext, RecoveryProbeResult>>;
  commitExternalMessages(session: Session, messages: readonly Message[]): Promise<boolean>;
  commitExternalMessageOnce(
    session: Session,
    eventId: string,
    message: Message,
  ): Promise<CommitReceipt | undefined>;
}
