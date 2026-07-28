// TUI Reporter:把 Agent 引擎的事件流转成 React 可渲染的状态(对标 Claude Code ink 架构)。
//
// 设计:Reporter 接口是 engine 与 I/O 的解耦点(reporter.ts)。
// 本类把 engine 回调追加为不可变事件，再由纯 reducer 投影为现有
// projection 快照。宿主通过唯一的 onProjectionUpdate 接入 setState。
//
// 状态机:TUI EventStore 维护 append-only 日志，投影层生成对话流:
//   - user 消息(由 repl 主动 push,非 reporter 回调)
//   - assistant 流式输出(onTextDelta 累积)
//   - 工具调用卡片(onToolCall → onToolResult 配对)
//   - 思考中 spinner(onThinking)
//
// 不直接渲染 ink 组件(保持 reporter 纯数据层),渲染由 App.tsx 消费 state 完成。

import type {
  AssistantResponseSuppressionReason,
  Reporter,
  SubagentActivityEvent,
  SubagentTraceEvent,
} from "../engine/reporter.js";
import {
  createToolResultEnvelope,
  type ToolResultEnvelope,
} from "../engine/tool-result-contract.js";
import type { CanonicalTranscriptToolStart } from "../engine/transcript-tool-start.js";
import { summarizeTranscriptToolResult } from "../presentation/transcript-tool-result-hydration.js";
import {
  defaultTranscriptDurabilityPolicy,
  isDurableTranscriptEvent,
  type DurableTranscriptSink,
  type TranscriptDurabilityPolicy,
} from "../presentation/transcript-durability.js";
import {
  TRANSCRIPT_SUBAGENT_MESSAGE_LIMIT_CHARS as TUI_SUBAGENT_MESSAGE_LIMIT_CHARS,
  TRANSCRIPT_SUBAGENT_TOOL_ARGS_LIMIT_CHARS as TUI_SUBAGENT_TOOL_ARGS_LIMIT_CHARS,
  TRANSCRIPT_SUBAGENT_TOOL_RESULT_LIMIT_CHARS as TUI_SUBAGENT_TOOL_RESULT_LIMIT_CHARS,
  TRANSCRIPT_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS as TUI_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS,
  TranscriptEventStore,
} from "../presentation/transcript-event-store.js";
import type {
  TranscriptEntry as TuiEntry,
  TranscriptEvent,
  TranscriptProjection as TuiProjection,
  TranscriptToolCallProjection,
  TranscriptToolOutputRun,
  TranscriptPhaseMode as UiMode,
} from "../presentation/transcript-event-store.js";
import type { ToolCardStatus } from "./tool-card.js";

/** Bash 的外部化阈值是 30k；多留少量余量后立即停止向 append-only 日志写正文。 */
export const TUI_TOOL_OUTPUT_MEMORY_LIMIT_CHARS = TUI_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS;
const TUI_TOOL_OUTPUT_EVENT_SEGMENT_CHARS = 2_048;

export type {
  TranscriptEntry as TuiEntry,
  TranscriptProjection as TuiProjection,
} from "../presentation/transcript-event-store.js";

interface PendingToolOutputSegment {
  pieces: string[];
  runs: Array<{ stream: "stdout" | "stderr"; length: number }>;
  chars: number;
}

export interface TuiReporterOptions {
  /** 水合或回放时可以传入已有事件库。 */
  eventStore?: TranscriptEventStore;
  /** 消费带稳定 ID 的唯一权威投影。 */
  onProjectionUpdate?: (projection: TuiProjection) => void;
  /** 将语义 transcript 事件串行写入 Session；不持久化逐 token delta。 */
  durableTranscriptSink?: DurableTranscriptSink;
  durableTranscriptPolicy?: TranscriptDurabilityPolicy;
  /** 已持久化 transcript 的最大 sequence，用于续写时保持连续。 */
  durableTranscriptSequence?: number;
}

/**
 * TuiReporter:把 engine 事件翻译成唯一的结构化 Transcript 投影。
 */
