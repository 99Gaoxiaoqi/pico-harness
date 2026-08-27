import type { Message } from "../schema/message.js";
import type { Session } from "./session.js";
import type { RuntimeEvent } from "./session-runtime-event.js";
import type { EngineRuntimeCapability, EngineRuntimePort } from "./runtime-port.js";
import type { RuntimeSessionForkSeedEntry } from "./session-runtime-projection.js";
import type { PersistedInteractionMode, SessionRuntimeStateWritePatch } from "./session-runtime.js";
import type { PersistedSessionSettings } from "./session-runtime.js";
import type { FileHistoryRewindTransactionHooks } from "../safety/file-history.js";

/**
 * Engine-side contract for the durable fork lifecycle.
 *
 * The fork coordinator owns operation/journal semantics, while Runtime owns
 * event-store implementation details.  Keep the store opaque here so the
 * engine does not import RuntimeRun or any other runtime implementation.
 */
export type SessionForkRuntimeAuthority = object;

export interface SessionForkRuntimeWriteGuard {
  assertRuntimeEventWriteAllowed(): Promise<void>;
}

export type SessionForkRuntimeCapability = EngineRuntimeCapability;

export interface SessionForkModelCheckpoint {
  readonly coveredMessageCount: number;
  readonly summary: Message;
}

export interface SessionForkPublicationCapability {
  assertOwned(): Promise<void>;
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

/** Fork publication 可能已发生，调用方不得猜测回滚工作区。 */
export class SessionForkPublicationUncertainError extends Error {
  constructor(
    readonly targetSessionId: string,
    options?: ErrorOptions,
  ) {
    super(`Fork ${targetSessionId} 的发布结果无法安全判定`, options);
    this.name = "SessionForkPublicationUncertainError";
  }
}

export interface SessionForkBootstrapSeed {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly operationId?: string;
  readonly operationCreatedAt?: string;
  /** Source-sequenced canonical model and durable transcript facts. */
  readonly seedEntries: readonly RuntimeSessionForkSeedEntry[];
  readonly modelCheckpoint?: SessionForkModelCheckpoint;
  readonly sourceThroughEventId?: string;
  readonly statePublication?: {
    readonly patch: SessionRuntimeStateWritePatch;
    readonly eventId: string;
    readonly at: string;
  };
  readonly workDir: string;
  readonly runtimeAuthority: SessionForkRuntimeAuthority;
}

export interface SessionForkBootstrapOptions extends SessionForkBootstrapSeed {
  readonly publication: SessionForkPublicationCapability;
  readonly workflowEvents?: readonly RuntimeEvent[];
}

export interface SessionForkRuntimePort {
  /** Explicit RuntimePort attached when fork opens a durable source Session. */
  readonly engineRuntimePort: EngineRuntimePort;

  /** Run the Engine-owned fork coordinator without making Session load its implementation. */
  forkSession(input: {
    readonly workDir: string;
    readonly picoHome: string;
    readonly fileHistoryBaseDir: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    /** Durable caller-owned identity used to resume the same fork after a crash. */
    readonly operationId?: string;
    /** @deprecated Accepted for source compatibility but ignored by canonical forks. */
    readonly targetMode?: PersistedInteractionMode;
    readonly throughEventId?: string;
    /** Safe settings frozen by the host when a historical boundary predates settings facts. */
    readonly fallbackSettings?: PersistedSessionSettings;
    /** If publication fails after an external file transaction, dispositions must only clean up. */
    readonly cleanupOnlyOnFailure?: boolean;
    /** Durable workspace phase for a combined conversation + code rewind. */
    readonly rewind?: {
      readonly checkpointId: string;
      readonly expectedFingerprints?: Readonly<Record<string, string>>;
      readonly fileTransactionHooks?: FileHistoryRewindTransactionHooks;
    };
  }): Promise<void>;

  /** Validate the current model history without exposing Runtime's read-model implementation. */
  validateModelHistory(events: readonly RuntimeEvent[]): void;

  reconcileIncompleteRuns(options: {
    readonly capability: SessionForkRuntimeCapability;
  }): Promise<readonly string[]>;

  repairSessionProjection(
    session: Session,
    options: { readonly capability: SessionForkRuntimeCapability },
  ): Promise<boolean>;

  bootstrapFork(options: SessionForkBootstrapOptions): Promise<void>;

  deriveBootstrapRunId(options: SessionForkBootstrapSeed): string;
}
