import { createHash } from "node:crypto";
import { assertTranscriptEvent } from "../presentation/transcript-event-store.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStatePatch,
} from "../engine/session-runtime.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../engine/session-runtime-event.js";
export {
  RUNTIME_EVENT_SCHEMA_VERSION,
  isRuntimeMessageEvent,
  isRuntimeTerminalEvent,
  runtimeEventHasModelMessage,
} from "../engine/session-runtime-event.js";
export type {
  RuntimeApprovalRequestedEvent,
  RuntimeApprovalSettledEvent,
  RuntimeCheckpointRecordedEvent,
  RuntimeCheckpointRecordedEventData,
  RuntimeEvidenceReference,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeEventRefs,
  RuntimeEventVisibility,
  RuntimeHistoryRewoundEvent,
  RuntimeMessageCommittedEvent,
  RuntimeModelCallSettledEvent,
  RuntimeModelCallStartedEvent,
  RuntimeRollingCheckpointData,
  RuntimeRunStartedEvent,
  RuntimeRunTerminalEvent,
  RuntimeSessionForkedEvent,
  RuntimeSessionStateCommittedEvent,
  RuntimeTerminalStatus,
  RuntimeToolStartedEvent,
  RuntimeToolResultRecordedEvent,
  RuntimeTranscriptEventRecordedEvent,
} from "../engine/session-runtime-event.js";
import type {
  RuntimeEvent,
  RuntimeEventVisibility,
  RuntimeTerminalStatus,
} from "../engine/session-runtime-event.js";
import type { Message, Usage } from "../schema/message.js";

export const RUNTIME_EVENT_KINDS = [
  "run.started",
  "message.committed",
  "tool.started",
  "tool.result.recorded",
  "approval.requested",
  "approval.settled",
  "model.call.started",
  "model.call.settled",
  "context.checkpoint.recorded",
  "history.rewound",
  "session.forked",
  "session.state.committed",
  "transcript.event.recorded",
  "run.terminal",
] as const satisfies readonly RuntimeEvent["kind"][];

export const RUNTIME_EVENT_DECODE_ERROR_CODES = [
  "malformed_json",
  "unsupported_legacy_version",
  "unsupported_future_version",
  "unknown_kind",
  "invalid_payload",
] as const;

export type RuntimeEventDecodeErrorCode = (typeof RUNTIME_EVENT_DECODE_ERROR_CODES)[number];

const RUNTIME_EVENT_KIND_SET = new Set<string>(RUNTIME_EVENT_KINDS);