export class TuiReporter implements Reporter {
  private currentStream: { entryId: string; streamId: string } | null = null;
  private currentReasoningStream: { entryId: string; streamId: string } | null = null;
  /** 本轮刚完成的模型正文；若随后确认是 required 委派，则从主 transcript 定向撤销。 */
  private currentTurnAssistantEntryId: string | null = null;
  /**
   * EventStore 内部 tool ID 的待完成索引。Provider call ID 仅作
   * 当前 pending 队列的关联键，不作为事件全局 ID，因为 Gemini 会跨轮复用它。
   */
  private readonly pendingToolIdsByProviderCallId = new Map<string, string[]>();
  /** 小 chunk 先在有界 segment 内聚合，避免每次输出都生成事件和重放拷贝。 */
  private readonly pendingToolOutput = new Map<string, PendingToolOutputSegment>();
  private readonly eventStore: TranscriptEventStore;
  private readonly onProjectionUpdate?: (projection: TuiProjection) => void;
  private readonly durableTranscriptSink?: DurableTranscriptSink;
  private readonly durableTranscriptPolicy: TranscriptDurabilityPolicy;
  private durableTranscriptSequence: number;
  private durableTranscriptTail: Promise<void> = Promise.resolve();
  private durableTranscriptFailure: unknown;
  private durableTranscriptSuppressed = false;
  private readonly removeAppendListener: () => void;

  constructor(options: TuiReporterOptions = {}) {
    this.eventStore = options.eventStore ?? new TranscriptEventStore();
    this.onProjectionUpdate = options.onProjectionUpdate;
    this.durableTranscriptSink = options.durableTranscriptSink;
    this.durableTranscriptPolicy =
      options.durableTranscriptPolicy ?? defaultTranscriptDurabilityPolicy;
    this.durableTranscriptSequence = Math.max(0, options.durableTranscriptSequence ?? 0);

    // Initial entries/events are already a snapshot; only subsequent appends
    // belong to the durable sink.
    this.removeAppendListener = this.eventStore.addAppendListener((event) => {
      this.enqueueDurableTranscript(event);
    });
    this.rebuildRuntimeTracking();
  }

  /** user 消息由 repl 主动 push(不在 Reporter 接口里),暴露此方法供调用 */
  pushUserMessage(content: string): void {
    this.appendEntry({ kind: "user", content });
    this.emit();
  }

  getEntryCount(): number {
    return this.eventStore.getProjection().entries.length;
  }

  /** 只返回当前 checkpoint 之后的有界事件段。 */
  getEvents(): readonly TranscriptEvent[] {
    return this.eventStore.getEvents();
  }

  /** 带 entry / stream / tool / phase 稳定 ID 的权威投影。 */
  getProjection(): TuiProjection {
    return this.eventStore.getProjection();
  }

  /** 供独立 hydration 调用方装载结构化事件；重复装载同一快照是幂等的。 */
  hydrateTranscriptEvents(events: readonly TranscriptEvent[]): void {
    this.eventStore.loadInitialEvents(events);
    this.rebuildRuntimeTracking();
  }

  /** Rebuild the visible projection from Session after a durable branch change. */
  replaceTranscriptEvents(events: readonly TranscriptEvent[]): void {
    this.clearRuntimeTracking();
    this.eventStore.replaceEvents(events);
    this.rebuildRuntimeTracking();
    this.emit();
  }

  /** 水合/回放期间抑制事件再次落盘。 */
  withoutDurableTranscript(callback: () => void): void {
    const previous = this.durableTranscriptSuppressed;
    this.durableTranscriptSuppressed = true;
    try {
      callback();
    } finally {
      this.durableTranscriptSuppressed = previous;
    }
  }

  /** 等待当前 Reporter 已提交的 durable transcript。 */
  async flushDurableTranscript(): Promise<void> {
    await this.durableTranscriptTail;
    if (this.durableTranscriptFailure) throw this.durableTranscriptFailure;
  }

