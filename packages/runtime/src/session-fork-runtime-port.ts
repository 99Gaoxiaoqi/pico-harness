import type {
  ExecutionBoundary,
  SessionForkModelCheckpoint,
  SessionRuntimeStateWritePatch,
} from "@pico/core";
import type { EngineRuntimeCapability } from "./runtime-capability.js";
import type { RuntimeSessionForkSeedEntry } from "./session-runtime-projection.js";

/** Opaque Runtime event-store authority used during a durable fork. */
export type RuntimeSessionForkAuthority = object;

export interface RuntimeSessionForkWriteGuard {
  assertRuntimeEventWriteAllowed(): Promise<void>;
}

export interface RuntimeSessionForkPublicationCapability {
  assertOwned(): Promise<void>;
}

export type RuntimeSessionForkStateWritePatch = SessionRuntimeStateWritePatch & {
  readonly boundary: ExecutionBoundary;
};

/** Immutable source facts used to bootstrap a target session's Runtime ledger. */
export interface RuntimeSessionForkBootstrapSeed {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly operationId?: string;
  readonly operationCreatedAt?: string;
  /** Source-sequenced canonical model and durable transcript facts. */
  readonly seedEntries: readonly RuntimeSessionForkSeedEntry[];
  readonly modelCheckpoint?: SessionForkModelCheckpoint;
  readonly sourceThroughEventId?: string;
  readonly statePublication?: {
    /** Canonical forks publish the complete inherited authority boundary atomically. */
    readonly patch: RuntimeSessionForkStateWritePatch;
    readonly eventId: string;
    readonly at: string;
  };
  readonly workDir: string;
  readonly runtimeAuthority: RuntimeSessionForkAuthority;
}

export interface RuntimeSessionForkBootstrapOptions<
  RuntimeEvent,
> extends RuntimeSessionForkBootstrapSeed {
  readonly publication: RuntimeSessionForkPublicationCapability;
  readonly workflowEvents?: readonly RuntimeEvent[];
}

/**
 * Runtime's durable fork lifecycle boundary.
 *
 * The port remains generic over Session, the outer RuntimePort and filesystem
 * rewind hooks. This keeps Runtime independent from Engine construction and
 * Host filesystem transactions while preserving one atomic fork protocol.
 */
export interface RuntimeSessionForkPort<Session, EnginePort, RuntimeEvent, RewindHooks> {
  /** Explicit RuntimePort attached when fork opens a durable source Session. */
  readonly engineRuntimePort: EnginePort;

  /** Run the outer fork coordinator without making Session load its implementation. */
  forkSession(input: {
    readonly workDir: string;
    readonly picoHome: string;
    readonly fileHistoryBaseDir: string;
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    /** Durable caller-owned identity used to resume the same fork after a crash. */
    readonly operationId?: string;
    readonly throughEventId?: string;
    /** If publication fails after an external file transaction, dispositions must only clean up. */
    readonly cleanupOnlyOnFailure?: boolean;
    /** Durable workspace phase for a combined conversation + code rewind. */
    readonly rewind?: {
      readonly checkpointId: string;
      readonly expectedFingerprints?: Readonly<Record<string, string>>;
      readonly fileTransactionHooks?: RewindHooks;
    };
  }): Promise<void>;

  /** Validate current model history without exposing Runtime's read-model implementation. */
  validateModelHistory(events: readonly RuntimeEvent[]): void;

  reconcileIncompleteRuns(options: {
    readonly capability: EngineRuntimeCapability;
  }): Promise<readonly string[]>;

  repairSessionProjection(
    session: Session,
    options: { readonly capability: EngineRuntimeCapability },
  ): Promise<boolean>;

  bootstrapFork(options: RuntimeSessionForkBootstrapOptions<RuntimeEvent>): Promise<void>;

  deriveBootstrapRunId(options: RuntimeSessionForkBootstrapSeed): string;
}
