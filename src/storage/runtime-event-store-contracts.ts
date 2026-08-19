import { randomUUID } from "node:crypto";
import type { SessionCursor } from "../engine/session-persistence.js";
import type { RuntimeEvent } from "./runtime-event.js";

/**
 * 会话账本的共享契约(票 09,JSONL 纪元退役)。
 *
 * 错误类、选项/结果类型与常量在 JSONL 与 SQLite 两代 store 间保持同名同形;
 * 旧实现(src/storage/runtime-event-store.ts)删除后,契约落位于此,
 * SqliteRuntimeEventStore 与全部消费方从这里导入,消费者签名零漂移。
 */

export const RUNTIME_EVENT_STORE_MAX_PAGE_SIZE = 250;

export interface RuntimeSessionManifest {
  readonly schemaVersion: 2;
  readonly sessionId: string;
  readonly workDir: string;
  readonly historySource: "runtime-event-v2";
  readonly createdAt: string;
}

export interface RuntimeEventStoreOptions {
  /** Canonical Pico workspace state root holding pico.sqlite. */
  readonly storageRoot: string;
}

export interface InitializeRuntimeSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
  readonly now?: () => Date;
}

export interface RuntimeSessionManifestCursor {
  readonly createdAt: string;
  readonly sessionId: string;
}

export interface RuntimeSessionManifestPageOptions {
  readonly upperBound: RuntimeSessionManifestCursor;
  readonly before?: RuntimeSessionManifestCursor;
  readonly limit?: number;
}

export interface RuntimeEventStoreEntryPageOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface RuntimeEventStoreAppendResult {
  readonly inserted: boolean;
  readonly cursor: SessionCursor;
  readonly committedAt: string;
}

export interface AppendRuntimeEventBatchOptions {
  /** Session sequence CAS checked in the same write transaction as the append. */
  readonly expectedSessionHighWater?: Readonly<Record<string, number>>;
  /** Optional exactly-once identity for one Plan/Graph transition. */
  readonly planOperation?: { readonly operationId: string; readonly fingerprint: string };
}

export interface RuntimeEventStoreEntry {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

/** One workspace session read in a batched store-level listing pass. */
export interface WorkspaceRuntimeSessionSnapshot {
  readonly manifest: RuntimeSessionManifest;
  readonly entries: readonly RuntimeEventStoreEntry[];
}

export interface RuntimeSessionProjectionSnapshot {
  readonly manifest: RuntimeSessionManifest;
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor?: SessionCursor;
}

export interface RuntimeSessionProjectionDelta {
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly cursor: SessionCursor;
}

export interface AppendRuntimeSessionStateOptions {
  readonly eventId?: string;
  readonly now?: () => Date;
}

export interface AppendRuntimeTranscriptEventOptions {
  readonly eventId?: string;
}

export class SessionCatalogIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionCatalogIntegrityError";
  }
}

export class RuntimeEventStoreIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventStoreIntegrityError";
  }
}

export class RuntimeEventStoreHighWaterConflictError extends RuntimeEventStoreIntegrityError {
  constructor(
    readonly sessionId: string,
    readonly expectedHighWater: number,
    readonly actualHighWater: number,
  ) {
    super(
      `Runtime session ${sessionId} high-water changed from ${expectedHighWater} to ${actualHighWater}`,
    );
    this.name = "RuntimeEventStoreHighWaterConflictError";
  }
}

export class RuntimeEventStorePlanOperationConflictError extends RuntimeEventStoreIntegrityError {
  constructor(readonly operationId: string) {
    super(`Plan operation ${operationId} is already bound to another fingerprint`);
    this.name = "RuntimeEventStorePlanOperationConflictError";
  }
}

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
}
