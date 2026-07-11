import { randomUUID } from "node:crypto";
import type { ToolCardStatus } from "./tool-card.js";
import type { SpinnerMode } from "./spinner.js";

/** TUI 当前的执行阶段。 */
export type UiMode = SpinnerMode | "idle";

/**
 * 现有渲染层消费的条目数据。
 *
 * 这个联合类型故意不嵌入事件 ID：旧的 onUpdate / entries 用法可以
 * 保持原样，稳定 ID 由 TuiProjectedEntry 与事件流承载。
 */
export type TuiEntry =
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
  | { kind: "tool"; name: string; args: string; status: ToolCardStatus; summary?: string }
  | { kind: "thinking" };

export interface TuiProjectedEntry {
  /** 条目从创建到流式完成、工具状态变更始终不变。 */
  readonly id: string;
  readonly entry: TuiEntry;
  readonly streamId?: string;
  readonly toolCallId?: string;
}

export interface TuiPhaseProjection {
  readonly id: string;
  readonly mode: UiMode;
}

export interface TuiStreamProjection {
  readonly id: string;
  readonly entryId: string;
  readonly status: "streaming" | "completed" | "interrupted";
}

export interface TuiToolCallProjection {
  /** EventStore 内部生成的全局唯一 ID，所有后续事件都用它关联。 */
  readonly id: string;
  /** Provider 仅保证单次响应内可关联，跨轮可重复（如 Gemini）。 */
  readonly providerCallId?: string;
  readonly entryId: string;
  readonly name: string;
  readonly args: string;
  readonly status: ToolCardStatus;
  /** 按到达顺序保留的有界增量输出；chunk 字符串与事件共享，不复制正文。 */
  readonly output: readonly TuiToolOutputChunk[];
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
}

export interface TuiToolOutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

/** append-only 事件流的确定性投影。 */
export interface TuiProjection {
  readonly entries: readonly TuiProjectedEntry[];
  readonly phase: TuiPhaseProjection;
  readonly streams: Readonly<Record<string, TuiStreamProjection>>;
  readonly toolCalls: Readonly<Record<string, TuiToolCallProjection>>;
  readonly lastEventId?: string;
  readonly sequence: number;
}

interface TuiEventBase {
  /** 事件库生成的唯一 ID，不由 reporter 调用方提供。 */
  readonly eventId: string;
  /** 事件在当前 store 内严格递增的序号。 */
  readonly sequence: number;
  readonly createdAt: number;
}

/**
 * TUI 领域事件。条目更新不是对象就地修改，而是一条新事件。
 */
export type TuiEvent =
  | (TuiEventBase & {
      readonly type: "entry.appended";
      readonly entryId: string;
      readonly entry: TuiEntry;
    })
  | (TuiEventBase & {
      readonly type: "assistant.stream.started";
      readonly entryId: string;
      readonly streamId: string;
      readonly delta: string;
    })
  | (TuiEventBase & {
      readonly type: "assistant.stream.delta";
      readonly entryId: string;
      readonly streamId: string;
      readonly delta: string;
    })
  | (TuiEventBase & {
      readonly type: "assistant.stream.completed";
      readonly entryId: string;
      readonly streamId: string;
      /** 只在 provider 最终文本与已投影 delta 不同时写入，避免大正文重复常驻。 */
      readonly content?: string;
    })
  | (TuiEventBase & {
      readonly type: "assistant.stream.interrupted";
      readonly entryId: string;
      readonly streamId: string;
      readonly reason: "new-request" | "clear" | "truncate";
    })
  | (TuiEventBase & {
      readonly type: "tool.started";
      readonly entryId: string;
      /** EventStore 内部 ID，不得直接使用 provider call ID。 */
      readonly toolCallId: string;
      readonly providerCallId?: string;
      readonly name: string;
      readonly args: string;
    })
  | (TuiEventBase & {
      readonly type: "tool.approval.requested";
      readonly toolCallId: string;
      readonly summary: string;
    })
  | (TuiEventBase & {
      readonly type: "tool.output";
      readonly toolCallId: string;
      readonly stream: "stdout" | "stderr";
      readonly chunk: string;
    })
  | (TuiEventBase & {
      readonly type: "tool.output.truncated";
      readonly toolCallId: string;
      /** 第一次超过 Reporter 内存上限时未写入事件流的字符数。 */
      readonly droppedChars: number;
    })
  | (TuiEventBase & {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly status: ToolCardStatus;
      readonly summary: string;
      /** 仅在结果无法由已记录的 output chunks 重建时携带。 */
      readonly inlineResult?: string;
      readonly artifactRef?: string;
      readonly artifactPath?: string;
      readonly size: number;
      readonly truncated: boolean;
    })
  | (TuiEventBase & {
      readonly type: "phase.changed";
      readonly phaseId: string;
      readonly mode: UiMode;
    })
  | (TuiEventBase & {
      readonly type: "transcript.truncated";
      readonly entryCount: number;
    })
  | (TuiEventBase & {
      readonly type: "transcript.cleared";
    });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type TuiEventDraftWithIdentities = DistributiveOmit<TuiEvent, keyof TuiEventBase>;