  /** 释放 reporter 对 EventStore 的追加监听。 */
  dispose(): void {
    this.removeAppendListener();
  }

  /**
   * 空闲 wake 已取得执行权并把异步 completion 写入 Session。
   * 先记录 claim，再等这次主 Agent 正文完成后归档，避免无关旧正文提前隐藏活动。
   */
  onSubagentActivitiesClaimed(activityIds: readonly string[]): void {
    const requested = new Set(activityIds);
    const terminal = Object.values(this.eventStore.getProjection().subagents).filter(
      (subagent) =>
        requested.has(subagent.activityId) && subagent.lifecycle === "terminal_unconsumed",
    );
    for (const subagent of terminal) {
      this.eventStore.append({
        type: "subagent.activity.claimed",
        activityId: subagent.activityId,
      });
    }
    if (terminal.length > 0) this.emit();
  }

  /** 对话 rewind 后让可见 transcript 与 Session 使用同一截断边界。 */
  truncateTo(entryIndex: number, options: { readonly operationId: string }): void {
    const entryCount = this.eventStore.getProjection().entries.length;
    const safeIndex = Math.min(Math.max(0, entryIndex), entryCount);
    this.interruptActiveStreams("truncate");
    this.eventStore.append({
      type: "transcript.truncated",
      entryCount: safeIndex,
      operationId: options.operationId,
    });
    this.clearRuntimeTracking();
    this.appendPhase("idle", true);
    this.emit();
  }

  /** 显式 Skill 激活属于持久 transcript 事件,不伪装成普通用户文本。 */
  pushSkillActivation(input: {
    name: string;
    args: string;
    trigger: "user-slash" | "model-tool";
  }): void {
    this.appendEntry({ kind: "skill", ...input });
    this.emit();
  }

  /** 本地输入命令的系统反馈。 */
  pushSystemMessage(content: string): void {
    this.appendEntry({ kind: "system", content });
    this.emit();
  }

  /** 结构化错误反馈,避免渲染层靠文案前缀猜测。 */
  pushError(message: string, options: { retryable?: boolean; action?: string } = {}): void {
    this.appendEntry({
      kind: "error",
      message,
      ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
      ...(options.action !== undefined ? { action: options.action } : {}),
    });
    this.emit();
  }

  /** 清空 TUI 当前可见 transcript,不影响底层 session 历史。 */
  clear(): void {
    this.interruptActiveStreams("clear");
    this.eventStore.append({ type: "transcript.cleared" });
    this.clearRuntimeTracking();
    this.appendPhase("idle", true);
    this.emit();
  }

  /** 读当前 UI 模式，供 app.tsx 的 spinner 使用。 */
  getMode(): UiMode {
    return this.eventStore.getProjection().phase.mode;
  }

  onStart(_workDir: string): void {
    // 新请求不继承上一次异常退出的 streaming/pending 运行态。
    this.interruptActiveStreams("new-request");
    this.clearRuntimeTracking();
    this.appendPhase("requesting", true);
    this.emit();
  }

  onTurnStart(_turn: number): void {
    // 轮次分隔:结束未收到权威 onMessage 的旧流，确保新轮创建新 streamId。
    this.completeActiveStreams();
    this.currentTurnAssistantEntryId = null;
    this.appendPhase("requesting", true);
    this.emit();
  }

  onThinking(): void {
    this.appendPhase("thinking");
    // 保留零高度占位，让尚未收到 reasoning delta 的模型也能驱动“思考中”状态。
    this.appendEntry({ kind: "thinking" });
    this.emit();
  }

