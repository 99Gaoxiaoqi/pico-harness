import { randomUUID } from "node:crypto";
import type {
  AssistantResponseSuppressionReason,
  SubagentActivityEvent,
  SubagentTraceEvent,
} from "../engine/reporter.js";
/** 与具体渲染框架无关的执行阶段。 */
export type TranscriptPhaseMode = "idle" | "requesting" | "thinking" | "tool-use" | "responding";

/** 工具调用在 transcript 中的标准状态。 */
export type TranscriptToolCallStatus =
  | "queued"
  | "running"
  | "approval"
  | "success"
  | "error"
  | "denied"
  | "done"
  | "failed";

/**
 * 现有渲染层消费的条目数据。
 *
 * 这个联合类型故意不嵌入事件 ID：旧的 onUpdate / entries 用法可以
 * 保持原样，稳定 ID 由 TranscriptProjectedEntry 与事件流承载。
 */
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
      mode?: SubagentActivityEvent["mode"];
      completionPolicy?: SubagentActivityEvent["completionPolicy"];
      currentAction?: string;
      summary?: string;
      requestedModelRoute?: string;
      resolvedModelRoute?: string;
      thinkingEffort?: string;
      modelSelectionSource?: SubagentActivityEvent["modelSelectionSource"];
    }
  | { kind: "thinking" };

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
  readonly entry: TranscriptEntry;
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
  /** Provider 仅保证单次响应内可关联，跨轮可重复（如 Gemini）。 */
  readonly providerCallId?: string;
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
  /** 大结果的可信定位信息；读取时仍须由 Inspector 校验 artifact store。 */
  readonly artifactRef?: string;
  readonly artifactPath?: string;
  readonly size?: number;
  readonly truncated: boolean;
  /** Inspector 只根据该字段判断完整结果是否仍可用。 */
  readonly resultAvailability?: "inline" | "artifact" | "unavailable";
}

