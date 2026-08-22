import type { Message } from "../schema/message.js";
import type { Session } from "./session.js";
import type { RuntimeEvent } from "./session-runtime-event.js";
import type { EngineRuntimeCapability, EngineRuntimePort } from "./runtime-port.js";
import type { RuntimeSessionForkSeedEntry } from "./session-runtime-projection.js";
import type { SessionRuntimeStateWritePatch } from "./session-runtime.js";

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