type TuiToolStartedDraft = Extract<TuiEventDraftWithIdentities, { type: "tool.started" }>;

/** tool.started 的内部 toolCallId 由 store 生成，不对调用方开放。 */
export type TuiEventDraft =
  | Exclude<TuiEventDraftWithIdentities, TuiToolStartedDraft>
  | Omit<TuiToolStartedDraft, "toolCallId">;

export interface TuiEventStoreOptions {
  /** 测试、回放或水合时可注入可预测 ID。 */
  idFactory?: (scope: TuiIdentityScope) => string;
  now?: () => number;
  /** 从持久化日志水合；原有 eventId / sequence 保持不变。 */
  initialEvents?: readonly TuiEvent[];
}

export type TuiIdentityScope = "event" | "entry" | "phase" | "stream" | "tool";

/**
 * append-only 内存事件库。
 *
 * append 时同步执行纯 reducer，因此常规更新不需要每次重放全部历史；
 * replay() 则从空状态重放，供持久化水合和一致性检查使用。
 * 本 store 只管当前内存 segment；长会话的 checkpoint/rollover 由 11.4
 * 的 Session 持久化层负责，调用方不应假设 getEvents() 可无界增长。
 */
export class TuiEventStore {
  private readonly events: TuiEvent[] = [];
  private projection: TuiProjection = initialTuiProjection();
  private readonly idFactory: (scope: TuiIdentityScope) => string;
  private readonly now: () => number;
  private readonly usedEventIds = new Set<string>();
  private readonly usedEntryIds = new Set<string>();
  private readonly usedPhaseIds = new Set<string>();
  private readonly usedStreamIds = new Set<string>();
  private readonly usedToolIds = new Set<string>();

  constructor(options: TuiEventStoreOptions = {}) {
    this.idFactory = options.idFactory ?? createTuiIdFactory();
    this.now = options.now ?? Date.now;
    for (const event of options.initialEvents ?? []) this.loadInitialEvent(event);
  }

  createId(scope: Exclude<TuiIdentityScope, "event">): string {
    return this.idFactory(scope);
  }

  append(draft: TuiEventDraft): TuiEvent {
    const identifiedDraft =
      draft.type === "tool.started" ? { ...draft, toolCallId: this.createId("tool") } : draft;
    const event = freezeTuiEvent({
      ...identifiedDraft,
      eventId: this.idFactory("event"),
      sequence: this.events.length + 1,
      createdAt: this.now(),
    } as TuiEvent);
    this.assertEventIdentitiesAvailable(event);
    const nextProjection = reduceTuiEvent(this.projection, event);
    this.reserveEventIdentities(event);
    this.events.push(event);
    this.projection = nextProjection;
    return event;
  }

  getEvents(): readonly TuiEvent[] {
    return Object.freeze([...this.events]);
  }

  getProjection(): TuiProjection {
    return this.projection;
  }

  get size(): number {
    return this.events.length;
  }

  replay(): TuiProjection {
    return projectTuiEvents(this.events);
  }

  private loadInitialEvent(input: TuiEvent): void {
    if (input.sequence !== this.events.length + 1) {
      throw new Error(
        `Invalid TUI event sequence during hydration: ${input.sequence}, expected ${this.events.length + 1}`,
      );
    }
    const event = freezeTuiEvent(input);
    this.assertEventIdentitiesAvailable(event);
    const nextProjection = reduceTuiEvent(this.projection, event);
    this.reserveEventIdentities(event);
    this.events.push(event);
    this.projection = nextProjection;
  }

