import type {
  TranscriptEntryData,
  TranscriptSubagentActivity,
} from "./transcript-entry-contract.js";

/**
 * Strict, presentation-independent validation for Transcript facts that may be
 * persisted in the Runtime event ledger. Live-only presentation events are
 * deliberately rejected here.
 */
interface DurableTranscriptEventBase {
  readonly eventId: string;
  readonly sequence: number;
  readonly createdAt: number;
}

export type DurableTranscriptEvent =
  | (DurableTranscriptEventBase & {
      readonly type: "entry.appended";
      readonly entryId: string;
      readonly entry: TranscriptEntryData;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "assistant.stream.started";
      readonly entryId: string;
      readonly streamId: string;
      readonly delta: string;
      readonly entryKind: "assistant" | "thinking";
    })
  | (DurableTranscriptEventBase & {
      readonly type: "assistant.stream.completed";
      readonly entryId: string;
      readonly streamId: string;
      readonly content?: string;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "assistant.stream.interrupted";
      readonly entryId: string;
      readonly streamId: string;
      readonly reason: "new-request" | "clear" | "truncate" | "abort";
      readonly content?: string;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "assistant.response.suppressed";
      readonly entryId: string;
      readonly reason: "internal-control" | "network-retry";
    })
  | (DurableTranscriptEventBase & {
      readonly type: "tool.started";
      readonly entryId: string;
      readonly toolCallId: string;
      readonly providerCallId: string;
      readonly name: string;
      readonly args: string;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "tool.approval.requested";
      readonly toolCallId: string;
      readonly summary: string;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "subagent.activity.updated";
      readonly entryId: string;
      readonly activityId: string;
      readonly activity: Omit<TranscriptSubagentActivity, "activityId">;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "subagent.activity.archived";
      readonly activityId: string;
    })
  | (DurableTranscriptEventBase & {
      readonly type: "transcript.truncated";
      readonly entryCount: number;
      readonly operationId: string;
    });

export function assertDurableTranscriptEvent(
  value: unknown,
): asserts value is DurableTranscriptEvent {
  if (!isRecord(value)) throw new Error("Transcript event must be an object");
  requiredString(value, "eventId");
  positiveInteger(value, "sequence");
  finiteNumber(value, "createdAt");

  switch (value["type"]) {
    case "entry.appended": {
      exactKeys(value, ["eventId", "sequence", "createdAt", "type", "entryId", "entry"]);
      requiredString(value, "entryId");
      const entry = requiredRecord(value, "entry");
      assertEntry(entry);
      if (entry["kind"] === "thinking" && !String(entry["content"] ?? "").trim()) {
        throw new Error("Transcript event entry.appended is presentation-only");
      }
      return;
    }
    case "assistant.stream.started":
      exactKeys(value, [
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "delta",
        "entryKind",
      ]);
      requiredStrings(value, ["entryId", "streamId", "delta", "entryKind"]);
      enumValue(value, "entryKind", ["assistant", "thinking"]);
      return;
    case "assistant.stream.completed":
      exactKeys(value, [
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "content",
      ]);
      requiredStrings(value, ["entryId", "streamId"]);
      optionalString(value, "content");
      return;
    case "assistant.stream.interrupted":
      exactKeys(value, [
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "reason",
        "content",
      ]);
      requiredStrings(value, ["entryId", "streamId", "reason"]);
      enumValue(value, "reason", ["new-request", "clear", "truncate", "abort"]);
      optionalString(value, "content");
      return;
    case "assistant.response.suppressed":
      exactKeys(value, ["eventId", "sequence", "createdAt", "type", "entryId", "reason"]);
      requiredStrings(value, ["entryId", "reason"]);
      enumValue(value, "reason", ["internal-control", "network-retry"]);
      return;
    case "tool.started":
      exactKeys(value, [
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "toolCallId",
        "providerCallId",
        "name",
        "args",
      ]);
      requiredStrings(value, ["entryId", "toolCallId", "providerCallId", "name", "args"]);
      return;
    case "tool.approval.requested":
      exactKeys(value, ["eventId", "sequence", "createdAt", "type", "toolCallId", "summary"]);
      requiredStrings(value, ["toolCallId", "summary"]);
      return;
    case "subagent.activity.updated": {
      exactKeys(value, [
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "activityId",
        "activity",
      ]);
      requiredStrings(value, ["entryId", "activityId"]);
      const activity = requiredRecord(value, "activity");
      assertSubagentActivity(activity);
      enumValue(activity, "status", ["completed", "partial", "failed", "timed_out", "cancelled"]);
      return;
    }
    case "subagent.activity.archived":
      exactKeys(value, ["eventId", "sequence", "createdAt", "type", "activityId"]);
      requiredString(value, "activityId");
      return;
    case "transcript.truncated":
      exactKeys(value, ["eventId", "sequence", "createdAt", "type", "entryCount", "operationId"]);
      nonNegativeInteger(value, "entryCount");
      requiredString(value, "operationId");
      return;
    default:
      throw new Error(`Transcript event ${String(value["type"])} is presentation-only`);
  }
}

