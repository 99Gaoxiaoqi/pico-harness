/**
 * Backward-compatible runtime export. The projection implementation belongs to
 * the engine durable-session boundary; Runtime only re-exports it for existing
 * store/read-model consumers.
 */
export {
  projectRuntimeSessionMessages,
  projectRuntimeSessionMessageEntries,
  projectRuntimeSessionSequencedMessageEntries,
  projectRuntimeSessionTranscriptEventEntries,
  projectRuntimeSessionState,
  projectRuntimeSessionUsage,
} from "../engine/session-runtime-projection.js";
export type {
  SequencedRuntimeEvent,
  RuntimeSessionSequencedMessageEntry,
  RuntimeSessionTranscriptEventEntry,
} from "../engine/session-runtime-projection.js";