  onToolCall(
    toolName: string,
    args: string,
    providerCallId: string,
    durableStart?: CanonicalTranscriptToolStart,
  ): void {
    this.completeReasoningStream();
    if (isRequiredDelegation(toolName, args)) {
      this.suppressCurrentTurnAssistantResponse("required-delegation");
    }
    this.appendPhase("tool-use");
    const normalizedProviderCallId = normalizeIdentity(providerCallId);
    if (normalizedProviderCallId === undefined) {
      throw new Error("TUI ToolCall providerCallId must not be empty");
    }
    if (
      durableStart &&
      (normalizeIdentity(durableStart.providerCallId) !== normalizedProviderCallId ||
        durableStart.name !== toolName ||
        durableStart.args !== args)
    ) {
      throw new Error("TUI canonical ToolCall start does not match the Reporter callback");
    }
    const entryId = durableStart?.entryId ?? this.eventStore.createId("entry");
    let event: TranscriptEvent | undefined;
    const append = (): void => {
      event = this.eventStore.append({
        type: "tool.started",
        entryId,
        ...(durableStart ? { toolCallId: durableStart.toolCallId } : {}),
        providerCallId: normalizedProviderCallId,
        name: toolName,
        args,
      });
    };
    if (durableStart) {
      // Runtime already owns this durable fact. Keep the live projection identity
      // aligned while suppressing the old Reporter-owned persistence path.
      this.withoutDurableTranscript(append);
      this.durableTranscriptSequence = Math.max(
        this.durableTranscriptSequence,
        durableStart.sequence,
      );
    } else {
      append();
    }
    if (!event || event.type !== "tool.started") {
      throw new Error("TUI EventStore returned an unexpected event for tool.started");
    }
    const internalToolCallId = event.toolCallId;
    const tool = this.eventStore.getProjection().toolCalls[internalToolCallId];
    if (tool) this.registerPendingTool(tool);
    this.emit();
  }

  onToolAwaitingApproval(_toolName: string, args: string, providerCallId: string): void {
    const internalToolCallId = this.resolvePendingToolId(providerCallId, args);
    if (internalToolCallId !== undefined) {
      this.eventStore.append({
        type: "tool.approval.requested",
        toolCallId: internalToolCallId,
        summary: "等待审批",
      });
    }
    this.appendPhase("tool-use");
    this.emit();
  }

  onToolOutput(
    _toolName: string,
    stream: "stdout" | "stderr",
    chunk: string,
    providerCallId: string,
  ): void {
    if (chunk.length === 0) return;
    const internalToolCallId = this.resolvePendingToolId(providerCallId);
    if (internalToolCallId === undefined) return;
    const tool = this.eventStore.getProjection().toolCalls[internalToolCallId];
    if (!tool || tool.outputTruncated) return;

    // 上限在 append 前生效：event log 与 projection 都不会持有上限外正文。
    const bufferedChars = this.pendingToolOutput.get(internalToolCallId)?.chars ?? 0;
    const remaining = Math.max(
      0,
      TUI_TOOL_OUTPUT_MEMORY_LIMIT_CHARS - tool.outputChars - bufferedChars,
    );
    const retained = remaining > 0 ? chunk.slice(0, remaining) : "";
    let projectionChanged = false;
    if (retained.length > 0) {
      projectionChanged = this.bufferToolOutput(internalToolCallId, stream, retained);
      // 首个非空 chunk 立即可见；之后才按固定大小聚合，兼顾流式体感与事件上限。
      if (tool.outputChars === 0 && !projectionChanged) {
        projectionChanged = this.flushToolOutput(internalToolCallId);
      }
    }
    const droppedChars = chunk.length - retained.length;
    if (droppedChars > 0) {
      this.flushToolOutput(internalToolCallId);
      this.eventStore.append({
        type: "tool.output.truncated",
        toolCallId: internalToolCallId,
        droppedChars,
      });
      this.pendingToolOutput.delete(internalToolCallId);
      projectionChanged = true;
    }
    if (projectionChanged) this.emit();
  }