/** Decodes a supported event without rewriting or upgrading the persisted fact. */
export function decodeRuntimeEvent(value: unknown): RuntimeEvent {
  if (isRecord(value)) {
    const schemaVersion = value["schemaVersion"];
    if (Number.isSafeInteger(schemaVersion)) {
      if ((schemaVersion as number) < RUNTIME_EVENT_SCHEMA_VERSION) {
        throw new RuntimeEventDecodeError(
          "unsupported_legacy_version",
          `Runtime event schema version ${String(schemaVersion)} is older than supported ${RUNTIME_EVENT_SCHEMA_VERSION}`,
        );
      }
      if ((schemaVersion as number) > RUNTIME_EVENT_SCHEMA_VERSION) {
        throw new RuntimeEventDecodeError(
          "unsupported_future_version",
          `Runtime event schema version ${String(schemaVersion)} is newer than supported ${RUNTIME_EVENT_SCHEMA_VERSION}`,
        );
      }
    }

    const kind = value["kind"];
    if (
      schemaVersion === RUNTIME_EVENT_SCHEMA_VERSION &&
      typeof kind === "string" &&
      kind.length > 0 &&
      !RUNTIME_EVENT_KIND_SET.has(kind)
    ) {
      throw new RuntimeEventDecodeError(
        "unknown_kind",
        `Runtime event kind is unsupported: ${kind}`,
      );
    }
  }

  try {
    assertRuntimeEvent(value);
  } catch (error) {
    if (error instanceof RuntimeEventDecodeError) throw error;
    throw new RuntimeEventDecodeError(
      "invalid_payload",
      `Runtime event payload is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return value;
}

export function decodeRuntimeEventJson(raw: string): RuntimeEvent {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RuntimeEventDecodeError(
      "malformed_json",
      `Runtime event JSON is malformed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return decodeRuntimeEvent(value);
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
    case "tool.result.recorded":
      assertToolResultRecordedEvent(value);
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
    case "transcript.event.recorded":
      try {
        assertTranscriptEvent(value["data"]["event"]);
      } catch (error) {
        throw new RuntimeEventIntegrityError(
          `Runtime transcript event is invalid: ${errorMessage(error)}`,
        );
      }
      return;
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventIntegrityError";
  }
}

export class RuntimeEventDecodeError extends RuntimeEventIntegrityError {
  readonly code: RuntimeEventDecodeErrorCode;

  constructor(code: RuntimeEventDecodeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventDecodeError";
    this.code = code;
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

function assertToolResultRecordedEvent(value: Record<string, unknown>): void {
  assertOnlyKeys(
    value,
    [
      "schemaVersion",
      "eventId",
      "sessionId",
      "invocationId",
      "runId",
      "turnId",
      "at",
      "partial",
      "visibility",
      "refs",
      "kind",
      "data",
    ],
    "tool.result.recorded",
  );
  if (value["visibility"] !== "model" || value["partial"] !== false) {
    throw new RuntimeEventIntegrityError(
      "Runtime tool result must be a complete model-visible fact",
    );
  }
  const refs = value["refs"];
  if (!isRecord(refs)) {
    throw new RuntimeEventIntegrityError("Runtime tool result refs must be an object");
  }
  assertOnlyKeys(
    refs,
    ["stepId", "toolCallId", "parentRunId", "parentToolCallId", "providerCallId", "evidence"],
    "tool.result.recorded.refs",
  );
  assertString(refs["toolCallId"], "tool.result.recorded.refs.toolCallId");
  for (const field of ["stepId", "parentRunId", "parentToolCallId", "providerCallId"] as const) {
    if (refs[field] !== undefined) {
      assertString(refs[field], `tool.result.recorded.refs.${field}`);
    }
  }

  const data = value["data"];
  if (!isRecord(data)) {
    throw new RuntimeEventIntegrityError("Runtime tool result data must be an object");
  }
  assertOnlyKeys(data, ["toolName", "status", "body", "projection"], "tool.result.recorded.data");
  assertString(data["toolName"], "tool.result.recorded.toolName");
  if (!isToolResultStatus(data["status"])) {
    throw new RuntimeEventIntegrityError("Runtime tool result status is invalid");
  }

  const body = data["body"];
  if (!isRecord(body)) {
    throw new RuntimeEventIntegrityError("Runtime tool result body must be an object");
  }
  const storage = body["storage"];
  if (storage !== "inline" && storage !== "evidence") {
    throw new RuntimeEventIntegrityError("Runtime tool result body storage is invalid");
  }
  assertSha256(body["sha256"], "tool.result.recorded.body.sha256");
  if (!isNonNegativeInteger(body["sizeBytes"])) {
    throw new RuntimeEventIntegrityError("Runtime tool result body sizeBytes is invalid");
  }
  if (storage === "inline") {
    assertOnlyKeys(
      body,
      ["storage", "content", "sha256", "sizeBytes"],
      "tool.result.recorded.body",
    );
    if (typeof body["content"] !== "string") {
      throw new RuntimeEventIntegrityError("Runtime inline tool result content must be a string");
    }
    if (refs["evidence"] !== undefined) {
      throw new RuntimeEventIntegrityError(
        "Runtime inline tool result must not reference evidence",
      );
    }
    const content = body["content"];
    if (Buffer.byteLength(content, "utf8") !== body["sizeBytes"]) {
      throw new RuntimeEventIntegrityError(
        "Runtime inline tool result UTF-8 byte count does not match sizeBytes",
      );
    }
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    if (digest !== body["sha256"]) {
      throw new RuntimeEventIntegrityError(
        "Runtime inline tool result content does not match sha256",
      );
    }
  } else {
    assertOnlyKeys(body, ["storage", "sha256", "sizeBytes"], "tool.result.recorded.body");
    assertRuntimeEvidenceReference(refs["evidence"]);
  }

  const projection = data["projection"];
  if (!isRecord(projection)) {
    throw new RuntimeEventIntegrityError("Runtime tool result projection must be an object");
  }
  assertOnlyKeys(
    projection,
    ["version", "mode", "text", "strategy", "truncated"],
    "tool.result.recorded.projection",
  );
  assertEqual(projection["version"], 1, "tool.result.recorded.projection.version");
  if (
    projection["mode"] !== "full" &&
    projection["mode"] !== "preview" &&
    projection["mode"] !== "synthetic"
  ) {
    throw new RuntimeEventIntegrityError("Runtime tool result projection mode is invalid");
  }
  if (
    projection["mode"] === "synthetic" &&
    (data["status"] === "succeeded" || data["status"] === "failed")
  ) {
    throw new RuntimeEventIntegrityError(
      "Runtime succeeded or failed tool result cannot use a synthetic projection",
    );
  }
  if (typeof projection["text"] !== "string") {
    throw new RuntimeEventIntegrityError("Runtime tool result projection text must be a string");
  }
  assertString(projection["strategy"], "tool.result.recorded.projection.strategy");
  if (typeof projection["truncated"] !== "boolean") {
    throw new RuntimeEventIntegrityError(
      "Runtime tool result projection truncated must be boolean",
    );
  }
}

function assertRuntimeEvidenceReference(value: unknown): void {
  if (!isRecord(value)) {
    throw new RuntimeEventIntegrityError("Runtime tool result evidence ref must be an object");
  }
  assertOnlyKeys(
    value,
    ["schemaVersion", "contentHash", "sessionId", "kind"],
    "tool.result.recorded.refs.evidence",
  );
  assertEqual(value["schemaVersion"], 1, "tool.result.recorded.refs.evidence.schemaVersion");
  assertSha256(value["contentHash"], "tool.result.recorded.refs.evidence.contentHash");
  assertString(value["sessionId"], "tool.result.recorded.refs.evidence.sessionId");
  assertEqual(value["kind"], "tool-exchange", "tool.result.recorded.refs.evidence.kind");
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new RuntimeEventIntegrityError(
      `Runtime event ${field} contains unsupported field ${unexpected}`,
    );
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RuntimeEventIntegrityError(`Runtime event ${field} must be a SHA-256 digest`);
  }
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

function isToolResultStatus(value: unknown): boolean {
  return (
    value === "succeeded" ||
    value === "failed" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
