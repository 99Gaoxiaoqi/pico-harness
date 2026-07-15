import type { Message, Usage } from "../schema/message.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStatePatch,
  type SessionRuntimeStatePatch,
} from "../engine/session-runtime.js";

export const RUNTIME_EVENT_SCHEMA_VERSION = 1 as const;

export type RuntimeEventVisibility = "model" | "transcript" | "internal";

export type RuntimeTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface RuntimeEvidenceReference {
  readonly schemaVersion: 1;
  readonly contentHash: string;
  readonly sessionId: string;
  readonly kind: "tool-exchange";
}

export interface RuntimeEventRefs {
  readonly stepId?: string;
  readonly toolCallId?: string;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
  readonly providerCallId?: string;
  readonly evidence?: RuntimeEvidenceReference;
}

export interface RuntimeEventBase {
  readonly schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly runId: string;
  /** A user-request boundary. ReAct iterations use `stepId`, never a synthetic turn. */
  readonly turnId: string;
  readonly at: string;
  readonly partial: boolean;
  readonly visibility: RuntimeEventVisibility;
  readonly refs?: RuntimeEventRefs;
}

export interface RuntimeRunStartedEvent extends RuntimeEventBase {
  readonly kind: "run.started";
  readonly data: {
    readonly workDir: string;
  };
}

/** The exact model-visible message, including provider replay metadata and images. */
export interface RuntimeMessageCommittedEvent extends RuntimeEventBase {
  readonly kind: "message.committed";
  readonly data: {
    readonly message: Message;
  };
}

export interface RuntimeToolStartedEvent extends RuntimeEventBase {
  readonly kind: "tool.started";
  readonly data: {
    readonly toolName: string;
    readonly argumentsHash: string;
  };
}

export interface RuntimeApprovalRequestedEvent extends RuntimeEventBase {
  readonly kind: "approval.requested";
  readonly data: {
    readonly approvalId: string;
    readonly toolName: string;
  };
}

export interface RuntimeApprovalSettledEvent extends RuntimeEventBase {
  readonly kind: "approval.settled";
  readonly data: {
    readonly approvalId: string;
    readonly decision: "approved" | "rejected";
  };
}

export interface RuntimeModelCallStartedEvent extends RuntimeEventBase {
  readonly kind: "model.call.started";
  readonly data: {
    readonly providerCallId: string;
    readonly provider?: string;
    readonly model?: string;
    readonly purpose: string;
  };
}

export interface RuntimeModelCallSettledEvent extends RuntimeEventBase {
  readonly kind: "model.call.settled";
  readonly data: {
    readonly providerCallId: string;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly latencyMs: number;
    readonly usage?: Usage;
    readonly costCNY?: number;
    readonly costStatus?: "estimated" | "included" | "unknown";
    readonly error?: string;
  };
}

interface RuntimeCheckpointRecordedEventDataBase {
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
}

/** A checkpoint that can replace a prefix of the current model-history projection. */
export interface RuntimeRollingCheckpointData extends RuntimeCheckpointRecordedEventDataBase {
  readonly throughEventId: string;
  readonly summary: Message;
}

/** Pre-rolling checkpoint facts remain decodable but do not change the model projection. */
interface RuntimeLegacyCheckpointData extends RuntimeCheckpointRecordedEventDataBase {
  readonly throughEventId?: undefined;
  readonly summary?: undefined;
}

export type RuntimeCheckpointRecordedEventData =
  | RuntimeLegacyCheckpointData
  | RuntimeRollingCheckpointData;

export interface RuntimeCheckpointRecordedEvent extends RuntimeEventBase {
  readonly kind: "context.checkpoint.recorded";
  readonly data: RuntimeCheckpointRecordedEventData;
}

export interface RuntimeHistoryRewoundEvent extends RuntimeEventBase {
  readonly kind: "history.rewound";
  readonly data: {
    readonly branchId: string;
    readonly throughEventId?: string;
  };
}

export interface RuntimeSessionForkedEvent extends RuntimeEventBase {
  readonly kind: "session.forked";
  readonly data: {
    readonly parentSessionId: string;
    readonly throughEventId?: string;
    /** Present only once the frozen Session seed has been fully materialized. */
    readonly sourceDigest?: string;
    readonly messageCount?: number;
  };
}

/** Session-scoped settings and goal facts that are not part of model history. */
export interface RuntimeSessionStateCommittedEvent extends RuntimeEventBase {
  readonly kind: "session.state.committed";
  readonly data: {
    readonly stateVersion: typeof SESSION_RUNTIME_STATE_VERSION;
    readonly patch: SessionRuntimeStatePatch;
  };
}

