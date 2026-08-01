import { randomUUID } from "node:crypto";
import type {
  AssistantResponseSuppressionReason,
  SubagentActivityEvent,
  SubagentTraceEvent,
} from "../engine/reporter.js";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
/** 与具体渲染框架无关的执行阶段。 */
export type TranscriptPhaseMode = "idle" | "requesting" | "thinking" | "tool-use" | "responding";

/** 工具调用在 transcript 中的标准状态。 */
export type TranscriptToolCallStatus =
  | "queued"
  | "running"
  | "approval"
  | "success"
  | "error"
  | "denied";

export type CompletedTranscriptToolCallStatus = "success" | "error" | "denied";

export function transcriptToolStatusFromEnvelope(
  envelope: ToolResultEnvelope,
): CompletedTranscriptToolCallStatus {
  if (envelope.status === "succeeded") return "success";
  if (envelope.status === "rejected") return "denied";
  return "error";
}

/** Transcript 事件与 reducer 共同持有的语义正文，不包含渲染身份。 */
export type TranscriptEntryData =
  | {
      kind: "logo";
      model?: string;
      cwd?: string;
      sessionMode?: string;
      permissionMode?: string;
      mcpSummary?: string;
      taskSummary?: string;
    }
  | { kind: "user"; content: string }
  | { kind: "skill"; name: string; args: string; trigger: "user-slash" | "model-tool" }
  | { kind: "system"; content: string }
  | { kind: "error"; message: string; retryable?: boolean; action?: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool"; name: string; args: string; status: TranscriptToolCallStatus; summary?: string }
  | {
      kind: "plan";
      title: string;
      detail?: string;
      state?: "waiting" | "active" | "done" | "failed";
    }
  | {
      kind: "approval" | "prompt" | "changes";
      title: string;
      detail?: string;
      state?: string;
      data?: Readonly<Record<string, unknown>>;
    }
  | {
      kind: "run-boundary";
      runId: string;
      status:
        | "queued"
        | "running"
        | "pause_requested"
        | "paused"
        | "cancelling"
        | "cancelled"
        | "failed"
        | "succeeded";
      startedAt: number;
      finishedAt?: number;
      error?: string;
    }
  | {
      kind: "subagent-activity";
      task: string;
      status: SubagentActivityEvent["status"];
      agentName?: string;
      mode: SubagentActivityEvent["mode"];
      completionPolicy: SubagentActivityEvent["completionPolicy"];
      currentAction?: string;
      summary?: string;
      requestedModelRoute?: string;
      resolvedModelRoute?: string;
      thinkingEffort?: string;
      modelSelectionSource?: SubagentActivityEvent["modelSelectionSource"];
    }
  | { kind: "thinking"; content?: string };

/** 仅供渲染边界使用；事件正文仍由 TranscriptProjectedEntry 持有权威身份。 */
export interface TranscriptRenderIdentity {
  readonly uiEntryId?: string;
  readonly uiToolCallId?: string;
  readonly uiToolCallIds?: readonly string[];
}

export type TranscriptEntry = TranscriptEntryData & TranscriptRenderIdentity;

export interface TranscriptProjectedEntry {
  /** 条目从创建到流式完成、工具状态变更始终不变。 */
  readonly id: string;
  readonly entry: TranscriptEntryData;
  readonly streamId?: string;
  readonly toolCallId?: string;
  /** 仅供 reducer 关联同一活动，不会投影到 TranscriptEntry 或渲染层。 */
  readonly subagentActivityId?: string;
}

export interface TranscriptPhaseProjection {
  readonly id: string;
  readonly mode: TranscriptPhaseMode;
}

export interface TranscriptStreamProjection {
  readonly id: string;
  readonly entryId: string;
  readonly status: "streaming" | "completed" | "interrupted";
}

export interface TranscriptToolCallProjection {
  /** EventStore 内部生成的全局唯一 ID，所有后续事件都用它关联。 */
  readonly id: string;
  /** Provider 仅保证单次响应内可关联，跨轮可重复。 */
  readonly providerCallId: string;
  readonly entryId: string;
  readonly name: string;
  readonly args: string;
  readonly status: TranscriptToolCallStatus;
  /** 有界的已投影正文；reducer 每个固定大小 segment 只追加一次。 */
  readonly output: string;
  /** 保留 stdout/stderr 的到达顺序，不在每个 run 里重复正文。 */
  readonly outputSegments: readonly TranscriptToolOutputSegment[];
  readonly outputChars: number;
  readonly droppedOutputChars: number;
  readonly outputTruncated: boolean;
  /** 小结果的完整正文；若与增量输出一致，由 reducer 从 output 合成。 */
  readonly result?: string;
  /** 折叠态与外部化结果使用的短摘要。 */
  readonly summary?: string;
  /** Reporter 从 canonical tool.result.recorded 生成的唯一宿主投影。 */
  readonly resultEnvelope?: ToolResultEnvelope;
  /** Inspector 只根据该字段判断完整结果是否仍可用。 */
  readonly resultAvailability?: "inline" | "evidence" | "unavailable";
}

export interface TranscriptToolOutputRun {
  readonly stream: "stdout" | "stderr";
  readonly length: number;
}

export interface TranscriptToolOutputSegment {
  readonly content: string;
  readonly runs: readonly TranscriptToolOutputRun[];
}

export type TranscriptSubagentTraceItem =
  | { readonly id: string; readonly kind: "thinking"; readonly createdAt: number }
  | {
      readonly id: string;
      readonly kind: "message";
      readonly content: string;
      readonly createdAt: number;
    }
  | {
      readonly id: string;
      readonly kind: "tool";
      readonly name: string;
      readonly args: string;
      readonly status: "running" | "success" | "error";
      readonly result?: string;
      readonly resultTruncated?: boolean;
      readonly createdAt: number;
      readonly completedAt?: number;
    };

export type TranscriptSubagentLifecycle =
  | "active"
  | "terminal_unconsumed"
  | "terminal_claimed"
  | "archived";

export interface TranscriptSubagentProjection {
  readonly activityId: string;
  readonly entryId: string;
  readonly activity: Omit<SubagentActivityEvent, "activityId">;
  readonly timeline: readonly TranscriptSubagentTraceItem[];
  /** archived 只影响底部导航可见性，activity 与 timeline 始终保留用于历史详情。 */
  readonly lifecycle: TranscriptSubagentLifecycle;
}

/** EventStore 也守住此上限，避免绕过 Reporter 时投影无界增长。 */
export const TRANSCRIPT_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS = 32_000;
export const TRANSCRIPT_CHECKPOINT_INLINE_RESULT_BUDGET_CHARS = 128_000;
export const TRANSCRIPT_CHECKPOINT_INLINE_RESULT_RECENT_COUNT = 8;
export const TRANSCRIPT_SUBAGENT_TRACE_MAX_ITEMS = 256;
export const TRANSCRIPT_SUBAGENT_MESSAGE_LIMIT_CHARS = 12_000;
export const TRANSCRIPT_SUBAGENT_TOOL_ARGS_LIMIT_CHARS = 8_000;
export const TRANSCRIPT_SUBAGENT_TOOL_RESULT_LIMIT_CHARS = 32_000;

/** append-only 事件流的确定性投影。 */
export interface TranscriptProjection {
  readonly entries: readonly TranscriptProjectedEntry[];
  readonly phase: TranscriptPhaseProjection;
  readonly streams: Readonly<Record<string, TranscriptStreamProjection>>;
  readonly toolCalls: Readonly<Record<string, TranscriptToolCallProjection>>;
  /** 子代理详情与主 transcript 分离，activityId 是稳定导航键。 */
  readonly subagents: Readonly<Record<string, TranscriptSubagentProjection>>;
  readonly lastEventId?: string;
  readonly sequence: number;
}

/** 将权威投影变成渲染层 view entries，同时保留稳定 entry/tool 身份。 */
export function projectTranscriptEntriesForRendering(
  projection: TranscriptProjection,
): TranscriptEntry[] {
  return projection.entries.map(
    (projected) =>
      Object.freeze({
        ...projected.entry,
        uiEntryId: projected.id,
        ...(projected.toolCallId !== undefined ? { uiToolCallId: projected.toolCallId } : {}),
      }) as TranscriptEntry,
  );
}

interface TranscriptEventBase {
  /** 事件库生成的唯一 ID，不由 reporter 调用方提供。 */
  readonly eventId: string;
  /** 事件在当前 store 内严格递增的序号。 */
  readonly sequence: number;
  readonly createdAt: number;
}

/**
 * Transcript 领域事件。条目更新不是对象就地修改，而是一条新事件。
 */
export type TranscriptEvent =
  | (TranscriptEventBase & {
      readonly type: "entry.appended";
      readonly entryId: string;
      readonly entry: TranscriptEntryData;
    })
  | (TranscriptEventBase & {
      readonly type: "assistant.stream.started";
      readonly entryId: string;
      readonly streamId: string;
      readonly delta: string;
      readonly entryKind: "assistant" | "thinking";
    })
  | (TranscriptEventBase & {
      readonly type: "assistant.stream.delta";
      readonly entryId: string;
      readonly streamId: string;
      readonly delta: string;
    })
  | (TranscriptEventBase & {
      readonly type: "assistant.stream.completed";
      readonly entryId: string;
      readonly streamId: string;
      /** 只在 provider 最终文本与已投影 delta 不同时写入，避免大正文重复常驻。 */
      readonly content?: string;
    })
  | (TranscriptEventBase & {
      readonly type: "assistant.stream.interrupted";
      readonly entryId: string;
      readonly streamId: string;
      readonly reason: "new-request" | "clear" | "truncate" | "abort";
      /** delta 不落盘时携带中断前的最终投影，保证恢复结果等于 live UI。 */
      readonly content?: string;
    })
  | (TranscriptEventBase & {
      readonly type: "assistant.response.suppressed";
      readonly entryId: string;
      readonly reason: AssistantResponseSuppressionReason;
    })
  | (TranscriptEventBase & {
      readonly type: "tool.started";
      readonly entryId: string;
      /** EventStore 内部 ID，不得直接使用 provider call ID。 */
      readonly toolCallId: string;
      readonly providerCallId: string;
      readonly name: string;
      readonly args: string;
    })
  | (TranscriptEventBase & {
      readonly type: "tool.approval.requested";
      readonly toolCallId: string;
      readonly summary: string;
    })
  | (TranscriptEventBase & {
      readonly type: "tool.output";
      readonly toolCallId: string;
      readonly segment: TranscriptToolOutputSegment;
    })
  | (TranscriptEventBase & {
      readonly type: "tool.output.truncated";
      readonly toolCallId: string;
      /** 第一次超过 Reporter 内存上限时未写入事件流的字符数。 */
      readonly droppedChars: number;
    })
  | (TranscriptEventBase & {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly summary: string;
      /** 直接持有 canonical ToolResult 的有界宿主投影，不再解析 Message 文本。 */
      readonly result: ToolResultEnvelope;
    })
  | (TranscriptEventBase & {
      readonly type: "subagent.activity.updated";
      readonly entryId: string;
      /** 稳定关联键只在事件与投影内部使用，不进入可渲染数据。 */
      readonly activityId: string;
      readonly activity: Omit<SubagentActivityEvent, "activityId">;
    })
  | (TranscriptEventBase & {
      readonly type: "subagent.trace.recorded";
      readonly trace: SubagentTraceEvent;
    })
  | (TranscriptEventBase & {
      readonly type: "subagent.activity.claimed";
      readonly activityId: string;
    })
  | (TranscriptEventBase & {
      readonly type: "subagent.activity.archived";
      readonly activityId: string;
    })
  | (TranscriptEventBase & {
      readonly type: "phase.changed";
      readonly phaseId: string;
      readonly mode: TranscriptPhaseMode;
    })
  | (TranscriptEventBase & {
      readonly type: "transcript.truncated";
      readonly entryCount: number;
      /** Rewind saga 的稳定幂等关联键。 */
      readonly operationId: string;
    })
  | (TranscriptEventBase & {
      readonly type: "transcript.cleared";
    });

type DurableTranscriptEventType =
  | "entry.appended"
  | "assistant.stream.started"
  | "assistant.stream.completed"
  | "assistant.stream.interrupted"
  | "assistant.response.suppressed"
  | "tool.started"
  | "tool.approval.requested"
  | "subagent.activity.updated"
  | "subagent.activity.archived"
  | "transcript.truncated";

export type DurableTranscriptEvent = Extract<
  TranscriptEvent,
  { readonly type: DurableTranscriptEventType }
>;

const TRANSCRIPT_EVENT_TYPES = new Set<TranscriptEvent["type"]>([
  "entry.appended",
  "assistant.stream.started",
  "assistant.stream.delta",
  "assistant.stream.completed",
  "assistant.stream.interrupted",
  "assistant.response.suppressed",
  "tool.started",
  "tool.approval.requested",
  "tool.output",
  "tool.output.truncated",
  "tool.completed",
  "subagent.activity.updated",
  "subagent.trace.recorded",
  "subagent.activity.claimed",
  "subagent.activity.archived",
  "phase.changed",
  "transcript.truncated",
  "transcript.cleared",
]);

/** Fail-closed structural guard used when transcript facts are read from RuntimeEvent logs. */
export function assertTranscriptEvent(value: unknown): asserts value is TranscriptEvent {
  if (!isTranscriptRecord(value)) throw new Error("Transcript event must be an object");
  transcriptString(value, "eventId");
  transcriptPositiveInteger(value, "sequence");
  transcriptFiniteNumber(value, "createdAt");
  const type = value["type"];
  if (typeof type !== "string" || !TRANSCRIPT_EVENT_TYPES.has(type as TranscriptEvent["type"])) {
    throw new Error("Transcript event type is invalid");
  }

  switch (type as TranscriptEvent["type"]) {
    case "entry.appended":
      transcriptExactKeys(value, "eventId", "sequence", "createdAt", "type", "entryId", "entry");
      transcriptString(value, "entryId");
      transcriptRecord(value, "entry");
      transcriptEntry(value["entry"] as Record<string, unknown>);
      return;
    case "assistant.stream.started":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "delta",
        "entryKind",
      );
      transcriptStrings(value, "entryId", "streamId", "delta", "entryKind");
      if (value["entryKind"] !== "assistant" && value["entryKind"] !== "thinking") {
        throw new Error("Transcript stream entryKind is invalid");
      }
      return;
    case "assistant.stream.delta":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "delta",
      );
      transcriptStrings(value, "entryId", "streamId", "delta");
      return;
    case "assistant.stream.completed":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "content",
      );
      transcriptStrings(value, "entryId", "streamId");
      transcriptOptionalString(value, "content");
      return;
    case "assistant.stream.interrupted":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "streamId",
        "reason",
        "content",
      );
      transcriptStrings(value, "entryId", "streamId", "reason");
      transcriptEnum(value, "reason", ["new-request", "clear", "truncate", "abort"]);
      transcriptOptionalString(value, "content");
      return;
    case "assistant.response.suppressed":
      transcriptExactKeys(value, "eventId", "sequence", "createdAt", "type", "entryId", "reason");
      transcriptStrings(value, "entryId", "reason");
      transcriptEnum(value, "reason", [
        "required-delegation",
        "delegation-first-retry",
        "explore-synthesis-retry",
      ]);
      return;
    case "tool.started":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "toolCallId",
        "providerCallId",
        "name",
        "args",
      );
      transcriptStrings(value, "entryId", "toolCallId", "providerCallId", "name", "args");
      return;
    case "tool.approval.requested":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "toolCallId",
        "summary",
      );
      transcriptStrings(value, "toolCallId", "summary");
      return;
    case "tool.output":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "toolCallId",
        "segment",
      );
      transcriptString(value, "toolCallId");
      transcriptRecord(value, "segment");
      transcriptToolOutputSegment(value["segment"] as Record<string, unknown>);
      return;
    case "tool.output.truncated":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "toolCallId",
        "droppedChars",
      );
      transcriptString(value, "toolCallId");
      transcriptNonNegativeInteger(value, "droppedChars");
      return;
    case "tool.completed":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "toolCallId",
        "summary",
        "result",
      );
      transcriptStrings(value, "toolCallId", "summary");
      transcriptToolResultEnvelope(value["result"]);
      return;
    case "subagent.activity.updated":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryId",
        "activityId",
        "activity",
      );
      transcriptStrings(value, "entryId", "activityId");
      transcriptRecord(value, "activity");
      transcriptSubagentActivity(value["activity"] as Record<string, unknown>);
      return;
    case "subagent.trace.recorded":
      transcriptExactKeys(value, "eventId", "sequence", "createdAt", "type", "trace");
      transcriptRecord(value, "trace");
      transcriptSubagentTrace(value["trace"] as Record<string, unknown>);
      return;
    case "subagent.activity.claimed":
    case "subagent.activity.archived":
      transcriptExactKeys(value, "eventId", "sequence", "createdAt", "type", "activityId");
      transcriptString(value, "activityId");
      return;
    case "phase.changed":
      transcriptExactKeys(value, "eventId", "sequence", "createdAt", "type", "phaseId", "mode");
      transcriptStrings(value, "phaseId", "mode");
      transcriptEnum(value, "mode", ["idle", "requesting", "thinking", "tool-use", "responding"]);
      return;
    case "transcript.truncated":
      transcriptExactKeys(
        value,
        "eventId",
        "sequence",
        "createdAt",
        "type",
        "entryCount",
        "operationId",
      );
      transcriptNonNegativeInteger(value, "entryCount");
      transcriptString(value, "operationId");
      return;
    case "transcript.cleared":
      transcriptExactKeys(value, "eventId", "sequence", "createdAt", "type");
      return;
  }
}