  onToolResult(result: ToolResultEnvelope): void {
    const internalToolCallId = this.resolvePendingToolId(result.toolCallId);
    if (internalToolCallId === undefined) {
      // rewind/clear 后到达的旧结果不再污染当前 transcript。
      this.emit();
      return;
    }
    this.flushToolOutput(internalToolCallId);
    const tool = this.eventStore.getProjection().toolCalls[internalToolCallId];
    if (!tool) {
      this.removePendingToolId(internalToolCallId, result.toolCallId);
      this.emit();
      return;
    }
    const summary = summarizeTranscriptToolResult(result.toolName, tool.args, result);
    this.eventStore.append({
      type: "tool.completed",
      toolCallId: internalToolCallId,
      summary,
      result,
    });
    this.removePendingTool(tool);
    this.emit();
  }

  onSubagentActivity(activity: SubagentActivityEvent): void {
    const activityId = activity.activityId.trim();
    if (!activityId) throw new Error("Subagent activity ID must not be empty");
    const projection = this.eventStore.getProjection();
    const existing = projection.entries.find((entry) => entry.subagentActivityId === activityId);
    this.eventStore.append({
      type: "subagent.activity.updated",
      entryId: existing?.id ?? this.eventStore.createId("entry"),
      activityId,
      activity: {
        task: activity.task,
        status: activity.status,
        mode: activity.mode,
        completionPolicy: activity.completionPolicy,
        ...(activity.agentName !== undefined ? { agentName: activity.agentName } : {}),
        ...(activity.currentAction !== undefined ? { currentAction: activity.currentAction } : {}),
        ...(activity.summary !== undefined ? { summary: activity.summary } : {}),
        ...(activity.requestedModelRoute !== undefined
          ? { requestedModelRoute: activity.requestedModelRoute }
          : {}),
        ...(activity.resolvedModelRoute !== undefined
          ? { resolvedModelRoute: activity.resolvedModelRoute }
          : {}),
        ...(activity.thinkingEffort !== undefined
          ? { thinkingEffort: activity.thinkingEffort }
          : {}),
        ...(activity.modelSelectionSource !== undefined
          ? { modelSelectionSource: activity.modelSelectionSource }
          : {}),
      },
    });
    if (activity.completionPolicy === "detached" && activity.status === "completed") {
      this.eventStore.append({
        type: "subagent.activity.archived",
        activityId,
      });
    }
    this.emit();
  }

  onSubagentTrace(trace: SubagentTraceEvent): void {
    const activityId = trace.activityId.trim();
    const traceId = trace.traceId.trim();
    if (!activityId || !traceId) throw new Error("Subagent trace identities must not be empty");
    const boundedTrace: SubagentTraceEvent =
      trace.type === "message"
        ? { ...trace, content: trace.content.slice(0, TUI_SUBAGENT_MESSAGE_LIMIT_CHARS) }
        : trace.type === "tool.started"
          ? { ...trace, args: trace.args.slice(0, TUI_SUBAGENT_TOOL_ARGS_LIMIT_CHARS) }
          : trace.type === "tool.completed"
            ? {
                ...trace,
                result: boundSubagentToolResultEnvelope(
                  trace.result,
                  TUI_SUBAGENT_TOOL_RESULT_LIMIT_CHARS,
                ),
              }
            : trace;
    this.eventStore.append({ type: "subagent.trace.recorded", trace: boundedTrace });
    this.emit();
  }

  onMessage(content: string): void {
    this.completeReasoningStream();
    if (this.currentStream) {
      this.currentTurnAssistantEntryId = this.currentStream.entryId;
      this.eventStore.append({
        type: "assistant.stream.completed",
        ...this.currentStream,
        // durable policy 会过滤中间 delta，因此 completion 必须携带最终正文。
        content,
      });
    } else {
      this.currentTurnAssistantEntryId = this.appendEntry({ kind: "assistant", content });
    }
    this.currentStream = null;
    this.archiveConsumedSubagents();
    this.emit();
  }

  onFinish(): void {
    this.completeActiveStreams();
    this.appendPhase("idle", true);
    this.emit();
  }

