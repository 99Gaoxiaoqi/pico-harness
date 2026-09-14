/** Durable recovery policy written with every tool dispatch fact. */
export type ToolRecoveryMode =
  | "replay_safe"
  | "idempotent"
  | "reconcile"
  | "reattach"
  | "outcome_unknown"
  | "never_auto_retry";

/** An audit limit, not a truncation policy: oversized calls must never cross T1. */
export const MAX_TOOL_ARGUMENT_AUDIT_BYTES = 1024 * 1024;