/** True only for presentation facts allowed in the durable Runtime transcript. */
export function isDurableTranscriptEvent(event: TranscriptEvent): event is DurableTranscriptEvent {
  switch (event.type) {
    case "entry.appended":
      return event.entry.kind !== "thinking" || Boolean(event.entry.content?.trim());
    case "assistant.stream.started":
    case "assistant.stream.completed":
    case "assistant.stream.interrupted":
    case "assistant.response.suppressed":
    case "tool.started":
    case "tool.approval.requested":
    case "subagent.activity.archived":
    case "transcript.truncated":
      return true;
    case "subagent.activity.updated":
      return isTerminalSubagentStatus(event.activity.status);
    case "assistant.stream.delta":
    case "tool.output":
    case "tool.output.truncated":
    case "tool.completed":
    case "subagent.trace.recorded":
    case "subagent.activity.claimed":
    case "transcript.cleared":
    case "phase.changed":
      return false;
  }
}

/** RuntimeEvent decode boundary: presentation-only events fail closed. */
export function assertDurableTranscriptEvent(
  value: unknown,
): asserts value is DurableTranscriptEvent {
  assertTranscriptEvent(value);
  if (!isDurableTranscriptEvent(value)) {
    throw new Error(`Transcript event ${value.type} is presentation-only`);
  }
}

