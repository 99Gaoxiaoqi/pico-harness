import type { Message } from "../schema/message.js";
import type { Session } from "./session.js";
import type { RuntimeEvent } from "../runtime/runtime-event.js";

/**
 * Engine-side contract for the durable fork lifecycle.
 *
 * The fork coordinator owns operation/journal semantics, while Runtime owns
 * event-store implementation details.  Keep the store opaque here so the
 * engine does not import RuntimeRun or any other runtime implementation.
 */
export type SessionForkRuntimeStore = object;

export interface SessionForkRuntimeWriteGuard {
  assertRuntimeEventWriteAllowed(): Promise<void>;
}

export interface SessionForkModelCheckpoint {
  readonly coveredMessageCount: number;
  readonly summary: Message;
}

export interface SessionForkProjectedMessage {
  readonly eventId: string;
  readonly message: Message;
}

export interface SessionForkBootstrapOptions {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly operationId?: string;
  readonly operationCreatedAt?: string;
  readonly messages: readonly Message[];
  readonly modelCheckpoint?: SessionForkModelCheckpoint;
  readonly sourceThroughEventId?: string;
  readonly workDir: string;
  readonly store?: SessionForkRuntimeStore;
}

export interface SessionForkRuntimePort {
  /** Validate the current model history without exposing Runtime's read-model implementation. */
  validateModelHistory(events: readonly RuntimeEvent[]): void;

  /** Project a frozen event prefix into its model-visible messages and owning event IDs. */
  projectModelMessages(events: readonly RuntimeEvent[]): readonly SessionForkProjectedMessage[];

  reconcileIncompleteRuns(options: {
    readonly sessionId: string;
    readonly workDir: string;
    readonly store?: SessionForkRuntimeStore;
    readonly writeGuard: SessionForkRuntimeWriteGuard;
  }): Promise<readonly string[]>;

  repairSessionProjection(
    session: Session,
    options: { readonly workDir: string; readonly store?: SessionForkRuntimeStore },
  ): Promise<boolean>;

  bootstrapFork(options: SessionForkBootstrapOptions): Promise<void>;

  deriveBootstrapRunId(options: SessionForkBootstrapOptions): string;
}