  onInterrupted(): void {
    this.interruptActiveStreams("abort");
    for (const tool of Object.values(this.eventStore.getProjection().toolCalls)) {
      if (!isPendingToolStatus(tool.status)) continue;
      this.flushToolOutput(tool.id);
      this.eventStore.append({
        type: "tool.completed",
        toolCallId: tool.id,
        summary: "Interrupted by user.",
        result: createToolResultEnvelope({
          toolCallId: tool.providerCallId,
          toolName: tool.name,
          status: "interrupted",
          body: {
            storage: "inline",
            content: "",
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            sizeBytes: 0,
          },
          projection: {
            version: 1,
            mode: "synthetic",
            text: "Interrupted by user.",
            strategy: "tui-interrupted",
            truncated: false,
          },
        }),
      });
      this.removePendingTool(tool);
    }
    this.clearRuntimeTracking();
    this.appendPhase("idle", true);
    this.emit();
  }

  onTextDelta(delta: string): void {
    this.completeReasoningStream();
    this.appendPhase("responding");
    if (this.currentStream) {
      this.eventStore.append({
        type: "assistant.stream.delta",
        ...this.currentStream,
        delta,
      });
    } else {
      this.currentStream = {
        entryId: this.eventStore.createId("entry"),
        streamId: this.eventStore.createId("stream"),
      };
      this.eventStore.append({
        type: "assistant.stream.started",
        ...this.currentStream,
        entryKind: "assistant",
        delta,
      });
    }
    this.emit();
  }

  onReasoningDelta(delta: string): void {
    if (!delta) return;
    this.appendPhase("thinking");
    if (this.currentReasoningStream) {
      this.eventStore.append({
        type: "assistant.stream.delta",
        ...this.currentReasoningStream,
        delta,
      });
    } else {
      this.currentReasoningStream = {
        entryId: this.eventStore.createId("entry"),
        streamId: this.eventStore.createId("stream"),
      };
      this.eventStore.append({
        type: "assistant.stream.started",
        ...this.currentReasoningStream,
        entryKind: "thinking",
        delta,
      });
    }
    this.emit();
  }

  onAssistantResponseSuppressed(reason: AssistantResponseSuppressionReason): void {
    this.suppressCurrentTurnAssistantResponse(reason);
    this.emit();
  }

  private archiveConsumedSubagents(): void {
    const terminal = Object.values(this.eventStore.getProjection().subagents).filter((subagent) => {
      if (subagent.lifecycle === "terminal_claimed") return true;
      if (subagent.lifecycle !== "terminal_unconsumed") return false;
      const policy = subagent.activity.completionPolicy;
      // required 结果由当前工具轮同步消费；detached 成功无需进入主上下文。
      return (
        policy === "required" || (policy === "detached" && subagent.activity.status === "completed")
      );
    });
    for (const subagent of terminal) {
      this.eventStore.append({
        type: "subagent.activity.archived",
        activityId: subagent.activityId,
      });
    }
  }

  private appendEntry(entry: TuiEntry): string {
    const entryId = this.eventStore.createId("entry");
    this.eventStore.append({ type: "entry.appended", entryId, entry });
    return entryId;
  }

  private suppressCurrentTurnAssistantResponse(reason: AssistantResponseSuppressionReason): void {
    const entryId = this.currentTurnAssistantEntryId ?? this.currentStream?.entryId ?? null;
    if (entryId === null) return;
    this.eventStore.append({
      type: "assistant.response.suppressed",
      entryId,
      reason,
    });
    this.currentTurnAssistantEntryId = null;
    this.currentStream = null;
  }

  private appendPhase(mode: UiMode, force = false): void {
    if (!force && this.eventStore.getProjection().phase.mode === mode) return;
    this.eventStore.append({
      type: "phase.changed",
      phaseId: this.eventStore.createId("phase"),
      mode,
    });
  }

  private completeActiveStreams(): void {
    for (const stream of this.activeStreams()) {
      const content = this.projectedStreamContent(stream);
      this.eventStore.append({
        type: "assistant.stream.completed",
        ...stream,
        ...(content !== undefined ? { content } : {}),
      });
    }
    this.currentStream = null;
    this.currentReasoningStream = null;
  }