  private assertEventIdentitiesAvailable(event: TuiEvent): void {
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
      case "assistant.stream.delta":
      case "assistant.stream.completed":
      case "assistant.stream.interrupted":
      case "tool.approval.requested":
      case "tool.output":
      case "tool.output.truncated":
      case "tool.completed":
      case "transcript.truncated":
      case "transcript.cleared":
        break;
    }
  }

  private reserveEventIdentities(event: TuiEvent): void {
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
      case "assistant.stream.delta":
      case "assistant.stream.completed":
      case "assistant.stream.interrupted":
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

export function initialTuiProjection(): TuiProjection {
  return freezeProjection({
    entries: [],
    phase: { id: "phase:initial", mode: "idle" },
    streams: {},
    toolCalls: {},
    sequence: 0,
  });
}

/** 从事件历史确定性生成完整界面投影。 */
export function projectTuiEvents(events: readonly TuiEvent[]): TuiProjection {
  return events.reduce(reduceTuiEvent, initialTuiProjection());
}

/** 纯 reducer：不修改旧 projection 或其 entry 对象。 */
export function reduceTuiEvent(state: TuiProjection, event: TuiEvent): TuiProjection {
  if (event.sequence !== state.sequence + 1) {
    throw new Error(
      `TUI event sequence mismatch: ${event.sequence}, expected ${state.sequence + 1}`,
    );
  }
  let entries = state.entries;
  let phase = state.phase;
  let streams = state.streams;
  let toolCalls = state.toolCalls;

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
          throw new Error(`TUI stream ${event.streamId} points to a non-assistant entry`);
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
          output: Object.freeze([]),
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
          throw new Error(`TUI tool call ${event.toolCallId} points to a non-tool entry`);
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
      const chunk = Object.freeze({ stream: event.stream, chunk: event.chunk });
      const output = Object.freeze([...tool.output, chunk]);
      const visibleOutput = joinToolOutput(output);
      entries = replaceProjectedEntry(entries, tool.entryId, (current) => {
        if (current.entry.kind !== "tool") {
          throw new Error(`TUI tool call ${event.toolCallId} points to a non-tool entry`);
        }
        return projectedEntry(
          current.id,
          { ...current.entry, summary: visibleOutput },
          { toolCallId: event.toolCallId },
        );
      });
      toolCalls = {
        ...toolCalls,
        [event.toolCallId]: Object.freeze({
          ...tool,
          output,
          outputChars: tool.outputChars + event.chunk.length,
        }),
      };
      break;
    }

    case "tool.output.truncated": {
      const tool = requirePendingTool(toolCalls, event.toolCallId);
      if (tool.outputTruncated) {
        throw new Error(`TUI tool call ${event.toolCallId} output is already truncated`);
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
      const streamedResult = joinToolOutput(tool.output);
      // 11.4 持久化日志中的旧 completion 事件没有 size/truncated，水合时按非截断摘要兼容。
      const truncated = event.truncated === true;
      const result =
        event.inlineResult ??
        (!truncated && streamedResult.length > 0 ? streamedResult : undefined);
      const displayResult =
        event.artifactRef !== undefined ? event.summary : (result ?? event.summary);
      entries = replaceProjectedEntry(entries, tool.entryId, (current) => {
        if (current.entry.kind !== "tool") {
          throw new Error(`TUI tool call ${event.toolCallId} points to a non-tool entry`);
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
          ...(result !== undefined ? { result } : {}),
          summary: event.summary,
          ...(event.artifactRef !== undefined ? { artifactRef: event.artifactRef } : {}),
          ...(event.artifactPath !== undefined ? { artifactPath: event.artifactPath } : {}),
          size: event.size ?? result?.length ?? event.summary.length,
          truncated,
        }),
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
      break;
    }

    case "transcript.cleared":
      entries = [];
      streams = {};
      toolCalls = {};
      break;
  }

  return freezeProjection({
    entries,
    phase,
    streams,
    toolCalls,
    lastEventId: event.eventId,
    sequence: event.sequence,
  });
}

function projectedEntry(
  id: string,
  entry: TuiEntry,
  metadata: { streamId?: string; toolCallId?: string } = {},
): TuiProjectedEntry {
  return Object.freeze({
    id,
    entry: Object.freeze({ ...entry }) as TuiEntry,
    ...(metadata.streamId !== undefined ? { streamId: metadata.streamId } : {}),
    ...(metadata.toolCallId !== undefined ? { toolCallId: metadata.toolCallId } : {}),
  });
}

function replaceProjectedEntry(
  entries: readonly TuiProjectedEntry[],
  entryId: string,
  update: (entry: TuiProjectedEntry) => TuiProjectedEntry,
): readonly TuiProjectedEntry[] {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index < 0) throw new Error(`Unknown TUI entry ID: ${entryId}`);
  const next = [...entries];
  next[index] = update(entries[index]!);
  return next;
}