function assertEntry(value: Record<string, unknown>): void {
  requiredString(value, "kind");
  switch (value["kind"]) {
    case "logo":
      exactKeys(value, [
        "kind",
        "model",
        "cwd",
        "sessionMode",
        "permissionMode",
        "mcpSummary",
        "taskSummary",
      ]);
      optionalStrings(value, [
        "model",
        "cwd",
        "sessionMode",
        "permissionMode",
        "mcpSummary",
        "taskSummary",
      ]);
      return;
    case "user":
    case "system":
    case "assistant":
      exactKeys(value, ["kind", "content"]);
      requiredString(value, "content");
      return;
    case "thinking":
      exactKeys(value, ["kind", "content"]);
      optionalString(value, "content");
      return;
    case "skill":
      exactKeys(value, ["kind", "name", "args", "trigger"]);
      requiredStrings(value, ["name", "args", "trigger"]);
      enumValue(value, "trigger", ["user-slash", "model-tool"]);
      return;
    case "error":
      exactKeys(value, ["kind", "message", "retryable", "action"]);
      requiredString(value, "message");
      optionalBoolean(value, "retryable");
      optionalString(value, "action");
      return;
    case "tool":
      exactKeys(value, ["kind", "name", "args", "status", "summary"]);
      requiredStrings(value, ["name", "args", "status"]);
      enumValue(value, "status", ["queued", "running", "approval", "success", "error", "denied"]);
      optionalString(value, "summary");
      return;
    case "plan":
      exactKeys(value, ["kind", "title", "detail", "state"]);
      requiredString(value, "title");
      optionalString(value, "detail");
      optionalEnum(value, "state", ["waiting", "active", "done", "failed"]);
      return;
    case "approval":
    case "prompt":
    case "changes":
      exactKeys(value, ["kind", "title", "detail", "state", "data"]);
      requiredString(value, "title");
      optionalString(value, "detail");
      optionalString(value, "state");
      optionalRecord(value, "data");
      return;
    case "run-boundary":
      exactKeys(value, ["kind", "runId", "status", "startedAt", "finishedAt", "error"]);
      requiredStrings(value, ["runId", "status"]);
      enumValue(value, "status", [
        "queued",
        "running",
        "pause_requested",
        "paused",
        "cancelling",
        "cancelled",
        "failed",
        "succeeded",
      ]);
      finiteNumber(value, "startedAt");
      optionalFiniteNumber(value, "finishedAt");
      optionalString(value, "error");
      return;
    case "subagent-activity":
      assertSubagentActivity(value);
      return;
    default:
      throw new Error("Transcript entry kind is invalid");
  }
}

function assertSubagentActivity(value: Record<string, unknown>): void {
  exactKeys(value, [
    "task",
    "status",
    "agentName",
    "mode",
    "completionPolicy",
    "currentAction",
    "summary",
    "requestedModelRoute",
    "resolvedModelRoute",
    "thinkingEffort",
    "modelSelectionSource",
    "childSessionId",
    "childWorkspacePath",
    "toolCallId",
    "durationMs",
  ]);
  requiredStrings(value, ["task", "status", "mode", "completionPolicy"]);
  enumValue(value, "status", [
    "queued",
    "running",
    "completed",
    "partial",
    "failed",
    "timed_out",
    "cancelled",
  ]);
  enumValue(value, "mode", ["explore", "worker"]);
  enumValue(value, "completionPolicy", ["required", "optional", "detached"]);
  optionalStrings(value, [
    "agentName",
    "currentAction",
    "summary",
    "requestedModelRoute",
    "resolvedModelRoute",
    "thinkingEffort",
    "childSessionId",
    "childWorkspacePath",
    "toolCallId",
  ]);
  optionalFiniteNumber(value, "durationMs");
  optionalEnum(value, "modelSelectionSource", ["ephemeral", "profile", "parent"]);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`Transcript event contains unsupported field ${extra}`);
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) throw new Error(`Transcript event ${key} must be an object`);
  return nested;
}

function optionalRecord(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && !isRecord(value[key])) {
    throw new Error(`Transcript event ${key} must be an object`);
  }
}

function requiredString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Transcript event ${key} must be a non-empty string`);
  }
}

function requiredStrings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) requiredString(value, key);
}

function optionalString(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    throw new Error(`Transcript event ${key} must be a string`);
  }
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) optionalString(value, key);
}

function optionalBoolean(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== "boolean") {
    throw new Error(`Transcript event ${key} must be boolean`);
  }
}

function finiteNumber(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    throw new Error(`Transcript event ${key} must be finite`);
  }
}

function optionalFiniteNumber(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined) finiteNumber(value, key);
}

function positiveInteger(value: Record<string, unknown>, key: string): void {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
    throw new Error(`Transcript event ${key} must be a positive integer`);
  }
}

function nonNegativeInteger(value: Record<string, unknown>, key: string): void {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
    throw new Error(`Transcript event ${key} must be a non-negative integer`);
  }
}

function enumValue(value: Record<string, unknown>, key: string, allowed: readonly string[]): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as string)) {
    throw new Error(`Transcript event ${key} is invalid`);
  }
}

function optionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): void {
  if (value[key] !== undefined) enumValue(value, key, allowed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