export interface RuntimeRunTerminalEvent extends RuntimeEventBase {
  readonly kind: "run.terminal";
  readonly data: {
    readonly status: RuntimeTerminalStatus;
    readonly reason?: string;
    readonly recovered?: boolean;
  };
}

export type RuntimeEvent =
  | RuntimeRunStartedEvent
  | RuntimeMessageCommittedEvent
  | RuntimeToolStartedEvent
  | RuntimeApprovalRequestedEvent
  | RuntimeApprovalSettledEvent
  | RuntimeModelCallStartedEvent
  | RuntimeModelCallSettledEvent
  | RuntimeCheckpointRecordedEvent
  | RuntimeHistoryRewoundEvent
  | RuntimeSessionForkedEvent
  | RuntimeSessionStateCommittedEvent
  | RuntimeRunTerminalEvent;

export function isRuntimeTerminalEvent(event: RuntimeEvent): event is RuntimeRunTerminalEvent {
  return event.kind === "run.terminal";
}

export function isRuntimeMessageEvent(event: RuntimeEvent): event is RuntimeMessageCommittedEvent {
  return event.kind === "message.committed";
}

export function runtimeEventHasModelMessage(
  event: RuntimeEvent,
): event is RuntimeMessageCommittedEvent {
  return event.kind === "message.committed" && event.visibility === "model" && !event.partial;
}

export function assertRuntimeEvent(value: unknown): asserts value is RuntimeEvent {
  if (!isRecord(value)) throw new RuntimeEventIntegrityError("Runtime event must be an object");
  assertEqual(value["schemaVersion"], RUNTIME_EVENT_SCHEMA_VERSION, "schemaVersion");
  assertString(value["eventId"], "eventId");
  assertString(value["sessionId"], "sessionId");
  assertString(value["invocationId"], "invocationId");
  assertString(value["runId"], "runId");
  assertString(value["turnId"], "turnId");
  assertString(value["at"], "at");
  if (typeof value["partial"] !== "boolean") {
    throw new RuntimeEventIntegrityError("Runtime event partial must be boolean");
  }
  if (!isVisibility(value["visibility"])) {
    throw new RuntimeEventIntegrityError("Runtime event visibility is invalid");
  }
  assertString(value["kind"], "kind");
  if (!isRecord(value["data"]))
    throw new RuntimeEventIntegrityError("Runtime event data must be an object");
  if (value["refs"] !== undefined && !isRecord(value["refs"])) {
    throw new RuntimeEventIntegrityError("Runtime event refs must be an object");
  }
  switch (value["kind"]) {
    case "run.started":
      assertString(value["data"]["workDir"], "run.started.workDir");
      return;
    case "message.committed":
      assertMessage(value["data"]["message"]);
      return;
    case "tool.started":
      assertString(value["data"]["toolName"], "tool.started.toolName");
      assertString(value["data"]["argumentsHash"], "tool.started.argumentsHash");
      return;
    case "approval.requested":
      assertString(value["data"]["approvalId"], "approval.requested.approvalId");
      assertString(value["data"]["toolName"], "approval.requested.toolName");
      return;
    case "approval.settled":
      assertString(value["data"]["approvalId"], "approval.settled.approvalId");
      if (value["data"]["decision"] !== "approved" && value["data"]["decision"] !== "rejected") {
        throw new RuntimeEventIntegrityError("Runtime approval decision is invalid");
      }
      return;
    case "model.call.started":
      assertString(value["data"]["providerCallId"], "model.call.started.providerCallId");
      assertString(value["data"]["purpose"], "model.call.started.purpose");
      return;
    case "model.call.settled":
      assertString(value["data"]["providerCallId"], "model.call.settled.providerCallId");
      if (!isModelCallStatus(value["data"]["status"])) {
        throw new RuntimeEventIntegrityError("Runtime model call status is invalid");
      }
      if (!isNonNegativeNumber(value["data"]["latencyMs"])) {
        throw new RuntimeEventIntegrityError("Runtime model call latency is invalid");
      }
      if (value["data"]["usage"] !== undefined) {
        assertUsage(value["data"]["usage"]);
      }
      if (
        value["data"]["costCNY"] !== undefined &&
        !isNonNegativeNumber(value["data"]["costCNY"])
      ) {
        throw new RuntimeEventIntegrityError("Runtime model call cost is invalid");
      }
      if (value["data"]["costStatus"] !== undefined && !isCostStatus(value["data"]["costStatus"])) {
        throw new RuntimeEventIntegrityError("Runtime model call cost status is invalid");
      }
      return;
    case "context.checkpoint.recorded":
      assertString(value["data"]["checkpointId"], "context.checkpoint.recorded.checkpointId");
      assertString(value["data"]["sourceDigest"], "context.checkpoint.recorded.sourceDigest");
      if (!isNonNegativeNumber(value["data"]["coveredEventCount"])) {
        throw new RuntimeEventIntegrityError("Runtime checkpoint event count is invalid");
      }
      assertCheckpointSummary(value["data"]);
      return;
    case "history.rewound":
      assertString(value["data"]["branchId"], "history.rewound.branchId");
      return;
    case "session.forked":
      assertString(value["data"]["parentSessionId"], "session.forked.parentSessionId");
      if (
        (value["data"]["sourceDigest"] === undefined) !==
        (value["data"]["messageCount"] === undefined)
      ) {
        throw new RuntimeEventIntegrityError(
          "Runtime session fork completion digest and message count must appear together",
        );
      }
      if (value["data"]["sourceDigest"] !== undefined) {
        assertString(value["data"]["sourceDigest"], "session.forked.sourceDigest");
        if (!isNonNegativeInteger(value["data"]["messageCount"])) {
          throw new RuntimeEventIntegrityError("Runtime session fork message count is invalid");
        }
      }
      return;
    case "session.state.committed": {
      if (value["data"]["stateVersion"] !== SESSION_RUNTIME_STATE_VERSION) {
        throw new RuntimeEventIntegrityError("Runtime session state version is invalid");
      }
      const patch = normalizeSessionRuntimeStatePatch(value["data"]["patch"]);
      if (!patch) {
        throw new RuntimeEventIntegrityError("Runtime session state patch is invalid");
      }
      return;
    }
    case "run.terminal":
      if (!isTerminalStatus(value["data"]["status"])) {
        throw new RuntimeEventIntegrityError("Runtime terminal status is invalid");
      }
      return;
    default:
      throw new RuntimeEventIntegrityError(
        `Runtime event kind is invalid: ${String(value["kind"])}`,
      );
  }
}