export interface TranscriptToolOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
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
      readonly entry: TranscriptEntry;
    })
  | (TranscriptEventBase & {
      readonly type: "assistant.stream.started";
      readonly entryId: string;
      readonly streamId: string;
      readonly delta: string;
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
      readonly providerCallId?: string;
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
  /** 兼容旧持久化日志；新 Reporter 只写 segment 形式。 */
  | (TranscriptEventBase & {
      readonly type: "tool.output";
      readonly toolCallId: string;
      readonly stream: "stdout" | "stderr";
      readonly chunk: string;
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
      readonly status: TranscriptToolCallStatus;
      readonly summary: string;
      /** 仅在结果无法由已记录的 output chunks 重建时携带。 */
      readonly inlineResult?: string;
      readonly artifactRef?: string;
      readonly artifactPath?: string;
      readonly size: number;
      readonly truncated: boolean;
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
    })
  | (TranscriptEventBase & {
      readonly type: "transcript.cleared";
    });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type TranscriptEventDraftWithIdentities = DistributiveOmit<
  TranscriptEvent,
  keyof TranscriptEventBase
>;
type TranscriptToolStartedDraft = Extract<
  TranscriptEventDraftWithIdentities,
  { type: "tool.started" }
>;

/** tool.started 的内部 toolCallId 由 store 生成，不对调用方开放。 */
export type TranscriptEventDraft =
  | Exclude<TranscriptEventDraftWithIdentities, TranscriptToolStartedDraft>
  | Omit<TranscriptToolStartedDraft, "toolCallId">;

export interface TranscriptEventStoreOptions {
  /** 测试、回放或水合时可注入可预测 ID。 */
  idFactory?: (scope: TranscriptIdentityScope) => string;
  now?: () => number;
  /** 从持久化日志水合；原有 eventId / sequence 保持不变。 */
  initialEvents?: readonly TranscriptEvent[];
  /** 从 checkpoint + 当前事件段水合。 */
  initialSnapshot?: TranscriptEventStoreSnapshot;
  /** 当前事件段最大长度；达到后投影折叠为新 checkpoint。 */
  maxSegmentEvents?: number;
}

export interface TranscriptEventStoreSnapshot {
  readonly checkpoint: TranscriptProjection;
  readonly events: readonly TranscriptEvent[];
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

  constructor(options: TranscriptEventStoreOptions = {}) {
    if (options.initialEvents !== undefined && options.initialSnapshot !== undefined) {
      throw new Error(
        "TranscriptEventStore accepts either initialEvents or initialSnapshot, not both",
      );
    }
    this.idFactory = options.idFactory ?? createTranscriptIdFactory();
    this.now = options.now ?? Date.now;
    this.maxSegmentEvents = normalizeSegmentLimit(options.maxSegmentEvents);
    this.checkpoint = cloneProjection(
      options.initialSnapshot?.checkpoint ?? initialTranscriptProjection(),
    );
    this.projection = this.checkpoint;
    this.rebuildIdentityReservations();
    const initialEvents = options.initialSnapshot?.events ?? options.initialEvents ?? [];
    for (const event of initialEvents) this.loadInitialEvent(event);
    if (this.events.length >= this.maxSegmentEvents) this.rollover();
  }

  createId(scope: Exclude<TranscriptIdentityScope, "event">): string {
    return this.idFactory(scope);
  }

  append(draft: TranscriptEventDraft): TranscriptEvent {
    const identifiedDraft =
      draft.type === "tool.started" ? { ...draft, toolCallId: this.createId("tool") } : draft;
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
    return event;
  }

  /** 只返回 checkpoint 之后的当前有界事件段。 */
  getEvents(): readonly TranscriptEvent[] {
    return Object.freeze([...this.events]);
  }

  /** 持久化/水合应使用该完整单元，不应单独保存 getEvents()。 */
  getReplaySnapshot(): TranscriptEventStoreSnapshot {
    return Object.freeze({
      checkpoint: this.checkpoint,
      events: Object.freeze([...this.events]),
    });
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
  let subagents = state.subagents ?? {};

  switch (event.type) {
    case "entry.appended":
      assertNewEntryId(entries, event.entryId);
      entries = [...entries, projectedEntry(event.entryId, event.entry)];
      break;

    case "assistant.stream.started":
      assertNewEntryId(entries, event.entryId);
      assertNewIdentity(streams, event.streamId, "stream");
      entries = [
        ...entries,
        projectedEntry(
          event.entryId,
          { kind: "assistant", content: event.delta },
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

    case "assistant.stream.delta": {
      const stream = streams[event.streamId];
      assertStreamTarget(stream, event.entryId, "streaming");
      entries = replaceProjectedEntry(entries, event.entryId, (current) => {
        if (current.entry.kind !== "assistant") {
          throw new Error(`Transcript stream ${event.streamId} points to a non-assistant entry`);
        }
        return projectedEntry(
          current.id,
          { kind: "assistant", content: current.entry.content + event.delta },
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
        entries = replaceProjectedEntry(entries, event.entryId, (current) =>
          projectedEntry(
            current.id,
            { kind: "assistant", content: completedContent },
            { streamId: event.streamId },
          ),
        );
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
          ...(event.providerCallId !== undefined ? { providerCallId: event.providerCallId } : {}),
          entryId: event.entryId,
          name: event.name,
          args: event.args,
          status: "running" as const,
          output: "",
          outputSegments: Object.freeze([]),
          outputChars: 0,
          droppedOutputChars: 0,
          outputTruncated: false,
          truncated: false,
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
      const streamedResult = tool.output;
      // 11.4 持久化日志中的旧 completion 事件没有 size/truncated，水合时按非截断摘要兼容。
      const truncated = event.truncated === true;
      const result =
        event.inlineResult ??
        (!truncated && streamedResult.length > 0 ? streamedResult : undefined);
      const resultAvailability =
        event.artifactRef !== undefined
          ? ("artifact" as const)
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
          { ...current.entry, status: event.status, summary: displayResult },
          { toolCallId: event.toolCallId },
        );
      });
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({
          ...tool,
          status: event.status,
          output: "",
          outputSegments: Object.freeze([]),
          ...(result !== undefined ? { result } : {}),
          summary: displayResult,
          ...(event.artifactRef !== undefined ? { artifactRef: event.artifactRef } : {}),
          ...(event.artifactPath !== undefined ? { artifactPath: event.artifactPath } : {}),
          size: event.size ?? result?.length ?? event.summary.length,
          truncated,
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
    const result = trace.result.slice(0, TRANSCRIPT_SUBAGENT_TOOL_RESULT_LIMIT_CHARS);
    const next = [...timeline];
    next[index] = Object.freeze({
      ...current,
      status: trace.isError ? "error" : "success",
      result,
      ...(trace.truncated === true || result.length < trace.result.length
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
  entry: TranscriptEntry,
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

export function joinToolOutput(
  output: string | readonly (TranscriptToolOutputChunk | TranscriptToolOutputSegment)[],
): string {
  if (typeof output === "string") return output;
  return output.map((item) => ("content" in item ? item.content : item.chunk)).join("");
}

function normalizeToolOutputSegment(
  event: Extract<TranscriptEvent, { type: "tool.output" }>,
): TranscriptToolOutputSegment {
  if (!("segment" in event)) {
    return Object.freeze({
      content: event.chunk,
      runs: Object.freeze([Object.freeze({ stream: event.stream, length: event.chunk.length })]),
    });
  }

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
    return Object.freeze({ ...event, entry: Object.freeze({ ...event.entry }) as TranscriptEntry });
  }
  if (event.type === "subagent.activity.updated") {
    return Object.freeze({ ...event, activity: Object.freeze({ ...event.activity }) });
  }
  if (event.type === "subagent.trace.recorded") {
    return Object.freeze({ ...event, trace: Object.freeze({ ...event.trace }) });
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
        return [id, Object.freeze(compactBase)];
      }

      return [
        id,
        Object.freeze({
          ...compactBase,
          result: undefined,
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

function cloneProjection(projection: TranscriptProjection): TranscriptProjection {
  const entries = projection.entries.map((item) =>
    projectedEntry(item.id, item.entry, {
      ...(item.streamId !== undefined ? { streamId: item.streamId } : {}),
      ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
      ...(item.subagentActivityId !== undefined
        ? { subagentActivityId: item.subagentActivityId }
        : {}),
    }),
  );
  const streams = Object.fromEntries(
    Object.entries(projection.streams).map(([id, stream]) => [id, Object.freeze({ ...stream })]),
  );
  const toolCalls = Object.fromEntries(
    Object.entries(projection.toolCalls).map(([id, tool]) => [
      id,
      Object.freeze({
        ...tool,
        outputSegments: Object.freeze(
          tool.outputSegments.map((segment) =>
            Object.freeze({
              content: segment.content,
              runs: Object.freeze(segment.runs.map((run) => Object.freeze({ ...run }))),
            }),
          ),
        ),
      }),
    ]),
  );
  const subagents = Object.fromEntries(
    Object.entries(projection.subagents ?? {}).map(([id, subagent]) => [
      id,
      freezeSubagentProjection({
        ...subagent,
        timeline: subagent.timeline.map((item) => Object.freeze({ ...item })),
        lifecycle:
          subagent.lifecycle ?? subagentLifecycleForStatus(subagent.activity.status, undefined),
      }),
    ]),
  );
  return freezeProjection({
    entries,
    phase: { ...projection.phase },
    streams,
    toolCalls,
    subagents,
    ...(projection.lastEventId !== undefined ? { lastEventId: projection.lastEventId } : {}),
    sequence: projection.sequence,
  });
}

function freezeProjection(projection: TranscriptProjection): TranscriptProjection {
  return Object.freeze({
    ...projection,
    entries: Object.freeze([...projection.entries]),
    phase: Object.freeze({ ...projection.phase }),
    streams: Object.freeze({ ...projection.streams }),
    toolCalls: Object.freeze({ ...projection.toolCalls }),
    subagents: Object.freeze({ ...(projection.subagents ?? {}) }),
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