function assertNewEntryId(entries: readonly TuiProjectedEntry[], entryId: string): void {
  if (entries.some((entry) => entry.id === entryId)) {
    throw new Error(`Duplicate TUI entry ID: ${entryId}`);
  }
}

function assertNewIdentity<T>(items: Readonly<Record<string, T>>, id: string, label: string): void {
  if (items[id] !== undefined) throw new Error(`Duplicate TUI ${label} ID: ${id}`);
}

function assertStreamTarget(
  stream: TuiStreamProjection | undefined,
  entryId: string,
  expectedStatus: TuiStreamProjection["status"],
): asserts stream is TuiStreamProjection {
  if (!stream) throw new Error(`Unknown TUI stream for entry ${entryId}`);
  if (stream.entryId !== entryId) {
    throw new Error(`TUI stream ${stream.id} entry mismatch: ${stream.entryId} != ${entryId}`);
  }
  if (stream.status !== expectedStatus) {
    throw new Error(`TUI stream ${stream.id} is ${stream.status}, expected ${expectedStatus}`);
  }
}

function requirePendingTool(
  tools: Readonly<Record<string, TuiToolCallProjection>>,
  toolCallId: string,
): TuiToolCallProjection {
  const tool = tools[toolCallId];
  if (!tool) throw new Error(`Unknown TUI tool call ID: ${toolCallId}`);
  if (!isPendingToolStatus(tool.status)) {
    throw new Error(`TUI tool call ${toolCallId} is already ${tool.status}`);
  }
  return tool;
}

function isPendingToolStatus(status: ToolCardStatus): boolean {
  return status === "queued" || status === "running" || status === "approval";
}

export function joinToolOutput(chunks: readonly TuiToolOutputChunk[]): string {
  return chunks.map(({ chunk }) => chunk).join("");
}

function retainEntryIndexes(
  entries: readonly TuiProjectedEntry[],
  streams: Readonly<Record<string, TuiStreamProjection>>,
  toolCalls: Readonly<Record<string, TuiToolCallProjection>>,
): {
  streams: Readonly<Record<string, TuiStreamProjection>>;
  toolCalls: Readonly<Record<string, TuiToolCallProjection>>;
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

function freezeTuiEvent(event: TuiEvent): TuiEvent {
  if (event.type === "entry.appended") {
    return Object.freeze({ ...event, entry: Object.freeze({ ...event.entry }) as TuiEntry });
  }
  return Object.freeze({ ...event }) as TuiEvent;
}

function freezeProjection(projection: TuiProjection): TuiProjection {
  return Object.freeze({
    ...projection,
    entries: Object.freeze([...projection.entries]),
    phase: Object.freeze({ ...projection.phase }),
    streams: Object.freeze({ ...projection.streams }),
    toolCalls: Object.freeze({ ...projection.toolCalls }),
  });
}

function createTuiIdFactory(): (scope: TuiIdentityScope) => string {
  const namespace = randomUUID();
  let sequence = 0;
  return (scope) => `tui:${namespace}:${scope}:${++sequence}`;
}

function assertUnique(target: Set<string>, id: string, label: string): void {
  if (!id.trim()) throw new Error(`TUI ${label} ID must not be empty`);
  if (target.has(id)) throw new Error(`Duplicate TUI ${label} ID: ${id}`);
}
