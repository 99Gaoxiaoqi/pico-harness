import type { Message } from "../schema/message.js";
import type { CommitReceipt } from "./session-persistence.js";
import { Session } from "./session.js";

/**
 * Engine-facing view of the durable runtime store.
 *
 * The engine must be able to carry the store through a nested run, but it must
 * not know which database/event-store implementation owns it.  Runtime keeps
 * the concrete adapter and validates this structural capability at the
 * boundary.
 */
export type EngineRuntimeAuthority = object;

const engineRuntimeCapabilityBrand: unique symbol = Symbol("EngineRuntimeCapability");
const issuedEngineRuntimeCapabilities = new WeakSet<object>();

/** The narrow write capability required by a live canonical run. */
export interface EngineRuntimeWriteGuard {
  /** Bind issuance to the durable authority actually owned by this guard. */
  assertRuntimeEventAuthority(authority: EngineRuntimeAuthority): void;
  assertRuntimeEventWriteAllowed(): Promise<void>;
}

export interface EngineRuntimeCapability {
  readonly [engineRuntimeCapabilityBrand]: true;
  readonly sessionId: string;
  readonly workDir: string;
  readonly runtimeAuthority: EngineRuntimeAuthority;
  readonly writeGuard: EngineRuntimeWriteGuard;
  assertBound(scope: EngineRuntimeCapability): void;
}

export interface EngineRuntimeCapabilityInput {
  readonly owner: Session;
  readonly runtimeAuthority: EngineRuntimeAuthority;
}

/** Issue an exact-identity capability that cannot be recreated by object spread. */
export function createEngineRuntimeCapability(
  input: EngineRuntimeCapabilityInput,
): EngineRuntimeCapability {
  if (!Session.isRuntimeCapabilityOwner(input.owner)) {
    throw new Error("Runtime capability owner must be an actual Session");
  }
  const sessionId = input.owner.id;
  const workDir = input.owner.workDir;
  const assertAuthority = (): void => {
    Session.prototype.assertRuntimeEventAuthority.call(input.owner, input.runtimeAuthority);
  };
  assertAuthority();
  const capability: EngineRuntimeCapability = Object.freeze({
    [engineRuntimeCapabilityBrand]: true as const,
    sessionId,
    workDir,
    runtimeAuthority: input.runtimeAuthority,
    writeGuard: input.owner,
    assertBound: (scope: EngineRuntimeCapability): void => {
      if (scope !== capability) {
        throw new Error(`Runtime capability is not bound to Session ${sessionId}`);
      }
      assertAuthority();
    },
  });
  issuedEngineRuntimeCapabilities.add(capability);
  return capability;
}

/** Runtime adapters must reject structural lookalikes before using their authority. */
export function assertIssuedEngineRuntimeCapability(capability: EngineRuntimeCapability): void {
  if (!issuedEngineRuntimeCapabilities.has(capability)) {
    throw new Error(`Runtime capability for Session ${capability.sessionId} was not issued`);
  }
  capability.assertBound(capability);
}

export interface EngineRuntimeHistoryEntry {
  readonly eventId: string;
  readonly message: Message;
}

export interface EngineRuntimeEvidenceReference {
  readonly schemaVersion: number;
  readonly contentHash: string;
  readonly sessionId: string;
  readonly kind: "tool-exchange";
}

export interface EngineRuntimeCheckpointInput {
  readonly checkpointId: string;
  readonly coveredEventCount: number;
  readonly sourceDigest: string;
  readonly throughEventId: string;
  readonly summary: Message;
}

/** A runtime run as seen by the ReAct engine. */
export interface EngineRuntimeRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly workDir: string;
  readonly runtimeEventWriteGuard?: EngineRuntimeWriteGuard;
  readonly runtimeCapability?: EngineRuntimeCapability;

  claimsSession(session: Session): boolean;
  commitMessages(session: Session, messages: readonly Message[]): Promise<void>;
  commitMessageOnce(session: Session, eventId: string, message: Message): Promise<CommitReceipt>;
  readModelHistory(): Promise<Message[]>;
  readModelHistoryEntries(): Promise<readonly EngineRuntimeHistoryEntry[]>;
  readSessionProjectionEntries(): Promise<readonly EngineRuntimeHistoryEntry[]>;
  run<Result>(execute: () => Promise<Result>, signal?: AbortSignal): Promise<Result>;
  recordTurnStarted(turn: number): Promise<void>;
  recordCheckpoint(input: EngineRuntimeCheckpointInput): Promise<void>;
  recordToolStarted(toolCallId: string, toolName: string, argumentsJson: string): Promise<void>;
  recordTranscriptMessage(message: Message): Promise<void>;
  registerToolEvidence(toolCallId: string, evidence: EngineRuntimeEvidenceReference): void;
}

export interface EngineRuntimeRunStartOptions {
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly parentToolCallId?: string;
  readonly capability: EngineRuntimeCapability;
}

export interface EngineRuntimeReconcileOptions {
  readonly capability: EngineRuntimeCapability;
}

export interface EngineRuntimeRepairProjectionOptions {
  readonly capability: EngineRuntimeCapability;
}

/**
 * Runtime lifecycle and ambient-context port consumed by AgentEngine.
 * Implementations live in `src/runtime`; this contract intentionally lives in
 * `src/engine` so the dependency direction points toward the abstraction.
 */
export interface EngineRuntimePort {
  currentRun(): EngineRuntimeRun | undefined;
  currentToolCallId(): string | undefined;
  runWithToolCall<Result>(toolCallId: string, execute: () => Result): Result;
  reconcileIncompleteRuns(options: EngineRuntimeReconcileOptions): Promise<readonly string[]>;
  repairSessionProjection(
    session: Session,
    options: EngineRuntimeRepairProjectionOptions,
  ): Promise<boolean>;
  startRun(options: EngineRuntimeRunStartOptions): Promise<EngineRuntimeRun>;
  commitExternalMessages(session: Session, messages: readonly Message[]): Promise<boolean>;
  commitExternalMessageOnce(
    session: Session,
    eventId: string,
    message: Message,
  ): Promise<CommitReceipt | undefined>;
}

let defaultEngineRuntimePort: EngineRuntimePort | undefined;

/** Runtime composition may register its adapter for Sessions created by legacy hosts. */
export function configureDefaultEngineRuntimePort(port: EngineRuntimePort): void {
  defaultEngineRuntimePort = port;
}

export function getDefaultEngineRuntimePort(): EngineRuntimePort | undefined {
  return defaultEngineRuntimePort;
}
