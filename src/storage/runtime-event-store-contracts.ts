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

/**
 * 数据库持有者代际。epoch=0 是迁移兼容态：尚未启用 fence 的旧调用仍可写入；
 * 任一 owner 将 epoch 推进到正数后，所有写入都必须携带完全匹配的 fence。
 */
export interface RuntimeOwnerFence {
  readonly sessionId: string;
  readonly epoch: number;
}

export interface RuntimeFencedWriteOptions {
  readonly ownerFence?: RuntimeOwnerFence;
}

export interface AppendRuntimeEventBatchOptions {
  /** Session sequence CAS checked in the same write transaction as the append. */
  readonly expectedSessionHighWater?: Readonly<Record<string, number>>;
  /** Optional exactly-once identity for one Plan/Graph transition. */
  readonly planOperation?: { readonly operationId: string; readonly fingerprint: string };
  /**
   * 单 session 写 fence；提供时 batch 内全部事件必须属于该 session。
   * 缺省只兼容尚处于 epoch=0 的历史调用方。
   */
  readonly ownerFence?: RuntimeOwnerFence;
}

export interface RuntimeRunProjection {
  readonly sessionId: string;
  readonly runId: string;
  readonly startedEventId?: string;
  readonly startedSequence?: number;
  readonly terminalEventId?: string;
  readonly terminalSequence?: number;
  readonly terminalStatus?: Extract<RuntimeEvent, { kind: "run.terminal" }>["data"]["status"];
  readonly lastEventSequence: number;
}

export interface RuntimePartialSnapshot {
  readonly sessionId: string;
  readonly runId: string;
  readonly partialId: string;
  readonly kind: string;
  readonly version: number;
  readonly payload: unknown;
  readonly updatedAt: string;
}

