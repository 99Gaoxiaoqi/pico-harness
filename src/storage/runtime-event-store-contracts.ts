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

/**
 * ADR 29 §4 源封口(fail-closed):已终态(run.terminal 落库)的 run 拒收新的
 * 非恢复类 append。确定性拒绝(事务未提交),读回仲裁不得翻案——继承
 * RuntimeEventStoreIntegrityError 即自动落入 isDeterministicStoreRefusal。
 */
export class RuntimeEventStoreRunSealedError extends RuntimeEventStoreIntegrityError {
  constructor(
    readonly sessionId: string,
    readonly runId: string,
    readonly eventId: string,
  ) {
    super(
      `Runtime run ${runId} in session ${sessionId} is already terminal; event ${eventId} cannot be appended`,
    );
    this.name = "RuntimeEventStoreRunSealedError";
  }
}

/** ADR 29:sessions scope `runtime_continuation_claims` 行的读取形态。 */
export interface RuntimeContinuationClaim {
  readonly claimId: string;
  readonly sourceSessionId: string;
  readonly sourceRunId: string;
  /** 源前缀末事件 seq(claim 时刻该 run 全部事件的 seq 上界)。 */
  readonly sourceHighWater: number;
  /** seq∈[1..high_water] 的 {seq, eventId, canonical payload} 序列化 sha256(hex)。 */
  readonly sourcePrefixDigest: string;
  readonly targetSessionId: string;
  readonly targetRunId: string;
  readonly createdAt: string;
}

/** claim 被类型化拒绝的原因(不抛裸 SqliteError)。 */
export type RuntimeContinuationClaimRejection =
  | "run_not_found"
  /** 源 run 无终态事实——活跃 run 不得被 claim(ADR 29 弃案:软中断续跑)。 */
  | "run_active"
  /** 源 run 终态非 interrupted(completed/failed/cancelled 不可续)。 */
  | "run_not_interrupted"
  /** target run 已作为其他 claim 的续跑目标。 */
  | "target_conflict";

/** claimContinuation 结果:成功 / 已被 claim(C1 冲突)/ 类型化拒绝。 */
export type RuntimeContinuationClaimOutcome =
  | { readonly status: "claimed"; readonly claim: RuntimeContinuationClaim }
  | { readonly status: "already_claimed"; readonly claim: RuntimeContinuationClaim }
  | { readonly status: "rejected"; readonly reason: RuntimeContinuationClaimRejection };

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
}