function transcriptStrings(value: Record<string, unknown>, ...keys: string[]): void {
  for (const key of keys) transcriptString(value, key);
}

function transcriptEntry(value: Record<string, unknown>): void {
  transcriptString(value, "kind");
  switch (value["kind"]) {
    case "logo":
      transcriptExactKeys(
        value,
        "kind",
        "model",
        "cwd",
        "sessionMode",
        "permissionMode",
        "mcpSummary",
        "taskSummary",
      );
      for (const key of [
        "model",
        "cwd",
        "sessionMode",
        "permissionMode",
        "mcpSummary",
        "taskSummary",
      ]) {
        transcriptOptionalString(value, key);
      }
      return;
    case "user":
    case "system":
    case "assistant":
      transcriptExactKeys(value, "kind", "content");
      transcriptString(value, "content");
      return;
    case "thinking":
      transcriptExactKeys(value, "kind", "content");
      transcriptOptionalString(value, "content");
      return;
    case "skill":
      transcriptExactKeys(value, "kind", "name", "args", "trigger");
      transcriptStrings(value, "name", "args", "trigger");
      transcriptEnum(value, "trigger", ["user-slash", "model-tool"]);
      return;
    case "error":
      transcriptExactKeys(value, "kind", "message", "retryable", "action");
      transcriptString(value, "message");
      transcriptOptionalBoolean(value, "retryable");
      transcriptOptionalString(value, "action");
      return;
    case "tool":
      transcriptExactKeys(value, "kind", "name", "args", "status", "summary");
      transcriptStrings(value, "name", "args", "status");
      transcriptEnum(value, "status", [
        "queued",
        "running",
        "approval",
        "success",
        "error",
        "denied",
      ]);
      transcriptOptionalString(value, "summary");
      return;
    case "plan":
      transcriptExactKeys(value, "kind", "title", "detail", "state");
      transcriptString(value, "title");
      transcriptOptionalString(value, "detail");
      transcriptOptionalEnum(value, "state", ["waiting", "active", "done", "failed"]);
      return;
    case "approval":
    case "prompt":
    case "changes":
      transcriptExactKeys(value, "kind", "title", "detail", "state", "data");
      transcriptString(value, "title");
      transcriptOptionalString(value, "detail");
      transcriptOptionalString(value, "state");
      transcriptOptionalRecord(value, "data");
      return;
    case "run-boundary":
      transcriptExactKeys(value, "kind", "runId", "status", "startedAt", "finishedAt", "error");
      transcriptStrings(value, "runId", "status");
      transcriptEnum(value, "status", [
        "queued",
        "running",
        "pause_requested",
        "paused",
        "cancelling",
        "cancelled",
        "failed",
        "succeeded",
      ]);
      transcriptFiniteNumber(value, "startedAt");
      transcriptOptionalFiniteNumber(value, "finishedAt");
      transcriptOptionalString(value, "error");
      return;
    case "subagent-activity":
      transcriptExactKeys(
        value,
        "kind",
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
      );
      transcriptSubagentActivity(value);
      return;
    default:
      throw new Error("Transcript entry kind is invalid");
  }
}