  private completeReasoningStream(): void {
    if (!this.currentReasoningStream) return;
    const content = this.projectedStreamContent(this.currentReasoningStream);
    this.eventStore.append({
      type: "assistant.stream.completed",
      ...this.currentReasoningStream,
      ...(content !== undefined ? { content } : {}),
    });
    this.currentReasoningStream = null;
  }

  private interruptActiveStreams(reason: "new-request" | "clear" | "truncate" | "abort"): void {
    for (const stream of this.activeStreams()) {
      const content = this.projectedStreamContent(stream);
      this.eventStore.append({
        type: "assistant.stream.interrupted",
        ...stream,
        reason,
        ...(content !== undefined ? { content } : {}),
      });
    }
    this.currentStream = null;
    this.currentReasoningStream = null;
  }

  private clearRuntimeTracking(): void {
    this.currentStream = null;
    this.currentReasoningStream = null;
    this.currentTurnAssistantEntryId = null;
    this.pendingToolIdsByProviderCallId.clear();
    this.pendingToolOutput.clear();
  }

  /** 从水合投影重建 reporter 的短命运行态，不依赖旧实例内存。 */
  private rebuildRuntimeTracking(): void {
    this.clearRuntimeTracking();
    const projection = this.eventStore.getProjection();
    for (const projected of projection.entries) {
      if (projected.streamId !== undefined) {
        const stream = projection.streams[projected.streamId];
        if (stream?.status === "streaming") {
          if (projected.entry.kind === "thinking") {
            this.currentReasoningStream = { entryId: stream.entryId, streamId: stream.id };
          } else {
            this.currentStream = { entryId: stream.entryId, streamId: stream.id };
          }
        }
      }
      if (projected.toolCallId !== undefined) {
        const tool = projection.toolCalls[projected.toolCallId];
        if (tool && isPendingToolStatus(tool.status)) this.registerPendingTool(tool);
      }
    }
  }

  private activeStreams(): Array<{ entryId: string; streamId: string }> {
    const projection = this.eventStore.getProjection();
    return projection.entries.flatMap((entry) => {
      if (entry.streamId === undefined) return [];
      const stream = projection.streams[entry.streamId];
      return stream?.status === "streaming"
        ? [{ entryId: stream.entryId, streamId: stream.id }]
        : [];
    });
  }

  private projectedStreamContent(stream: { entryId: string }): string | undefined {
    const projected = this.eventStore
      .getProjection()
      .entries.find((entry) => entry.id === stream.entryId);
    return projected?.entry.kind === "assistant" || projected?.entry.kind === "thinking"
      ? projected.entry.content
      : undefined;
  }

  private registerPendingTool(tool: TranscriptToolCallProjection): void {
    appendPendingId(this.pendingToolIdsByProviderCallId, tool.providerCallId, tool.id);
  }

  private resolvePendingToolId(providerCallId: string, expectedArgs?: string): string | undefined {
    const normalizedProviderCallId = normalizeIdentity(providerCallId);
    if (normalizedProviderCallId === undefined) return undefined;
    const projection = this.eventStore.getProjection();
    const pendingIds = this.pendingToolIdsByProviderCallId.get(normalizedProviderCallId) ?? [];

    // Provider ID 跨轮可复用，因此只在当前 pending 队列中 FIFO 解析。
    return pendingIds.find((id) => {
      const tool = projection.toolCalls[id];
      return (
        tool !== undefined &&
        isPendingToolStatus(tool.status) &&
        (expectedArgs === undefined || tool.args === expectedArgs)
      );
    });
  }

  private removePendingTool(tool: TranscriptToolCallProjection): void {
    this.removePendingToolId(tool.id, tool.providerCallId);
  }

  private removePendingToolId(internalToolCallId: string, providerCallId: string): void {
    this.pendingToolOutput.delete(internalToolCallId);
    removePendingId(this.pendingToolIdsByProviderCallId, providerCallId, internalToolCallId);
  }

