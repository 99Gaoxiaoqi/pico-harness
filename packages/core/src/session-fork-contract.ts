import type { Message } from "./message.js";

/** Stable run-id namespace used only for durable fork bootstrap publications. */
export const RUNTIME_FORK_BOOTSTRAP_RUN_PREFIX = "fork-bootstrap:";

/** 供增量 fork 继承的模型历史 checkpoint。 */
export interface SessionForkModelCheckpoint {
  readonly coveredMessageCount: number;
  readonly summary: Message;
}

/** A durable target fact conflicts with the frozen fork payload. */
export class SessionForkRuntimeConflictError extends Error {
  constructor(
    message: string,
    readonly reason: "staging_corrupt" | "target_conflict",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionForkRuntimeConflictError";
  }
}

/** Fork publication may have happened; callers must not guess workspace rollback. */
export class SessionForkPublicationUncertainError extends Error {
  constructor(
    readonly targetSessionId: string,
    options?: ErrorOptions,
  ) {
    super(`Fork ${targetSessionId} 的发布结果无法安全判定`, options);
    this.name = "SessionForkPublicationUncertainError";
  }
}