function transcriptString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Transcript event ${key} must be a non-empty string`);
  }
}

function transcriptOptionalString(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== "string") {
    throw new Error(`Transcript event ${key} must be a string`);
  }
}

function transcriptOptionalBoolean(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && typeof value[key] !== "boolean") {
    throw new Error(`Transcript event ${key} must be boolean`);
  }
}

function transcriptFiniteNumber(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
    throw new Error(`Transcript event ${key} must be finite`);
  }
}

function transcriptOptionalFiniteNumber(value: Record<string, unknown>, key: string): void {
  if (
    value[key] !== undefined &&
    (typeof value[key] !== "number" || !Number.isFinite(value[key]))
  ) {
    throw new Error(`Transcript event ${key} must be finite`);
  }
}

function transcriptPositiveInteger(value: Record<string, unknown>, key: string): void {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
    throw new Error(`Transcript event ${key} must be a positive integer`);
  }
}

function transcriptNonNegativeInteger(value: Record<string, unknown>, key: string): void {
  if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
    throw new Error(`Transcript event ${key} must be a non-negative integer`);
  }
}

function transcriptBoolean(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "boolean") throw new Error(`Transcript event ${key} must be boolean`);
}

function transcriptRecord(value: Record<string, unknown>, key: string): void {
  if (!isTranscriptRecord(value[key])) throw new Error(`Transcript event ${key} must be an object`);
}

function transcriptOptionalRecord(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined && !isTranscriptRecord(value[key])) {
    throw new Error(`Transcript event ${key} must be an object`);
  }
}

function transcriptEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): void {
  if (typeof value[key] !== "string" || !allowed.includes(value[key])) {
    throw new Error(`Transcript event ${key} is invalid`);
  }
}

function transcriptOptionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): void {
  if (value[key] !== undefined) transcriptEnum(value, key, allowed);
}

function transcriptExactKeys(value: Record<string, unknown>, ...allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (extra !== undefined) {
    throw new Error(`Transcript event contains unsupported field ${extra}`);
  }
}

function transcriptSubagentActivity(value: Record<string, unknown>): void {
  transcriptExactKeys(
    value,
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
  );
  transcriptStrings(value, "task", "status", "mode", "completionPolicy");
  transcriptEnum(value, "status", [
    "queued",
    "running",
    "completed",
    "partial",
    "failed",
    "timed_out",
    "cancelled",
  ]);
  transcriptEnum(value, "mode", ["explore", "worker"]);
  transcriptEnum(value, "completionPolicy", ["required", "optional", "detached"]);
  for (const key of [
    "agentName",
    "currentAction",
    "summary",
    "requestedModelRoute",
    "resolvedModelRoute",
    "thinkingEffort",
  ]) {
    transcriptOptionalString(value, key);
  }
  transcriptOptionalEnum(value, "modelSelectionSource", ["ephemeral", "profile", "parent"]);
}

function transcriptToolOutputSegment(value: Record<string, unknown>): void {
  transcriptExactKeys(value, "content", "runs");
  if (typeof value["content"] !== "string" || !Array.isArray(value["runs"])) {
    throw new Error("Transcript tool output segment is invalid");
  }
  for (const run of value["runs"]) {
    if (!isTranscriptRecord(run)) {
      throw new Error("Transcript tool output run is invalid");
    }
    transcriptExactKeys(run, "stream", "length");
    transcriptEnum(run, "stream", ["stdout", "stderr"]);
    transcriptNonNegativeInteger(run, "length");
  }
}

function isTranscriptRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type TranscriptEventDraftWithIdentities = DistributiveOmit<
  TranscriptEvent,
  keyof TranscriptEventBase
>;
type TranscriptToolStartedDraft = Extract<
  TranscriptEventDraftWithIdentities,
  { type: "tool.started" }
>;

/** 常规 live 事件由 store 分配 toolCallId；canonical Runtime start 可注入稳定 ID。 */
export type TranscriptEventDraft =
  | Exclude<TranscriptEventDraftWithIdentities, TranscriptToolStartedDraft>
  | (Omit<TranscriptToolStartedDraft, "toolCallId"> & { readonly toolCallId?: string });

export interface TranscriptEventStoreOptions {
  /** 测试、回放或水合时可注入可预测 ID。 */
  idFactory?: (scope: TranscriptIdentityScope) => string;
  now?: () => number;
  /** 从持久化日志水合；原有 eventId / sequence 保持不变。 */
  initialEvents?: readonly TranscriptEvent[];
  /** 当前事件段最大长度；达到后投影折叠为新 checkpoint。 */
  maxSegmentEvents?: number;
  /** 事件追加后的只读通知；用于将语义事件接入 durable sink。 */
  onAppend?: (event: TranscriptEvent, projection: TranscriptProjection) => void;
}

export type TranscriptIdentityScope = "event" | "entry" | "phase" | "stream" | "tool";

/**
 * 分段 append-only 内存事件库。
 *
 * append 时同步执行纯 reducer，因此常规更新不需要每次重放全部历史；
 * replay() 从 checkpoint 只重放当前 segment。checkpoint + events
 * 是可持久化的最小确定性回放单元，事件日志不会永久无界增长。
 */
export class TranscriptEventStore {
  private readonly events: TranscriptEvent[] = [];
  private checkpoint: TranscriptProjection;
  private projection: TranscriptProjection;
  private readonly idFactory: (scope: TranscriptIdentityScope) => string;
  private readonly now: () => number;
  private readonly maxSegmentEvents: number;
  private readonly usedEventIds = new Set<string>();
  private readonly usedEntryIds = new Set<string>();
  private readonly usedPhaseIds = new Set<string>();
  private readonly usedStreamIds = new Set<string>();
  private readonly usedToolIds = new Set<string>();
  private readonly appendListeners = new Set<
    (event: TranscriptEvent, projection: TranscriptProjection) => void
  >();

  constructor(options: TranscriptEventStoreOptions = {}) {
    this.idFactory = options.idFactory ?? createTranscriptIdFactory();
    this.now = options.now ?? Date.now;
    this.maxSegmentEvents = normalizeSegmentLimit(options.maxSegmentEvents);
    if (options.onAppend) this.appendListeners.add(options.onAppend);
    this.checkpoint = initialTranscriptProjection();
    this.projection = this.checkpoint;
    this.rebuildIdentityReservations();
    const initialEvents = options.initialEvents ?? [];
    for (const event of initialEvents) this.loadInitialEvent(event);
    if (this.events.length >= this.maxSegmentEvents) this.rollover();
  }

  createId(scope: Exclude<TranscriptIdentityScope, "event">): string {
    return this.idFactory(scope);
  }

  append(draft: TranscriptEventDraft): TranscriptEvent {
    const identifiedDraft =
      draft.type === "tool.started" && draft.toolCallId === undefined
        ? { ...draft, toolCallId: this.createId("tool") }
        : draft;
    const event = freezeTranscriptEvent({
      ...identifiedDraft,
      eventId: this.idFactory("event"),
      sequence: this.projection.sequence + 1,
      createdAt: this.now(),
    } as TranscriptEvent);
    this.assertEventIdentitiesAvailable(event);
    const nextProjection = reduceTranscriptEvent(this.projection, event);
    this.reserveEventIdentities(event);
    this.events.push(event);
    this.projection = nextProjection;
    if (
      this.events.length >= this.maxSegmentEvents ||
      event.type === "transcript.cleared" ||
      event.type === "transcript.truncated" ||
      event.type === "tool.completed"
    ) {
      this.rollover();
    }
    for (const listener of this.appendListeners) listener(event, this.projection);
    return event;
  }

  /** 注册追加通知；返回取消订阅函数。 */
  addAppendListener(
    listener: (event: TranscriptEvent, projection: TranscriptProjection) => void,
  ): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  /** 在空 store 上一次性加载持久化事件；不会触发追加监听。 */
  loadInitialEvents(events: readonly TranscriptEvent[]): void {
    if (events.length === 0) return;
    if (this.projection.sequence !== 0 || this.events.length > 0) {
      if (events.at(-1)?.sequence === this.projection.sequence) return;
      throw new Error("TranscriptEventStore can hydrate initial events only once");
    }
    for (const event of events) this.loadInitialEvent(event);
    if (this.events.length >= this.maxSegmentEvents) this.rollover();
  }

  /** Replace the local projection from one authoritative hydration snapshot. */
  replaceEvents(events: readonly TranscriptEvent[]): void {
    this.events.length = 0;
    this.checkpoint = initialTranscriptProjection();
    this.projection = this.checkpoint;
    this.rebuildIdentityReservations();
    for (const event of events) this.loadInitialEvent(event);
    if (this.events.length >= this.maxSegmentEvents) this.rollover();
  }

  /** 只返回 checkpoint 之后的当前有界事件段。 */
  getEvents(): readonly TranscriptEvent[] {
    return Object.freeze([...this.events]);
  }

  getProjection(): TranscriptProjection {
    return this.projection;
  }

  get size(): number {
    return this.projection.sequence;
  }

  get segmentSize(): number {
    return this.events.length;
  }

  replay(): TranscriptProjection {
    return projectTranscriptEvents(this.events, this.checkpoint);
  }

  private loadInitialEvent(input: TranscriptEvent): void {
    if (input.sequence !== this.projection.sequence + 1) {
      throw new Error(
        `Invalid Transcript event sequence during hydration: ${input.sequence}, expected ${this.projection.sequence + 1}`,
      );
    }
    const event = freezeTranscriptEvent(input);
    this.assertEventIdentitiesAvailable(event);
    const nextProjection = reduceTranscriptEvent(this.projection, event);
    this.reserveEventIdentities(event);
    this.events.push(event);
    this.projection = nextProjection;
  }

  private rollover(): void {
    this.checkpoint = compactProjectionForCheckpoint(this.projection);
    this.projection = this.checkpoint;
    this.events.length = 0;
    this.rebuildIdentityReservations();
  }

  private rebuildIdentityReservations(): void {
    this.usedEventIds.clear();
    this.usedEntryIds.clear();
    this.usedPhaseIds.clear();
    this.usedStreamIds.clear();
    this.usedToolIds.clear();
    if (this.projection.lastEventId) this.usedEventIds.add(this.projection.lastEventId);
    this.usedPhaseIds.add(this.projection.phase.id);
    for (const entry of this.projection.entries) this.usedEntryIds.add(entry.id);
    for (const stream of Object.values(this.projection.streams)) {
      this.usedStreamIds.add(stream.id);
    }
    for (const tool of Object.values(this.projection.toolCalls)) this.usedToolIds.add(tool.id);
  }

  private assertEventIdentitiesAvailable(event: TranscriptEvent): void {
    assertUnique(this.usedEventIds, event.eventId, "event");
    switch (event.type) {
      case "entry.appended":
        assertUnique(this.usedEntryIds, event.entryId, "entry");
        break;
      case "assistant.stream.started":
        assertUnique(this.usedEntryIds, event.entryId, "entry");
        assertUnique(this.usedStreamIds, event.streamId, "stream");
        break;
      case "tool.started":
        assertUnique(this.usedEntryIds, event.entryId, "entry");
        assertUnique(this.usedToolIds, event.toolCallId, "tool call");
        break;
      case "phase.changed":
        assertUnique(this.usedPhaseIds, event.phaseId, "phase");
        break;
      case "subagent.activity.updated":
        if (
          !this.projection.entries.some((entry) => entry.subagentActivityId === event.activityId)
        ) {
          assertUnique(this.usedEntryIds, event.entryId, "entry");
        }
        break;
      case "subagent.trace.recorded":
      case "subagent.activity.claimed":
      case "subagent.activity.archived":
      case "assistant.stream.delta":
      case "assistant.stream.completed":
      case "assistant.stream.interrupted":
      case "assistant.response.suppressed":
      case "tool.approval.requested":
      case "tool.output":
      case "tool.output.truncated":
      case "tool.completed":
      case "transcript.truncated":
      case "transcript.cleared":
        break;
    }
  }

  private reserveEventIdentities(event: TranscriptEvent): void {
    this.usedEventIds.add(event.eventId);
    switch (event.type) {
      case "entry.appended":
        this.usedEntryIds.add(event.entryId);
        break;
      case "assistant.stream.started":
        this.usedEntryIds.add(event.entryId);
        this.usedStreamIds.add(event.streamId);
        break;
      case "tool.started":
        this.usedEntryIds.add(event.entryId);
        this.usedToolIds.add(event.toolCallId);
        break;
      case "phase.changed":
        this.usedPhaseIds.add(event.phaseId);
        break;
      case "subagent.activity.updated":
        if (
          !this.projection.entries.some((entry) => entry.subagentActivityId === event.activityId)
        ) {
          this.usedEntryIds.add(event.entryId);
        }
        break;
      case "subagent.trace.recorded":
      case "subagent.activity.claimed":
      case "subagent.activity.archived":
      case "assistant.stream.delta":
      case "assistant.stream.completed":
      case "assistant.stream.interrupted":
      case "assistant.response.suppressed":
      case "tool.approval.requested":
      case "tool.output":
      case "tool.output.truncated":
      case "tool.completed":
      case "transcript.truncated":
      case "transcript.cleared":
        break;
    }
  }
}

export function initialTranscriptProjection(): TranscriptProjection {
  return freezeProjection({
    entries: [],
    phase: { id: "phase:initial", mode: "idle" },
    streams: {},
    toolCalls: {},
    subagents: {},
    sequence: 0,
  });
}

/** 从事件历史确定性生成完整 transcript 投影。 */
export function projectTranscriptEvents(
  events: readonly TranscriptEvent[],
  checkpoint: TranscriptProjection = initialTranscriptProjection(),
): TranscriptProjection {
  return events.reduce(reduceTranscriptEvent, checkpoint);
}

/** 纯 reducer：不修改旧 projection 或其 entry 对象。 */
export function reduceTranscriptEvent(
  state: TranscriptProjection,
  event: TranscriptEvent,
): TranscriptProjection {
  if (event.sequence !== state.sequence + 1) {
    throw new Error(
      `Transcript event sequence mismatch: ${event.sequence}, expected ${state.sequence + 1}`,
    );
  }
  let entries = state.entries;
  let phase = state.phase;
  let streams = state.streams;
  let toolCalls = state.toolCalls;
  let subagents = state.subagents;

  switch (event.type) {
    case "entry.appended":
      assertNewEntryId(entries, event.entryId);
      entries = [...entries, projectedEntry(event.entryId, event.entry)];
      break;

    case "assistant.stream.started": {
      assertNewEntryId(entries, event.entryId);
      assertNewIdentity(streams, event.streamId, "stream");
      const entryKind = event.entryKind;
      entries = [
        ...entries,
        projectedEntry(
          event.entryId,
          { kind: entryKind, content: event.delta },
          {
            streamId: event.streamId,
          },
        ),
      ];
      streams = {
        ...streams,
        [event.streamId]: Object.freeze({
          id: event.streamId,
          entryId: event.entryId,
          status: "streaming" as const,
        }),
      };
      break;
    }

    case "assistant.stream.delta": {
      const stream = streams[event.streamId];
      assertStreamTarget(stream, event.entryId, "streaming");
      entries = replaceProjectedEntry(entries, event.entryId, (current) => {
        if (current.entry.kind !== "assistant" && current.entry.kind !== "thinking") {
          throw new Error(`Transcript stream ${event.streamId} points to a non-text entry`);
        }
        const entryKind = current.entry.kind;
        return projectedEntry(
          current.id,
          { kind: entryKind, content: current.entry.content + event.delta },
          { streamId: event.streamId },
        );
      });
      break;
    }

    case "assistant.stream.completed": {
      const stream = streams[event.streamId];
      assertStreamTarget(stream, event.entryId, "streaming");
      const completedContent = event.content;
      if (completedContent !== undefined) {
        entries = replaceProjectedEntry(entries, event.entryId, (current) => {
          if (current.entry.kind !== "assistant" && current.entry.kind !== "thinking") {
            throw new Error(`Transcript stream ${event.streamId} points to a non-text entry`);
          }
          return projectedEntry(
            current.id,
            { kind: current.entry.kind, content: completedContent },
            { streamId: event.streamId },
          );
        });
      }
      streams = {
        ...streams,
        [event.streamId]: Object.freeze({ ...stream, status: "completed" as const }),
      };
      break;
    }

    case "assistant.stream.interrupted": {
      const stream = streams[event.streamId];
      assertStreamTarget(stream, event.entryId, "streaming");
      if (event.content !== undefined) {
        entries = replaceProjectedEntry(entries, event.entryId, (current) => {
          if (current.entry.kind !== "assistant" && current.entry.kind !== "thinking") {
            throw new Error(`Transcript stream ${event.streamId} points to a non-text entry`);
          }
          return projectedEntry(
            current.id,
            { kind: current.entry.kind, content: event.content! },
            { streamId: event.streamId },
          );
        });
      }
      streams = {
        ...streams,
        [event.streamId]: Object.freeze({ ...stream, status: "interrupted" as const }),
      };
      break;
    }

    case "assistant.response.suppressed": {
      const target = entries.find((entry) => entry.id === event.entryId);
      if (!target) throw new Error(`Unknown Transcript assistant entry ID: ${event.entryId}`);
      if (target.entry.kind !== "assistant") {
        throw new Error(`Transcript entry ${event.entryId} is not an assistant response`);
      }
      entries = entries.filter((entry) => entry.id !== event.entryId);
      ({ streams, toolCalls } = retainEntryIndexes(entries, streams, toolCalls));
      break;
    }

    case "tool.started":
      assertNewEntryId(entries, event.entryId);
      assertNewIdentity(toolCalls, event.toolCallId, "tool call");
      entries = [
        ...entries,
        projectedEntry(
          event.entryId,
          { kind: "tool", name: event.name, args: event.args, status: "running" },
          { toolCallId: event.toolCallId },
        ),
      ];
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({
          id: event.toolCallId,
          providerCallId: event.providerCallId,
          entryId: event.entryId,
          name: event.name,
          args: event.args,
          status: "running" as const,
          output: "",
          outputSegments: Object.freeze([]),
          outputChars: 0,
          droppedOutputChars: 0,
          outputTruncated: false,
        }),
      };
      break;

    case "tool.approval.requested": {
      const tool = requirePendingTool(toolCalls, event.toolCallId);
      entries = replaceProjectedEntry(entries, tool.entryId, (current) => {
        if (current.entry.kind !== "tool") {
          throw new Error(`Transcript tool call ${event.toolCallId} points to a non-tool entry`);
        }
        return projectedEntry(
          current.id,
          { ...current.entry, status: "approval", summary: event.summary },
          { toolCallId: event.toolCallId },
        );
      });
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({ ...tool, status: "approval" as const }),
      };
      break;
    }

    case "tool.output": {
      const tool = requirePendingTool(toolCalls, event.toolCallId);
      const segment = normalizeToolOutputSegment(event);
      if (segment.content.length === 0) break;
      if (
        tool.outputChars + segment.content.length >
        TRANSCRIPT_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS
      ) {
        throw new Error(
          `Transcript tool call ${event.toolCallId} output exceeds the projection limit`,
        );
      }
      const output = tool.output + segment.content;
      const outputSegments = Object.freeze([...tool.outputSegments, segment]);
      entries = replaceProjectedEntry(entries, tool.entryId, (current) => {
        if (current.entry.kind !== "tool") {
          throw new Error(`Transcript tool call ${event.toolCallId} points to a non-tool entry`);
        }
        return projectedEntry(
          current.id,
          { ...current.entry, summary: output },
          { toolCallId: event.toolCallId },
        );
      });
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({
          ...tool,
          output,
          outputSegments,
          outputChars: tool.outputChars + segment.content.length,
        }),
      };
      break;
    }

    case "tool.output.truncated": {
      const tool = requirePendingTool(toolCalls, event.toolCallId);
      if (tool.outputTruncated) {
        throw new Error(`Transcript tool call ${event.toolCallId} output is already truncated`);
      }
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({
          ...tool,
          droppedOutputChars: event.droppedChars,
          outputTruncated: true,
        }),
      };
      break;
    }

    case "tool.completed": {
      const tool = requirePendingTool(toolCalls, event.toolCallId);
      const envelope = cloneToolResultEnvelope(event.result);
      const canonicalStatus = transcriptToolStatusFromEnvelope(envelope);
      if (envelope.toolName !== tool.name || envelope.toolCallId !== tool.providerCallId) {
        throw new Error(
          `Transcript tool completion ${event.toolCallId} does not match its canonical envelope`,
        );
      }
      const result =
        envelope.evidence === undefined &&
        envelope.projection.mode === "full" &&
        !envelope.projection.truncated &&
        !envelope.deliveryTruncated
          ? envelope.projection.text
          : undefined;
      const resultAvailability =
        envelope.evidence !== undefined
          ? ("evidence" as const)
          : result !== undefined
            ? ("inline" as const)
            : ("unavailable" as const);
      const displayResult =
        resultAvailability === "unavailable"
          ? unavailableResultSummary(event.summary)
          : event.summary;
      entries = replaceProjectedEntry(entries, tool.entryId, (current) => {
        if (current.entry.kind !== "tool") {
          throw new Error(`Transcript tool call ${event.toolCallId} points to a non-tool entry`);
        }
        return projectedEntry(
          current.id,
          { ...current.entry, status: canonicalStatus, summary: displayResult },
          { toolCallId: event.toolCallId },
        );
      });
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({
          ...tool,
          status: canonicalStatus,
          output: "",
          outputSegments: Object.freeze([]),
          ...(result !== undefined ? { result } : {}),
          summary: displayResult,
          resultEnvelope: envelope,
          resultAvailability,
        }),
      };
      break;
    }

    case "subagent.activity.updated": {
      const existing = entries.find((entry) => entry.subagentActivityId === event.activityId);
      const nextEntry: TranscriptEntry = { kind: "subagent-activity", ...event.activity };
      if (existing === undefined) {
        assertNewEntryId(entries, event.entryId);
        entries = [
          ...entries,
          projectedEntry(event.entryId, nextEntry, { subagentActivityId: event.activityId }),
        ];
      } else {
        if (existing.id !== event.entryId) {
          throw new Error(
            `Transcript subagent activity ${event.activityId} entry mismatch: ${existing.id} != ${event.entryId}`,
          );
        }
        entries = replaceProjectedEntry(entries, existing.id, () =>
          projectedEntry(existing.id, nextEntry, { subagentActivityId: event.activityId }),
        );
      }
      const previous = subagents[event.activityId];
      const lifecycle = subagentLifecycleForStatus(event.activity.status, previous?.lifecycle);
      subagents = {
        ...subagents,
        [event.activityId]: freezeSubagentProjection({
          activityId: event.activityId,
          entryId: event.entryId,
          activity: event.activity,
          timeline: previous?.timeline ?? [],
          lifecycle,
        }),
      };
      break;
    }

    case "subagent.trace.recorded": {
      const current = subagents[event.trace.activityId];
      if (!current) {
        throw new Error(`Unknown Transcript subagent activity: ${event.trace.activityId}`);
      }
      const timeline = reduceSubagentTrace(current.timeline, event.trace, event.createdAt);
      subagents = {
        ...subagents,
        [event.trace.activityId]: freezeSubagentProjection({ ...current, timeline }),
      };
      break;
    }

    case "subagent.activity.claimed": {
      const current = subagents[event.activityId];
      if (!current) throw new Error(`Unknown Transcript subagent activity: ${event.activityId}`);
      if (current.lifecycle === "active") {
        throw new Error(`Cannot claim active Transcript subagent activity: ${event.activityId}`);
      }
      if (current.lifecycle !== "archived") {
        subagents = {
          ...subagents,
          [event.activityId]: freezeSubagentProjection({
            ...current,
            lifecycle: "terminal_claimed",
          }),
        };
      }
      break;
    }

    case "subagent.activity.archived": {
      const current = subagents[event.activityId];
      if (!current) throw new Error(`Unknown Transcript subagent activity: ${event.activityId}`);
      if (current.lifecycle === "active") {
        throw new Error(`Cannot archive active Transcript subagent activity: ${event.activityId}`);
      }
      subagents = {
        ...subagents,
        [event.activityId]: freezeSubagentProjection({ ...current, lifecycle: "archived" }),
      };
      break;
    }

    case "phase.changed":
      phase = Object.freeze({ id: event.phaseId, mode: event.mode });
      break;

    case "transcript.truncated": {
      const entryCount = Math.min(Math.max(0, event.entryCount), entries.length);
      entries = entries.slice(0, entryCount);
      ({ streams, toolCalls } = retainEntryIndexes(entries, streams, toolCalls));
      subagents = retainSubagentIndexes(entries, subagents);
      break;
    }

    case "transcript.cleared":
      entries = [];
      streams = {};
      toolCalls = {};
      subagents = {};
      break;
  }

  return freezeProjection({
    entries,
    phase,
    streams,
    toolCalls,
    subagents,
    lastEventId: event.eventId,
    sequence: event.sequence,
  });
}

function reduceSubagentTrace(
  timeline: readonly TranscriptSubagentTraceItem[],
  trace: SubagentTraceEvent,
  createdAt: number,
): readonly TranscriptSubagentTraceItem[] {
  if (trace.type === "tool.completed") {
    const index = timeline.findIndex((item) => item.id === trace.traceId);
    if (index < 0) throw new Error(`Unknown Transcript subagent trace ID: ${trace.traceId}`);
    const current = timeline[index]!;
    if (current.kind !== "tool" || current.status !== "running") {
      throw new Error(`Transcript subagent trace ${trace.traceId} is not a running tool`);
    }
    const envelope = cloneToolResultEnvelope(trace.result);
    const result = envelope.projection.text.slice(0, TRANSCRIPT_SUBAGENT_TOOL_RESULT_LIMIT_CHARS);
    const next = [...timeline];
    next[index] = Object.freeze({
      ...current,
      status: envelope.status === "succeeded" ? "success" : "error",
      result,
      ...(envelope.projection.truncated ||
      envelope.deliveryTruncated ||
      result.length < envelope.projection.text.length
        ? { resultTruncated: true }
        : {}),
      completedAt: createdAt,
    });
    return boundSubagentTimeline(next);
  }

  if (timeline.some((item) => item.id === trace.traceId)) {
    throw new Error(`Duplicate Transcript subagent trace ID: ${trace.traceId}`);
  }
  const item: TranscriptSubagentTraceItem =
    trace.type === "thinking"
      ? Object.freeze({ id: trace.traceId, kind: "thinking", createdAt })
      : trace.type === "message"
        ? Object.freeze({
            id: trace.traceId,
            kind: "message",
            content: trace.content.slice(0, TRANSCRIPT_SUBAGENT_MESSAGE_LIMIT_CHARS),
            createdAt,
          })
        : Object.freeze({
            id: trace.traceId,
            kind: "tool",
            name: trace.name,
            args: trace.args.slice(0, TRANSCRIPT_SUBAGENT_TOOL_ARGS_LIMIT_CHARS),
            status: "running",
            createdAt,
          });
  return boundSubagentTimeline([...timeline, item]);
}

function boundSubagentTimeline(
  timeline: readonly TranscriptSubagentTraceItem[],
): readonly TranscriptSubagentTraceItem[] {
  if (timeline.length <= TRANSCRIPT_SUBAGENT_TRACE_MAX_ITEMS) return Object.freeze([...timeline]);
  const removable = timeline.findIndex((item) => item.kind !== "tool" || item.status !== "running");
  // 未完成工具还需要用 traceId 原位配对，宁可临时超额也不驱逐。
  if (removable < 0) return Object.freeze([...timeline]);
  const index = removable;
  return Object.freeze([...timeline.slice(0, index), ...timeline.slice(index + 1)]);
}

function freezeSubagentProjection(
  projection: TranscriptSubagentProjection,
): TranscriptSubagentProjection {
  return Object.freeze({
    ...projection,
    activity: Object.freeze({ ...projection.activity }),
    timeline: Object.freeze([...projection.timeline]),
  });
}

function subagentLifecycleForStatus(
  status: SubagentActivityEvent["status"],
  previous?: TranscriptSubagentLifecycle,
): TranscriptSubagentLifecycle {
  if (status === "queued" || status === "running") return "active";
  return previous === "archived" || previous === "terminal_claimed"
    ? previous
    : "terminal_unconsumed";
}

function retainSubagentIndexes(
  entries: readonly TranscriptProjectedEntry[],
  subagents: Readonly<Record<string, TranscriptSubagentProjection>>,
): Readonly<Record<string, TranscriptSubagentProjection>> {
  const retained = new Set(
    entries.flatMap((entry) =>
      entry.subagentActivityId === undefined ? [] : [entry.subagentActivityId],
    ),
  );
  return Object.fromEntries(Object.entries(subagents).filter(([id]) => retained.has(id)));
}

function projectedEntry(
  id: string,
  entry: TranscriptEntryData,
  metadata: { streamId?: string; toolCallId?: string; subagentActivityId?: string } = {},
): TranscriptProjectedEntry {
  return Object.freeze({
    id,
    entry: Object.freeze({ ...entry }) as TranscriptEntry,
    ...(metadata.streamId !== undefined ? { streamId: metadata.streamId } : {}),
    ...(metadata.toolCallId !== undefined ? { toolCallId: metadata.toolCallId } : {}),
    ...(metadata.subagentActivityId !== undefined
      ? { subagentActivityId: metadata.subagentActivityId }
      : {}),
  });
}

function replaceProjectedEntry(
  entries: readonly TranscriptProjectedEntry[],
  entryId: string,
  update: (entry: TranscriptProjectedEntry) => TranscriptProjectedEntry,
): readonly TranscriptProjectedEntry[] {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new Error(`Unknown Transcript entry ID: ${entryId}`);
  const next = [...entries];
  next[index] = update(entries[index]!);
  return next;
}

function assertNewEntryId(entries: readonly TranscriptProjectedEntry[], entryId: string): void {
  if (entries.some((entry) => entry.id === entryId)) {
    throw new Error(`Duplicate Transcript entry ID: ${entryId}`);
  }
}

function assertNewIdentity<T>(items: Readonly<Record<string, T>>, id: string, label: string): void {
  if (items[id] !== undefined) throw new Error(`Duplicate Transcript ${label} ID: ${id}`);
}

function assertStreamTarget(
  stream: TranscriptStreamProjection | undefined,
  entryId: string,
  expectedStatus: TranscriptStreamProjection["status"],
): asserts stream is TranscriptStreamProjection {
  if (!stream) throw new Error(`Unknown Transcript stream for entry ${entryId}`);
  if (stream.entryId !== entryId) {
    throw new Error(
      `Transcript stream ${stream.id} entry mismatch: ${stream.entryId} != ${entryId}`,
    );
  }
  if (stream.status !== expectedStatus) {
    throw new Error(
      `Transcript stream ${stream.id} is ${stream.status}, expected ${expectedStatus}`,
    );
  }
}

function requirePendingTool(
  tools: Readonly<Record<string, TranscriptToolCallProjection>>,
  toolCallId: string,
): TranscriptToolCallProjection {
  const tool = tools[toolCallId];
  if (!tool) throw new Error(`Unknown Transcript tool call ID: ${toolCallId}`);
  if (!isPendingToolStatus(tool.status)) {
    throw new Error(`Transcript tool call ${toolCallId} is already ${tool.status}`);
  }
  return tool;
}

function isPendingToolStatus(status: TranscriptToolCallStatus): boolean {
  return status === "queued" || status === "running" || status === "approval";
}

function normalizeToolOutputSegment(
  event: Extract<TranscriptEvent, { type: "tool.output" }>,
): TranscriptToolOutputSegment {
  const content = event.segment.content;
  const runs = event.segment.runs.map((run) => {
    if (!Number.isSafeInteger(run.length) || run.length <= 0) {
      throw new Error("Transcript tool output run length must be a positive safe integer");
    }
    return Object.freeze({ stream: run.stream, length: run.length });
  });
  const runLength = runs.reduce((sum, run) => sum + run.length, 0);
  if (runLength !== content.length) {
    throw new Error(
      `Transcript tool output segment run length mismatch: ${runLength} != ${content.length}`,
    );
  }
  return Object.freeze({ content, runs: Object.freeze(runs) });
}

function retainEntryIndexes(
  entries: readonly TranscriptProjectedEntry[],
  streams: Readonly<Record<string, TranscriptStreamProjection>>,
  toolCalls: Readonly<Record<string, TranscriptToolCallProjection>>,
): {
  streams: Readonly<Record<string, TranscriptStreamProjection>>;
  toolCalls: Readonly<Record<string, TranscriptToolCallProjection>>;
} {
  const retained = new Set(entries.map((entry) => entry.id));
  return {
    streams: Object.fromEntries(
      Object.entries(streams).filter(([, stream]) => retained.has(stream.entryId)),
    ),
    toolCalls: Object.fromEntries(
      Object.entries(toolCalls).filter(([, tool]) => retained.has(tool.entryId)),
    ),
  };
}

function freezeTranscriptEvent(event: TranscriptEvent): TranscriptEvent {
  if (event.type === "entry.appended") {
    return Object.freeze({
      ...event,
      entry: Object.freeze({ ...event.entry }) as TranscriptEntryData,
    });
  }
  if (event.type === "subagent.activity.updated") {
    return Object.freeze({ ...event, activity: Object.freeze({ ...event.activity }) });
  }
  if (event.type === "subagent.trace.recorded") {
    return Object.freeze({
      ...event,
      trace: Object.freeze(
        event.trace.type === "tool.completed"
          ? { ...event.trace, result: cloneToolResultEnvelope(event.trace.result) }
          : { ...event.trace },
      ),
    });
  }
  if (event.type === "tool.completed") {
    return Object.freeze({ ...event, result: cloneToolResultEnvelope(event.result) });
  }
  if (event.type === "tool.output" && "segment" in event) {
    return Object.freeze({ ...event, segment: normalizeToolOutputSegment(event) });
  }
  return Object.freeze({ ...event }) as TranscriptEvent;
}

function compactProjectionForCheckpoint(projection: TranscriptProjection): TranscriptProjection {
  const retainedInlineResults = new Set<string>();
  let remainingChars = TRANSCRIPT_CHECKPOINT_INLINE_RESULT_BUDGET_CHARS;
  let remainingCount = TRANSCRIPT_CHECKPOINT_INLINE_RESULT_RECENT_COUNT;

  for (const entry of projection.entries.toReversed()) {
    if (entry.toolCallId === undefined) continue;
    const tool = projection.toolCalls[entry.toolCallId];
    if (
      !tool ||
      tool.resultAvailability !== "inline" ||
      tool.result === undefined ||
      remainingCount <= 0 ||
      tool.result.length > remainingChars
    ) {
      continue;
    }
    retainedInlineResults.add(tool.id);
    remainingChars -= tool.result.length;
    remainingCount--;
  }

  const toolCalls = Object.fromEntries(
    Object.entries(projection.toolCalls).map(([id, tool]) => {
      if (isPendingToolStatus(tool.status)) return [id, tool];

      const compactBase = {
        ...tool,
        output: "",
        outputSegments: Object.freeze([]),
      };
      if (
        tool.resultAvailability !== "inline" ||
        tool.result === undefined ||
        retainedInlineResults.has(tool.id)
      ) {
        if (tool.resultAvailability !== "evidence" || tool.resultEnvelope === undefined) {
          return [id, Object.freeze(compactBase)];
        }
        return [
          id,
          Object.freeze({
            ...compactBase,
            resultEnvelope: compactEvidenceEnvelope(tool.resultEnvelope, tool.summary),
          }),
        ];
      }

      return [
        id,
        Object.freeze({
          ...compactBase,
          result: undefined,
          resultEnvelope: undefined,
          summary: unavailableResultSummary(tool.summary ?? "Tool result"),
          resultAvailability: "unavailable" as const,
        }),
      ];
    }),
  );

  const entries = projection.entries.map((entry) => {
    if (entry.toolCallId === undefined || entry.entry.kind !== "tool") return entry;
    const tool = toolCalls[entry.toolCallId];
    if (!tool || tool.summary === entry.entry.summary) return entry;
    return projectedEntry(
      entry.id,
      { ...entry.entry, summary: tool.summary },
      { toolCallId: entry.toolCallId },
    );
  });

  return freezeProjection({
    ...projection,
    entries,
    toolCalls,
  });
}

function unavailableResultSummary(summary: string): string {
  const notice = "Complete inline result is no longer available in the Inspector.";
  return summary.includes(notice) ? summary : `${summary}\n${notice}`;
}

function freezeProjection(projection: TranscriptProjection): TranscriptProjection {
  return Object.freeze({
    ...projection,
    entries: Object.freeze([...projection.entries]),
    phase: Object.freeze({ ...projection.phase }),
    streams: Object.freeze({ ...projection.streams }),
    toolCalls: Object.freeze({ ...projection.toolCalls }),
    subagents: Object.freeze({ ...projection.subagents }),
  });
}

function createTranscriptIdFactory(): (scope: TranscriptIdentityScope) => string {
  const namespace = randomUUID();
  let sequence = 0;
  // 保留历史命名空间，避免水合日志与 UI key 的可观察身份无谓变化。
  return (scope) => `tui:${namespace}:${scope}:${++sequence}`;
}

function normalizeSegmentLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1_024;
  return Math.max(1, Math.floor(value));
}

function assertUnique(target: Set<string>, id: string, label: string): void {
  if (!id.trim()) throw new Error(`Transcript ${label} ID must not be empty`);
  if (target.has(id)) throw new Error(`Duplicate Transcript ${label} ID: ${id}`);
}

function transcriptToolResultEnvelope(value: unknown): asserts value is ToolResultEnvelope {
  if (!isTranscriptRecord(value) || value["version"] !== 1) {
    throw new Error("Transcript tool result envelope is invalid");
  }
  transcriptExactKeys(
    value,
    "version",
    "toolCallId",
    "toolName",
    "status",
    "rawSizeBytes",
    "sha256",
    "projection",
    "deliveryTruncated",
    "evidence",
  );
  transcriptStrings(value, "toolCallId", "toolName", "status", "sha256");
  if (
    !["succeeded", "failed", "rejected", "cancelled", "interrupted"].includes(
      String(value["status"]),
    )
  ) {
    throw new Error("Transcript tool result status is invalid");
  }
  transcriptNonNegativeInteger(value, "rawSizeBytes");
  transcriptBoolean(value, "deliveryTruncated");
  if (!/^[a-f0-9]{64}$/u.test(String(value["sha256"]))) {
    throw new Error("Transcript tool result sha256 is invalid");
  }
  const projection = value["projection"];
  if (!isTranscriptRecord(projection) || projection["version"] !== 1) {
    throw new Error("Transcript tool result projection is invalid");
  }
  transcriptExactKeys(projection, "version", "mode", "text", "strategy", "truncated");
  transcriptStrings(projection, "mode", "strategy");
  if (typeof projection["text"] !== "string") {
    throw new Error("Transcript tool result projection text must be a string");
  }
  if (!["full", "preview", "synthetic"].includes(String(projection["mode"]))) {
    throw new Error("Transcript tool result projection mode is invalid");
  }
  transcriptBoolean(projection, "truncated");

  const evidence = value["evidence"];
  if (evidence === undefined) return;
  if (!isTranscriptRecord(evidence)) {
    throw new Error("Transcript tool result evidence is invalid");
  }
  transcriptExactKeys(evidence, "uri", "ref");
  transcriptString(evidence, "uri");
  const reference = evidence["ref"];
  if (
    !isTranscriptRecord(reference) ||
    reference["schemaVersion"] !== 2 ||
    reference["kind"] !== "tool-exchange"
  ) {
    throw new Error("Transcript tool result evidence reference is invalid");
  }
  transcriptExactKeys(reference, "schemaVersion", "contentHash", "sessionId", "kind");
  transcriptStrings(reference, "contentHash", "sessionId");
  if (!/^[a-f0-9]{64}$/u.test(String(reference["contentHash"]))) {
    throw new Error("Transcript tool result evidence hash is invalid");
  }
  const expectedUri = `pico://evidence/${encodeURIComponent(
    String(reference["sessionId"]),
  )}/${String(reference["contentHash"])}`;
  if (evidence["uri"] !== expectedUri) {
    throw new Error("Transcript tool result evidence URI does not match its reference");
  }
}

function transcriptSubagentTrace(value: Record<string, unknown>): void {
  transcriptStrings(value, "activityId", "traceId", "type");
  switch (value["type"]) {
    case "thinking":
      transcriptExactKeys(value, "activityId", "traceId", "type");
      return;
    case "message":
      transcriptExactKeys(value, "activityId", "traceId", "type", "content");
      transcriptString(value, "content");
      return;
    case "tool.started":
      transcriptExactKeys(value, "activityId", "traceId", "type", "name", "args");
      transcriptStrings(value, "name", "args");
      return;
    case "tool.completed":
      transcriptExactKeys(value, "activityId", "traceId", "type", "result");
      transcriptToolResultEnvelope(value["result"]);
      return;
    default:
      throw new Error("Transcript subagent trace type is invalid");
  }
}

function isTerminalSubagentStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

function cloneToolResultEnvelope(envelope: ToolResultEnvelope): ToolResultEnvelope {
  return Object.freeze({
    ...envelope,
    projection: Object.freeze({ ...envelope.projection }),
    ...(envelope.evidence
      ? {
          evidence: Object.freeze({
            ...envelope.evidence,
            ref: Object.freeze({ ...envelope.evidence.ref }),
          }),
        }
      : {}),
  });
}

function compactEvidenceEnvelope(
  envelope: ToolResultEnvelope,
  summary: string | undefined,
): ToolResultEnvelope {
  if (!envelope.evidence) return cloneToolResultEnvelope(envelope);
  return cloneToolResultEnvelope({
    ...envelope,
    projection: {
      ...envelope.projection,
      mode: "preview",
      text: summary ?? "",
      strategy: `${envelope.projection.strategy}+transcript-checkpoint`,
      truncated: true,
    },
  });
}
