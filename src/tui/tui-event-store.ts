/**
 * @deprecated Transcript 投影已迁移到 presentation 层。这个模块仅保留 TUI 旧命名兼容。
 */
export * from "../presentation/transcript-event-store.js";

export {
  TRANSCRIPT_CHECKPOINT_INLINE_RESULT_BUDGET_CHARS as TUI_CHECKPOINT_INLINE_RESULT_BUDGET_CHARS,
  TRANSCRIPT_CHECKPOINT_INLINE_RESULT_RECENT_COUNT as TUI_CHECKPOINT_INLINE_RESULT_RECENT_COUNT,
  TRANSCRIPT_SUBAGENT_MESSAGE_LIMIT_CHARS as TUI_SUBAGENT_MESSAGE_LIMIT_CHARS,
  TRANSCRIPT_SUBAGENT_TOOL_ARGS_LIMIT_CHARS as TUI_SUBAGENT_TOOL_ARGS_LIMIT_CHARS,
  TRANSCRIPT_SUBAGENT_TOOL_RESULT_LIMIT_CHARS as TUI_SUBAGENT_TOOL_RESULT_LIMIT_CHARS,
  TRANSCRIPT_SUBAGENT_TRACE_MAX_ITEMS as TUI_SUBAGENT_TRACE_MAX_ITEMS,
  TRANSCRIPT_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS as TUI_TOOL_OUTPUT_PROJECTION_LIMIT_CHARS,
  TranscriptEventStore as TuiEventStore,
  initialTranscriptProjection as initialTuiProjection,
  projectTranscriptEntriesForRendering as projectTuiEntriesForRendering,
  projectTranscriptEvents as projectTuiEvents,
  reduceTranscriptEvent as reduceTuiEvent,
} from "../presentation/transcript-event-store.js";

export type {
  TranscriptEntry as TuiEntry,
  TranscriptEvent as TuiEvent,
  TranscriptEventDraft as TuiEventDraft,
  TranscriptEventStoreOptions as TuiEventStoreOptions,
  TranscriptEventStoreSnapshot as TuiEventStoreSnapshot,
  TranscriptIdentityScope as TuiIdentityScope,
  TranscriptPhaseMode as UiMode,
  TranscriptPhaseProjection as TuiPhaseProjection,
  TranscriptProjectedEntry as TuiProjectedEntry,
  TranscriptProjection as TuiProjection,
  TranscriptRenderIdentity as TuiRenderIdentity,
  TranscriptStreamProjection as TuiStreamProjection,
  TranscriptSubagentLifecycle as TuiSubagentLifecycle,
  TranscriptSubagentProjection as TuiSubagentProjection,
  TranscriptSubagentTraceItem as TuiSubagentTraceItem,
  TranscriptToolCallProjection as TuiToolCallProjection,
  TranscriptToolOutputChunk as TuiToolOutputChunk,
  TranscriptToolOutputRun as TuiToolOutputRun,
  TranscriptToolOutputSegment as TuiToolOutputSegment,
} from "../presentation/transcript-event-store.js";
