/**
 * TUI compatibility facade.
 * Runtime services live in src/runtime so non-interactive hosts never import the TUI layer.
 */
export {
  createSessionRuntime as createTuiRuntimeState,
  createDelegationCompletionMessage,
  DelegationCompletionWakeQueue,
  DelegationWakeCoordinator,
} from "../runtime/session-runtime.js";

export type {
  SessionRuntime as TuiRuntimeState,
  SessionRuntimeOptions as TuiRuntimeStateOptions,
  DelegationCompletionWakeQueueOptions,
  DelegationWakeCoordinatorOptions,
} from "../runtime/session-runtime.js";