  private bufferToolOutput(
    toolCallId: string,
    stream: "stdout" | "stderr",
    content: string,
  ): boolean {
    let changed = false;
    let offset = 0;
    while (offset < content.length) {
      const pending = this.pendingToolOutput.get(toolCallId) ?? {
        pieces: [],
        runs: [],
        chars: 0,
      };
      this.pendingToolOutput.set(toolCallId, pending);
      const retained = content.slice(
        offset,
        offset + (TUI_TOOL_OUTPUT_EVENT_SEGMENT_CHARS - pending.chars),
      );
      pending.pieces.push(retained);
      appendToolOutputRun(pending.runs, stream, retained.length);
      pending.chars += retained.length;
      offset += retained.length;
      if (pending.chars === TUI_TOOL_OUTPUT_EVENT_SEGMENT_CHARS) {
        changed = this.flushToolOutput(toolCallId) || changed;
      }
    }
    return changed;
  }

  private flushToolOutput(toolCallId: string): boolean {
    const pending = this.pendingToolOutput.get(toolCallId);
    if (!pending || pending.chars === 0) return false;
    this.eventStore.append({
      type: "tool.output",
      toolCallId,
      segment: {
        content: pending.pieces.join(""),
        runs: pending.runs.map((run): TranscriptToolOutputRun => ({ ...run })),
      },
    });
    this.pendingToolOutput.delete(toolCallId);
    return true;
  }

  private emit(): void {
    this.onProjectionUpdate?.(this.eventStore.getProjection());
  }

  private enqueueDurableTranscript(event: TranscriptEvent): void {
    if (
      this.durableTranscriptSuppressed ||
      !this.durableTranscriptSink ||
      !isDurableTranscriptEvent(event) ||
      !this.durableTranscriptPolicy(event)
    )
      return;
    const durableEvent = {
      ...event,
      sequence: ++this.durableTranscriptSequence,
    };
    this.durableTranscriptTail = this.durableTranscriptTail
      .then(() => this.durableTranscriptSink!.append(durableEvent))
      .catch((error: unknown) => {
        this.durableTranscriptFailure ??= error;
        // Session.recordTranscriptEvent 自身会进入 write-uncertain；这里保留
        // 队列可排空，让 shutdown 的 flushPersistence 观察真实错误。
      });
  }
}

function isRequiredDelegation(toolName: string, rawArgs: string): boolean {
  if (toolName !== "delegate_task") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return true;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const input = parsed as Record<string, unknown>;
  if (input["completion_policy"] === "optional" || input["completion_policy"] === "detached") {
    return false;
  }
  if (input["completion_policy"] === "required") return true;
  return input["background"] !== true;
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function appendPendingId(index: Map<string, string[]>, key: string, id: string): void {
  const pending = index.get(key) ?? [];
  pending.push(id);
  index.set(key, pending);
}

function appendToolOutputRun(
  runs: Array<{ stream: "stdout" | "stderr"; length: number }>,
  stream: "stdout" | "stderr",
  length: number,
): void {
  if (length <= 0) return;
  const last = runs.at(-1);
  if (last?.stream === stream) last.length += length;
  else runs.push({ stream, length });
}

function removePendingId(index: Map<string, string[]>, key: string, id: string): void {
  const pending = index.get(key);
  if (!pending) return;
  const next = pending.filter((candidate) => candidate !== id);
  if (next.length === 0) index.delete(key);
  else index.set(key, next);
}

function isPendingToolStatus(status: ToolCardStatus): boolean {
  return status === "queued" || status === "running" || status === "approval";
}

function boundSubagentToolResultEnvelope(
  result: ToolResultEnvelope,
  maxChars: number,
): ToolResultEnvelope {
  const text = result.projection.text.slice(0, maxChars);
  return {
    ...structuredClone(result),
    projection: {
      ...structuredClone(result.projection),
      text,
    },
    deliveryTruncated: result.deliveryTruncated || text.length < result.projection.text.length,
  };
}
