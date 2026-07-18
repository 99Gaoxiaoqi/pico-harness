/**
 * Backward-compatible Runtime export. Session durable read-model semantics are
 * implemented in the engine contract layer; Runtime keeps this module as an
 * adapter-facing import path.
 */
export {
  projectRuntimeEventsToMessages,
  materializeRuntimeHistory,
  projectRuntimeEventsToMessageEntries,
  materializeRuntimeHistoryEntries,
  RuntimeEventReadModelIntegrityError,
} from "../engine/session-runtime-read-model.js";
export type { RuntimeHistoryProjectionEntry } from "../engine/session-runtime-read-model.js";