export class RuntimeEventIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEventIntegrityError";
  }
}

function assertMessage(value: unknown): asserts value is Message {
  if (!isRecord(value) || !isRole(value["role"]) || typeof value["content"] !== "string") {
    throw new RuntimeEventIntegrityError("Runtime message payload is invalid");
  }
}

function assertUsage(value: unknown): asserts value is Usage {
  if (!isRecord(value)) throw new RuntimeEventIntegrityError("Runtime model usage is invalid");
  if (
    !isNonNegativeNumber(value["promptTokens"]) ||
    !isNonNegativeNumber(value["completionTokens"])
  ) {
    throw new RuntimeEventIntegrityError("Runtime model usage totals are invalid");
  }
  for (const field of ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
    if (value[field] !== undefined && !isNonNegativeNumber(value[field])) {
      throw new RuntimeEventIntegrityError(`Runtime model usage ${field} is invalid`);
    }
  }
  const reportedFields = value["reportedFields"];
  if (
    reportedFields !== undefined &&
    (!Array.isArray(reportedFields) || !reportedFields.every(isUsageReportedField))
  ) {
    throw new RuntimeEventIntegrityError("Runtime model usage reportedFields is invalid");
  }
}

function assertCheckpointSummary(value: Record<string, unknown>): void {
  const throughEventId = value["throughEventId"];
  const summary = value["summary"];
  if (throughEventId === undefined && summary === undefined) return;
  if (throughEventId === undefined || summary === undefined) {
    throw new RuntimeEventIntegrityError(
      "Runtime checkpoint must include throughEventId and summary together",
    );
  }
  assertString(throughEventId, "context.checkpoint.recorded.throughEventId");
  assertMessage(summary);
}

function assertEqual(value: unknown, expected: unknown, field: string): void {
  if (value !== expected) throw new RuntimeEventIntegrityError(`Runtime event ${field} is invalid`);
}

function assertString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeEventIntegrityError(`Runtime event ${field} must be non-empty`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVisibility(value: unknown): value is RuntimeEventVisibility {
  return value === "model" || value === "transcript" || value === "internal";
}

function isRole(value: unknown): boolean {
  return value === "system" || value === "user" || value === "assistant";
}

function isModelCallStatus(value: unknown): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

function isCostStatus(value: unknown): boolean {
  return value === "estimated" || value === "included" || value === "unknown";
}

function isUsageReportedField(value: unknown): boolean {
  return (
    value === "prompt" ||
    value === "completion" ||
    value === "input" ||
    value === "cacheRead" ||
    value === "cacheWrite" ||
    value === "reasoning"
  );
}

function isTerminalStatus(value: unknown): value is RuntimeTerminalStatus {
  return (
    value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted"
  );
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