export interface RuntimePartialSegment {
  readonly sessionId: string;
  readonly runId: string;
  readonly partialId: string;
  readonly segmentIndex: number;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface UpsertRuntimePartialSnapshotInput extends RuntimeFencedWriteOptions {
  readonly sessionId: string;
  readonly runId: string;
  readonly partialId: string;
  readonly kind: string;
  /** 0 creates the snapshot; a positive value is the current version CAS. */
  readonly expectedVersion: number;
  readonly payload: unknown;
  readonly at?: string;
}

export interface AppendRuntimePartialSegmentInput extends RuntimeFencedWriteOptions {
  readonly sessionId: string;
  readonly runId: string;
  readonly partialId: string;
  readonly segmentIndex: number;
  readonly payload: unknown;
  readonly at?: string;
}

export interface ClearRuntimeRunPartialsInput extends RuntimeFencedWriteOptions {
  readonly sessionId: string;
  readonly runId: string;
}

export interface RuntimeRunPartials {
  readonly snapshots: readonly RuntimePartialSnapshot[];
  readonly segments: readonly RuntimePartialSegment[];
}

export type RuntimeToolOperationState = "prepared" | "settled";

export interface RuntimeToolOperation {
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly providerCallId?: string;
  readonly toolName: string;
  readonly argumentsHash: string;
  readonly state: RuntimeToolOperationState;
  readonly version: number;
  readonly preparedEventId: string;
  readonly outcomeEventId?: string;
  readonly preparedAt: string;
  readonly settledAt?: string;
}

/** T1: provider facts + dispatch fact + prepared journal/projection, one transaction. */
export interface PrepareRuntimeToolOperationInput extends RuntimeFencedWriteOptions {
  readonly providerEvents?: readonly RuntimeEvent[];
  readonly dispatchEvent: Extract<RuntimeEvent, { kind: "tool.started" }>;
  readonly toolCallId: string;
  readonly providerCallId?: string;
}

export interface PrepareRuntimeToolOperationResult {
  readonly events: readonly RuntimeEventStoreAppendResult[];
  readonly operation: RuntimeToolOperation;
}

/** T2: immutable result fact + settled journal + operation CAS, one transaction. */
export interface SettleRuntimeToolOperationInput extends RuntimeFencedWriteOptions {
  readonly resultEvent: Extract<RuntimeEvent, { kind: "tool.result.recorded" }>;
  readonly toolCallId: string;
  readonly expectedVersion: number;
}

export interface SettleRuntimeToolOperationResult {
  readonly event: RuntimeEventStoreAppendResult;
  readonly operation: RuntimeToolOperation;
}

export interface RuntimeTranscriptRecordInput extends RuntimeFencedWriteOptions {
  readonly recordId: string;
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly sourceSequence: number;
  readonly kind: string;
  readonly payload: unknown;
  /** UTF-8 text chunks; a page may slice one chunk at a byte boundary. */
  readonly chunks: readonly string[];
  readonly at?: string;
}

export interface RuntimeTranscriptCursor {
  readonly sequence: number;
  readonly chunkIndex: number;
  readonly byteOffset: number;
}

export interface RuntimeTranscriptPageOptions {
  readonly sessionId: string;
  /** Omit only on the first page; the returned value must be reused for the whole traversal. */
  readonly throughSequence?: number;
  readonly direction: "forward" | "backward";
  readonly cursor?: RuntimeTranscriptCursor;
  readonly maxBytes: number;
  readonly limit?: number;
}

export interface RuntimeTranscriptPageItem {
  readonly recordId: string;
  readonly sourceEventId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly chunkIndex: number;
  readonly byteOffset: number;
  readonly text: string;
  readonly byteLength: number;
  readonly at: string;
}

export interface RuntimeTranscriptPage {
  /** Canonical ledger head captured in the same read transaction as this page. */
  readonly revisionSequence: number;
  /** Fixed read waterline; pass unchanged to every subsequent page request. */
  readonly throughSequence: number;
  readonly items: readonly RuntimeTranscriptPageItem[];
  readonly nextCursor?: RuntimeTranscriptCursor;
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

export interface AppendRuntimeSessionStateOptions extends RuntimeFencedWriteOptions {
  readonly eventId?: string;
  readonly now?: () => Date;
}

export interface AppendRuntimeTranscriptEventOptions extends RuntimeFencedWriteOptions {
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

export class RuntimeEventStoreOwnerFenceError extends RuntimeEventStoreIntegrityError {
  constructor(
    readonly sessionId: string,
    readonly expectedEpoch: number | undefined,
    readonly actualEpoch: number,
  ) {
    super(
      expectedEpoch === undefined
        ? `Runtime session ${sessionId} requires owner fence epoch ${actualEpoch}`
        : `Runtime session ${sessionId} owner fence ${expectedEpoch} is stale; current epoch is ${actualEpoch}`,
    );
    this.name = "RuntimeEventStoreOwnerFenceError";
  }
}

export class RuntimeEventStoreVersionConflictError extends RuntimeEventStoreIntegrityError {
  constructor(readonly resource: string) {
    super(`Runtime EventLog resource ${resource} changed concurrently`);
    this.name = "RuntimeEventStoreVersionConflictError";
  }
}

export class RuntimeEventStorePlanOperationConflictError extends RuntimeEventStoreIntegrityError {
  constructor(readonly operationId: string) {
    super(`Plan operation ${operationId} is already bound to another fingerprint`);
    this.name = "RuntimeEventStorePlanOperationConflictError";
  }
}

/**
 * run.terminal 是该 run 唯一 immutable tail；封口后只允许同 eventId 且
 * canonical payload 完全相同的幂等重放。确定性拒绝(事务未提交),读回仲裁
 * 不得翻案——继承 RuntimeEventStoreIntegrityError 即自动落入
 * isDeterministicStoreRefusal。
 */
export class RuntimeEventStoreRunSealedError extends RuntimeEventStoreIntegrityError {
  constructor(
    readonly sessionId: string,
    readonly runId: string,
    readonly eventId: string,
  ) {
    super(
      `Runtime run ${runId} in session ${sessionId} is sealed; event ${eventId} cannot be appended`,
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

/**
 * 原子续跑起点输入。continuationOf 不在输入面出现：store 在同一
 * 事务的 source 快照中计算三元组，并构造唯一 canonical run.started。
 */
export interface StartRuntimeContinuationInput extends RuntimeFencedWriteOptions {
  readonly sessionId: string;
  readonly sourceRunId: string;
  readonly targetRunId: string;
  readonly invocationId: string;
  readonly startEventId: string;
  readonly workDir: string;
  /** 精确重放身份的一部分；重试必须传回同一时间。 */
  readonly startedAt: string;
  readonly now?: () => Date;
  /** 仅用于事务回滚测试；抛错时 claim 与 start 必须一起回滚。 */
  readonly afterClaimBeforeStart?: () => void;
}

export type RuntimeContinuationStartOutcome =
  | {
      readonly status: "started" | "replayed";
      readonly claim: RuntimeContinuationClaim;
      readonly startEvent: Extract<RuntimeEvent, { kind: "run.started" }>;
      readonly append: RuntimeEventStoreAppendResult;
    }
  | { readonly status: "rejected"; readonly reason: RuntimeContinuationClaimRejection };

/** 旧两事务 API 的兼容结果；实现已 fail-closed，新代码不得调用。 */
export type RuntimeContinuationClaimOutcome =
  | {
      readonly status: "claimed";
      readonly claim: RuntimeContinuationClaim;
      /** true=本次为孤儿 claim 幂等改绑(旧 target 从未起跑,锚点换绑到新 target)。 */
      readonly rebound?: boolean;
    }
  | { readonly status: "already_claimed"; readonly claim: RuntimeContinuationClaim }
  | { readonly status: "rejected"; readonly reason: RuntimeContinuationClaimRejection };

export function createRuntimeEventId(prefix = "runtime-event"): string {
  return `${prefix}:${randomUUID()}`;
}
