import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SQLInputValue } from "node:sqlite";
import type { SessionCursor } from "../../engine/session-persistence.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStateWritePatch,
  type SessionRuntimeStateWritePatch,
} from "../../engine/session-runtime.js";
import {
  createInitialSessionSummaryFold,
  finalizeSessionSummary,
  foldSessionSummaryEvent,
  type CliSessionSummary,
  type SessionSummaryFold,
} from "../../engine/session-summary.js";
import {
  projectRuntimeModelMessage,
  runtimeEventHasModelHistoryEntry,
} from "../../engine/runtime-model-message.js";
import type { Message } from "../../schema/message.js";
import type { DurableTranscriptEvent } from "../../presentation/transcript-event-store.js";
import { canonicalizeWorkspacePath } from "../../paths/pico-paths.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  decodeRuntimeEvent,
  decodeRuntimeEventJson,
  isLegacyDecodeOnlyKind,
  type RuntimeEvent,
} from "../runtime-event.js";
import {
  RUNTIME_EVENT_STORE_MAX_PAGE_SIZE,
  RuntimeEventStoreHighWaterConflictError,
  RuntimeEventStoreIntegrityError,
  RuntimeEventStorePlanOperationConflictError,
  RuntimeEventStoreRunSealedError,
  SessionCatalogIntegrityError,
  createRuntimeEventId,
  type AppendRuntimeEventBatchOptions,
  type AppendRuntimeSessionStateOptions,
  type AppendRuntimeTranscriptEventOptions,
  type InitializeRuntimeSessionOptions,
  type RuntimeContinuationClaim,
  type RuntimeContinuationClaimOutcome,
  type RuntimeEventStoreAppendResult,
  type RuntimeEventStoreEntry,
  type RuntimeEventStoreEntryPageOptions,
  type RuntimeEventStoreOptions,
  type RuntimeSessionManifest,
  type RuntimeSessionManifestCursor,
  type RuntimeSessionManifestPageOptions,
  type RuntimeSessionProjectionDelta,
  type RuntimeSessionProjectionSnapshot,
  type WorkspaceRuntimeSessionSnapshot,
} from "../runtime-event-store-contracts.js";
import { operationalDatabasePath, type OperationalDatabaseLease } from "./sqlite-database.js";
import { logger } from "../../observability/logger.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "./workspace-scopes.js";
import { prepareWorkspaceSqliteStorageSync } from "./sqlite-workspace-storage.js";

/**
 * SQLite 纪元的会话账本(ADR 24 §4.1,票 02)。
 *
 * 语义对齐旧 JSONL RuntimeEventStore:appendBatch 单 BEGIN IMMEDIATE 内完成
 * MAX(event_seq)+1 分配、event_id 点查幂等(canonical payload 深比较,冲突
 * 抛错)、plan/graph operationId 恰好一次 CAS(经 operation_id 投影列索引查询,
 * 不全量扫);全部读方法 SQL 化,分页是真 keyset(event_seq > after LIMIT)。
 * 类型与错误类来自共享契约(runtime-event-store-contracts.ts,票 09 起),
 * 消费者签名零漂移(装配接线在票 03)。
 *
 * 已知语义位移(相对 JSONL 纪元):
 * - 深比较基于键排序 canonical JSON,重放方键序不同不再误判冲突;
 * - event_id 是库级主键,跨会话同 id 直接拒绝(JSONL 纪元各会话独立文件,
 *   理论上可重复;实践上 id 均 UUID 派生,无碰撞路径)。
 */
export class SqliteRuntimeEventStore {
  readonly storageRoot: string;
  private readonly lease: OperationalDatabaseLease;
  private closed = false;

  constructor(options: RuntimeEventStoreOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("SqliteRuntimeEventStore requires storageRoot");
    }
    // 单一 scope 组合点:prepare 永远传全量,形状断言按全集 fail-closed。
    const preparation = prepareWorkspaceSqliteStorageSync(options.storageRoot, ALL_WORKSPACE_SQLITE_SCOPES);
    this.storageRoot = preparation.lease.storageRoot;
    this.lease = preparation.lease;
  }

  /** 归还数据库 lease(引用计数;最后一个归还者关闭连接)。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lease.release();
  }

  async initializeSession(
    options: InitializeRuntimeSessionOptions,
  ): Promise<RuntimeSessionManifest> {
    const workDir = canonicalizeWorkspacePath(options.workDir);
    return this.write(() => {
      const existing = this.readSessionRow(options.sessionId);
      if (existing) {
        if (existing.work_dir !== workDir) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime session ${options.sessionId} belongs to another workspace`,
          );
        }
        return manifestFromRow(existing);
      }
      // createdAt 只在真正建行时求值:调用方可能传入"首拍锚定"时钟
      // (prestartedRunClock),对已存在会话不得消耗它的第一拍。
      const createdAt = (options.now ?? (() => new Date()))().toISOString();
      this.lease.database
        .prepare(
          `INSERT INTO sessions (session_id, work_dir, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(options.sessionId, workDir, createdAt, createdAt);
      const manifest: RuntimeSessionManifest = {
        schemaVersion: 2,
        sessionId: options.sessionId,
        workDir,
        historySource: "runtime-event-v2",
        createdAt,
      };
      // 建行即写初始 catalog 行:finalize(manifest, 初始 fold),与旧实现同款。
      this.upsertCatalogRowLocked(options.sessionId, manifest, createInitialSessionSummaryFold(), {
        lastEventSeq: 0,
        eventCount: 0,
        storageBytes: 0,
      });
      return manifest;
    });
  }

  async append(event: RuntimeEvent): Promise<RuntimeEventStoreAppendResult> {
    const results = await this.appendBatch([event]);
    return results[0]!;
  }

  /**
   * 单 BEGIN IMMEDIATE 内完成:会话水位读取与一致性断言、expectedSessionHighWater
   * CAS、planOperation 恰好一次身份检查、event_id 点查幂等(深比较)、sequence
   * 分配与插入、sessions 水位与 fork_parent 维护。
   */
  async appendBatch(
    events: readonly RuntimeEvent[],
    options: AppendRuntimeEventBatchOptions = {},
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    const canonicalEvents = events.map(canonicalizeRuntimeEvent);
    if (canonicalEvents.length === 0) return [];
    const txId = randomUUID();
    const transactionCommittedAt = new Date().toISOString();
    return this.write(() =>
      this.appendBatchLocked(canonicalEvents, options, txId, transactionCommittedAt),
    );
  }

  async appendPlanOperation(
    events: readonly RuntimeEvent[],
    operation: {
      readonly operationId: string;
      readonly fingerprint: string;
      readonly expectedSessionSequence: number;
    },
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    const sessionId = events[0]?.sessionId;
    if (!sessionId || events.some((event) => event.sessionId !== sessionId)) {
      throw new Error("Plan operation events must belong to one session");
    }
    return appendRuntimeEventBatchWithArbitration(this, events, {
      expectedSessionHighWater: { [sessionId]: operation.expectedSessionSequence },
      planOperation: operation,
    });
  }

  /**
   * Graph Mode 操作与 {@link appendPlanOperation} 共用同一 operationId +
   * fingerprint CAS 信封(恰好一次持久身份),机制完全一致。
   */
  async appendGraphOperation(
    events: readonly RuntimeEvent[],
    operation: {
      readonly operationId: string;
      readonly fingerprint: string;
      readonly expectedSessionSequence: number;
    },
  ): Promise<readonly RuntimeEventStoreAppendResult[]> {
    const sessionId = events[0]?.sessionId;
    if (!sessionId || events.some((event) => event.sessionId !== sessionId)) {
      throw new Error("Graph operation events must belong to one session");
    }
    return appendRuntimeEventBatchWithArbitration(this, events, {
      expectedSessionHighWater: { [sessionId]: operation.expectedSessionSequence },
      planOperation: operation,
    });
  }

  async appendSessionState(
    sessionId: string,
    patch: SessionRuntimeStateWritePatch,
    options: AppendRuntimeSessionStateOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
    const normalized = normalizeSessionRuntimeStateWritePatch(patch);
    if (!normalized) throw new Error("Runtime session state write patch is invalid");
    return appendRuntimeEventWithArbitration(
      this,
      sessionStateRuntimeEventOf(sessionId, normalized, options),
    );
  }

  async appendTranscriptEvent(
    sessionId: string,
    event: DurableTranscriptEvent,
    options: AppendRuntimeTranscriptEventOptions = {},
  ): Promise<RuntimeEventStoreAppendResult> {
    return appendRuntimeEventWithArbitration(
      this,
      transcriptRuntimeEventOf(sessionId, event, options),
    );
  }

  async readRun(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    return (await this.read(() => this.readRunEntriesLocked(sessionId, runId))).map(
      ({ event }) => event,
    );
  }

  async readSession(sessionId: string): Promise<RuntimeEvent[]> {
    return (await this.readSessionEntries(sessionId)).map(({ event }) => event);
  }

  async readSessionEvent(
    sessionId: string,
    eventId: string,
  ): Promise<RuntimeEventStoreEntry | undefined> {
    return this.read(() => {
      const row = this.lease.database
        .prepare(
          "SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events WHERE session_id = ? AND event_id = ?",
        )
        .get(sessionId, eventId);
      return row === undefined ? undefined : entryFromRow(assertEventRow(row));
    });
  }

  /**
   * event_id 批量点查(单读事务,只读)。ADR 27 P1 写失败读回仲裁专用:
   * 与 appendBatchLocked 幂等分支同一条 event_id 主键点查路径(readEventRow),
   * canonical 载荷比较沿用 payload_json 字符串口径,不引入第二种比较。
   */
  async readEventRowsByEventIds(
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, RuntimeEventPointRead>> {
    return this.read(() => {
      const rows = new Map<string, RuntimeEventPointRead>();
      for (const eventId of eventIds) {
        const row = this.readEventRow(eventId);
        if (!row) continue;
        rows.set(
          row.event_id,
          {
            eventId: row.event_id,
            sessionId: row.session_id,
            eventSeq: row.event_seq,
            payloadJson: row.payload_json,
            at: row.at,
          },
        );
      }
      return rows;
    });
  }

  async readSessionEntries(sessionId: string): Promise<RuntimeEventStoreEntry[]> {
    return this.read(() => this.readSessionEntriesLocked(sessionId));
  }

  /**
   * 按 kind 子集读取的事件切片(经 (session_id, kind, event_seq) 索引,票 04):
   * 投影消费方(压缩读模型、plan/graph 折叠、transcript 深读)以本方法替代
   * readSessionEntries 全量读——折叠函数不动,只换数据来源。切片与全会话水位
   * (headSequence,会话末条 event_seq,空会话为 0)在单读事务内取得,保持快照一致。
   */
  async readSessionEntriesOfKinds(
    sessionId: string,
    kinds: readonly string[],
  ): Promise<SqliteSessionEventSlice> {
    const normalized = [...new Set(kinds)];
    if (normalized.length === 0 || normalized.some((kind) => !kind.trim())) {
      throw new Error("SqliteRuntimeEventStore kind slice requires non-empty event kinds");
    }
    const placeholders = normalized.map(() => "?").join(", ");
    return this.read(() => ({
      entries: (
        this.lease.database
          .prepare(
            `SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events
             WHERE session_id = ? AND kind IN (${placeholders})
             ORDER BY event_seq ASC`,
          )
          .all(sessionId, ...normalized) as unknown[]
      ).map((row) => entryFromRow(assertEventRow(row as Record<string, unknown>))),
      headSequence: this.readHeadSequenceLocked(sessionId),
    }));
  }

  /** 按 kind 取首条(经 kind 索引;fork 父链等正向点查消费方)。 */
  async readFirstSessionEntryOfKind(
    sessionId: string,
    kind: string,
  ): Promise<RuntimeEventStoreEntry | undefined> {
    return this.readSessionEntryOfKindLocked(sessionId, kind, "ASC");
  }

  /** 按 kind 取末条(经 kind 索引;压缩 checkpoint 末条查找等反向点查消费方)。 */
  async readLastSessionEntryOfKind(
    sessionId: string,
    kind: string,
  ): Promise<RuntimeEventStoreEntry | undefined> {
    return this.readSessionEntryOfKindLocked(sessionId, kind, "DESC");
  }

  /**
   * run 事件 + 全会话水位(单读事务快照,票 04):boundary inspect 等 run 边界
   * 消费方直读——run 内任意 kind 的事件(含 run.started/终态后新进事件)都要
   * 可见,kind 切片表达不了"该 run 的全部事件",故走 run 索引整读。
   */
  async readSessionRunBoundary(
    sessionId: string,
    runId: string,
  ): Promise<SqliteSessionEventSlice> {
    return this.read(() => ({
      entries: this.readRunEntriesLocked(sessionId, runId),
      headSequence: this.readHeadSequenceLocked(sessionId),
    }));
  }

  // ------------------------------------------------------------------
  // runtime_continuation_claims:ADR 29 continuation claim(中断 run 续跑锚)
  // ------------------------------------------------------------------

  /**
   * ADR 29:claim 一个 interrupted 终态的 source run 作为续跑前缀锚。
   *
   * 全部步骤在单个 BEGIN IMMEDIATE 写事务内完成(与并发 append/claim 串行化,
   * 事务内预查即终局,不依赖捕获 UNIQUE 约束异常):
   * 1. 预查 (source_session_id, source_run_id) 既有 claim → already_claimed
   *    (C1 冲突返回类型化结果,不抛裸 SqliteError);target run 已被占用 →
   *    rejected(target_conflict);
   * 2. 读源 run 账本(run 索引):无事件 → run_not_found;无 run.terminal →
   *    run_active(活跃 run 不可被 claim);终态非 interrupted →
   *    run_not_interrupted(C2 前半);
   * 3. source_high_water = 该 run 全部事件的 seq 上界(末条 run 事件的
   *    event_seq);digest 覆盖会话账本 seq∈[1..high_water] 的**全部**事件
   *    (含 interleaved 的其他 run 事件——会话账本是单一序列,续跑锚引用的是
   *    会话前缀,与模型上下文"同 session 事件流天然含前缀"的口径一致);
   * 4. INSERT claim 行(C3:claim 事务只读源账本、只写 claims 行)。
   *
   * 源封口(C4)不由本方法承担:interrupted 终态本身即触发 appendBatchLocked
   * 的 run seal 防线,claim 只需终态校验。
   */
  async claimContinuation(
    sourceSessionId: string,
    sourceRunId: string,
    targetRunId: string,
    options: { readonly now?: () => Date } = {},
  ): Promise<RuntimeContinuationClaimOutcome> {
    return this.write(() => {
      const existingBySource = this.readContinuationClaimRowLocked(
        "SELECT " + CONTINUATION_CLAIM_ROW_COLUMNS + " FROM runtime_continuation_claims WHERE source_session_id = ? AND source_run_id = ?",
        [sourceSessionId, sourceRunId],
      );
      if (existingBySource) {
        return { status: "already_claimed" as const, claim: existingBySource };
      }
      const existingByTarget = this.readContinuationClaimRowLocked(
        "SELECT " + CONTINUATION_CLAIM_ROW_COLUMNS + " FROM runtime_continuation_claims WHERE target_session_id = ? AND target_run_id = ?",
        [sourceSessionId, targetRunId],
      );
      if (existingByTarget) {
        return { status: "rejected" as const, reason: "target_conflict" as const };
      }

      const runEntries = this.readRunEntriesLocked(sourceSessionId, sourceRunId);
      if (runEntries.length === 0) {
        return { status: "rejected" as const, reason: "run_not_found" as const };
      }
      const terminal = runEntries
        .map(({ event }) => event)
        .find(
          (event): event is Extract<RuntimeEvent, { kind: "run.terminal" }> =>
            event.kind === "run.terminal",
        );
      if (!terminal) {
        return { status: "rejected" as const, reason: "run_active" as const };
      }
      if (terminal.data.status !== "interrupted") {
        return { status: "rejected" as const, reason: "run_not_interrupted" as const };
      }
      // 前缀 = 该 run 全部事件的 seq 上界:run 事件按 event_seq 升序读出,末条即上界。
      const highWater = runEntries.at(-1)!.sequence;
      const prefixRows = this.lease.database
        .prepare(
          "SELECT event_seq, event_id, payload_json FROM runtime_events WHERE session_id = ? AND event_seq <= ? ORDER BY event_seq ASC",
        )
        .all(sourceSessionId, highWater) as Array<Record<string, unknown>>;
      // 账本 seq 由 MAX+1 稠密分配且不删行;前缀缺洞即 digest 不完整,fail-closed。
      if (prefixRows.length !== highWater) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime session ${sourceSessionId} prefix up to ${highWater} is not dense`,
        );
      }
      const claim: RuntimeContinuationClaim = {
        claimId: createRuntimeEventId("continuation-claim"),
        sourceSessionId,
        sourceRunId,
        sourceHighWater: highWater,
        sourcePrefixDigest: continuationPrefixDigest(prefixRows),
        // ADR 29:跨 session 续跑不在本决策——target 与 source 同 session。
        targetSessionId: sourceSessionId,
        targetRunId,
        createdAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      this.lease.database
        .prepare(
          `INSERT INTO runtime_continuation_claims (
             claim_id, source_session_id, source_run_id, source_high_water,
             source_prefix_digest, target_session_id, target_run_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.claimId,
          claim.sourceSessionId,
          claim.sourceRunId,
          claim.sourceHighWater,
          claim.sourcePrefixDigest,
          claim.targetSessionId,
          claim.targetRunId,
          claim.createdAt,
        );
      return { status: "claimed" as const, claim };
    });
  }

  /** 按 source run 点查既有 claim(claim 结果读回/对账用,只读事务)。 */
  async findContinuationClaimBySourceRun(
    sessionId: string,
    runId: string,
  ): Promise<RuntimeContinuationClaim | undefined> {
    return this.read(() =>
      this.readContinuationClaimRowLocked(
        "SELECT " + CONTINUATION_CLAIM_ROW_COLUMNS + " FROM runtime_continuation_claims WHERE source_session_id = ? AND source_run_id = ?",
        [sessionId, runId],
      ),
    );
  }

  private readContinuationClaimRowLocked(
    sql: string,
    params: readonly SQLInputValue[],
  ): RuntimeContinuationClaim | undefined {
    const row = this.lease.database.prepare(sql).get(...params);
    return row === undefined ? undefined : continuationClaimFromRow(row as Record<string, unknown>);
  }

  /** run seal 点查(runtime_events_by_run 索引);只在写事务内调用。 */
  private hasRunTerminalLocked(sessionId: string, runId: string): boolean {
    return (
      this.lease.database
        .prepare(
          "SELECT 1 FROM runtime_events WHERE session_id = ? AND run_id = ? AND kind = 'run.terminal' LIMIT 1",
        )
        .get(sessionId, runId) !== undefined
    );
  }

  private async readSessionEntryOfKindLocked(
    sessionId: string,
    kind: string,
    direction: "ASC" | "DESC",
  ): Promise<RuntimeEventStoreEntry | undefined> {
    if (!kind.trim()) {
      throw new Error("SqliteRuntimeEventStore kind point lookup requires a non-empty kind");
    }
    return this.read(() => {
      const row = this.lease.database
        .prepare(
          `SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events
           WHERE session_id = ? AND kind = ? ORDER BY event_seq ${direction} LIMIT 1`,
        )
        .get(sessionId, kind);
      return row === undefined ? undefined : entryFromRow(assertEventRow(row as Record<string, unknown>));
    });
  }

  /** Bounded sequence page for cooperative background scans(真 keyset 分页)。 */
  async readSessionEntriesPage(
    sessionId: string,
    options: RuntimeEventStoreEntryPageOptions = {},
  ): Promise<RuntimeEventStoreEntry[]> {
    const afterSequence = normalizePageOffset(options.afterSequence, "afterSequence");
    const limit = normalizePageLimit(options.limit);
    return this.read(() => {
      const rows = this.lease.database
        .prepare(
          "SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events WHERE session_id = ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?",
        )
        .all(sessionId, afterSequence, limit);
      return rows.map((row) => entryFromRow(assertEventRow(row)));
    });
  }

  /**
   * Kind 索引有界扫描(票 07 读路径查询化):memory 崩溃恢复按 kind 找
   * run.terminal、evidence reader 按 kind 取消息快照,替代逐会话全量重放。
   * bounds 均为闭开区间:afterSequence 排他,upToSequence 含端。
   */
  async readSessionEventsByKind(
    sessionId: string,
    kind: string,
    options: SqliteEventKindScanOptions = {},
  ): Promise<RuntimeEventStoreEntry[]> {
    const afterSequence =
      options.afterSequence === undefined
        ? undefined
        : normalizePageOffset(options.afterSequence, "afterSequence");
    const upToSequence =
      options.upToSequence === undefined
        ? undefined
        : normalizePageOffset(options.upToSequence, "upToSequence");
    const order = options.order ?? "asc";
    const limit = options.limit === undefined ? undefined : normalizePageLimit(options.limit);
    return this.read(() => {
      const clauses = ["session_id = ?", "kind = ?"];
      const params: SQLInputValue[] = [sessionId, kind];
      if (afterSequence !== undefined) {
        clauses.push("event_seq > ?");
        params.push(afterSequence);
      }
      if (upToSequence !== undefined) {
        clauses.push("event_seq <= ?");
        params.push(upToSequence);
      }
      if (options.modelOnly === true) {
        clauses.push("visibility = 'model'", "partial = 0");
      }
      const rows = this.lease.database
        .prepare(
          `SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events
           WHERE ${clauses.join(" AND ")}
           ORDER BY event_seq ${order === "desc" ? "DESC" : "ASC"}${limit === undefined ? "" : " LIMIT ?"}`,
        )
        .all(...(limit === undefined ? params : [...params, limit]));
      return rows.map((row) => entryFromRow(assertEventRow(row as Record<string, unknown>)));
    });
  }

  /**
   * Run 索引有界扫描(runtime_events_by_run):memory 恢复按 run 定位 run.started
   * 与 run 内模型消息。beforeSequence 排他(terminal 边界),afterSequence 排他。
   */
  async readSessionEventsForRun(
    sessionId: string,
    runId: string,
    options: SqliteEventRunScanOptions = {},
  ): Promise<RuntimeEventStoreEntry[]> {
    const afterSequence =
      options.afterSequence === undefined
        ? undefined
        : normalizePageOffset(options.afterSequence, "afterSequence");
    const beforeSequence =
      options.beforeSequence === undefined
        ? undefined
        : normalizePageOffset(options.beforeSequence, "beforeSequence");
    const order = options.order ?? "asc";
    const limit = options.limit === undefined ? undefined : normalizePageLimit(options.limit);
    return this.read(() => {
      const clauses = ["session_id = ?", "run_id = ?"];
      const params: SQLInputValue[] = [sessionId, runId];
      if (options.kind !== undefined) {
        clauses.push("kind = ?");
        params.push(options.kind);
      }
      if (afterSequence !== undefined) {
        clauses.push("event_seq > ?");
        params.push(afterSequence);
      }
      if (beforeSequence !== undefined) {
        clauses.push("event_seq < ?");
        params.push(beforeSequence);
      }
      if (options.modelOnly === true) {
        clauses.push("visibility = 'model'", "partial = 0");
      }
      const rows = this.lease.database
        .prepare(
          `SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events
           WHERE ${clauses.join(" AND ")}
           ORDER BY event_seq ${order === "desc" ? "DESC" : "ASC"}${limit === undefined ? "" : " LIMIT ?"}`,
        )
        .all(...(limit === undefined ? params : [...params, limit]));
      return rows.map((row) => entryFromRow(assertEventRow(row as Record<string, unknown>)));
    });
  }

  /**
   * evidence reader 的消息快照直读:message.committed 全可见性口径,截至
   * maxSequence(含端),替代 readSessionEntries 全量读后过滤。
   */
  async readSessionMessageEventsUpTo(
    sessionId: string,
    maxSequence: number,
  ): Promise<RuntimeEventStoreEntry[]> {
    return this.readSessionEventsByKind(sessionId, "message.committed", {
      upToSequence: maxSequence,
    });
  }

  async readSessionManifest(sessionId: string): Promise<RuntimeSessionManifest | undefined> {
    return this.read(() => {
      const row = this.readSessionRow(sessionId);
      return row ? manifestFromRow(row) : undefined;
    });
  }

  async listSessionManifests(): Promise<RuntimeSessionManifest[]> {
    return this.read(() => this.listSessionManifestsLocked());
  }

  async getSessionManifestScanUpperBound(): Promise<RuntimeSessionManifestCursor | undefined> {
    const first = (await this.listSessionManifests())[0];
    return first ? { createdAt: first.createdAt, sessionId: first.sessionId } : undefined;
  }

  /** Bounded manifest page for background maintenance. */
  async listSessionManifestsPage(
    options: RuntimeSessionManifestPageOptions,
  ): Promise<RuntimeSessionManifest[]> {
    const upperBound = normalizeManifestCursor(options.upperBound, "upperBound");
    const before = options.before ? normalizeManifestCursor(options.before, "before") : undefined;
    const limit = normalizePageLimit(options.limit);
    return this.read(() =>
      this.listSessionManifestsLocked()
        .filter((manifest) => compareManifestToCursor(manifest, upperBound) >= 0)
        .filter((manifest) => !before || compareManifestToCursor(manifest, before) > 0)
        .slice(0, limit),
    );
  }

  /** 单读事务内读取全部会话的 manifest + 事件(列表类调用方批量路径)。 */
  async readWorkspaceSessions(): Promise<WorkspaceRuntimeSessionSnapshot[]> {
    return this.read(() =>
      this.listSessionManifestsLocked().map((manifest) => ({
        manifest,
        entries: this.readSessionEntriesLocked(manifest.sessionId),
      })),
    );
  }

  /** Reads one internally consistent canonical projection for recovery or repair. */
  async readSessionProjection(
    sessionId: string,
  ): Promise<RuntimeSessionProjectionSnapshot | undefined> {
    return this.read(() => {
      const row = this.readSessionRow(sessionId);
      if (!row) return undefined;
      const entries = this.readSessionEntriesLocked(sessionId);
      const head = entries.at(-1);
      return {
        manifest: manifestFromRow(row),
        entries,
        ...(head
          ? { cursor: cursorFor(sessionId, head.sequence, head.event.eventId) }
          : {}),
      };
    });
  }

  /**
   * Reads only the canonical suffix needed to advance a disposable projection.
   * Undefined means the caller must replay a full snapshot instead of inferring state.
   *
   * 校验窄化(票 04):头部/锚点用信封列点查,事件窗口只解码 (after, through]——
   * 窗口内损坏仍抛(fail-closed),前缀(≤ after)不再逐事件解码。
   */
  async readSessionProjectionDelta(
    sessionId: string,
    after: SessionCursor,
    through: SessionCursor,
  ): Promise<RuntimeSessionProjectionDelta | undefined> {
    if (
      after.logId !== sessionId ||
      through.logId !== sessionId ||
      through.seq <= after.seq
    ) {
      return undefined;
    }
    return this.read(() => {
      const headRow = this.lease.database
        .prepare(
          "SELECT event_seq, event_id FROM runtime_events WHERE session_id = ? ORDER BY event_seq DESC LIMIT 1",
        )
        .get(sessionId) as { event_seq?: unknown; event_id?: unknown } | undefined;
      if (
        !headRow ||
        headRow.event_seq !== through.seq ||
        headRow.event_id !== through.eventId
      ) {
        return undefined;
      }
      const cursorRow = this.lease.database
        .prepare(
          "SELECT event_id FROM runtime_events WHERE session_id = ? AND event_seq = ?",
        )
        .get(sessionId, after.seq) as { event_id?: unknown } | undefined;
      if (!cursorRow || cursorRow.event_id !== after.eventId) {
        return undefined;
      }
      const rows = this.lease.database
        .prepare(
          `SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events
           WHERE session_id = ? AND event_seq > ? AND event_seq <= ?
           ORDER BY event_seq ASC`,
        )
        .all(sessionId, after.seq, through.seq);
      const sliced = rows.map((row) => entryFromRow(assertEventRow(row)));
      const last = sliced.at(-1);
      if (
        !last ||
        last.sequence !== through.seq ||
        last.event.eventId !== through.eventId
      ) {
        return undefined;
      }
      return { entries: sliced, cursor: { ...through } };
    });
  }

  async listRunIds(sessionId: string): Promise<string[]> {
    return this.read(() => {
      const rows = this.lease.database
        .prepare(
          "SELECT DISTINCT run_id FROM runtime_events WHERE session_id = ? AND run_id <> 'session-state'",
        )
        .all(sessionId) as Array<{ run_id?: unknown }>;
      return rows
        .map((row) => (typeof row.run_id === "string" ? row.run_id : ""))
        .filter((runId) => runId !== "")
        .sort();
    });
  }

  async getHeadCursor(sessionId: string): Promise<SessionCursor | undefined> {
    return this.read(() => {
      const row = this.lease.database
        .prepare(
          "SELECT event_seq, event_id FROM runtime_events WHERE session_id = ? ORDER BY event_seq DESC LIMIT 1",
        )
        .get(sessionId) as { event_seq?: unknown; event_id?: unknown } | undefined;
      if (
        !row ||
        typeof row.event_seq !== "number" ||
        typeof row.event_id !== "string"
      ) {
        return undefined;
      }
      return cursorFor(sessionId, row.event_seq, row.event_id);
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.write(() => {
      const row = this.readSessionRow(sessionId);
      if (!row) return false;
      this.lease.database
        .prepare("DELETE FROM runtime_events WHERE session_id = ?")
        .run(sessionId);
      // session_catalog_projection / session_messages 经 FK ON DELETE CASCADE 同事务删除。
      this.lease.database
        .prepare("DELETE FROM sessions WHERE session_id = ?")
        .run(sessionId);
      return true;
    });
  }

  // ------------------------------------------------------------------
  // session_messages:物化投影读路径(启动恢复直读,不再全量重放事件)
  // ------------------------------------------------------------------

  /** Reads the materialized model-visible messages in canonical sequence order. */
  async readSessionMessages(sessionId: string): Promise<Message[]> {
    return this.read(() => this.readSessionMessagesLocked(sessionId));
  }

  private readSessionMessagesLocked(sessionId: string): Message[] {
    const rows = this.lease.database
      .prepare("SELECT payload_json FROM session_messages WHERE session_id = ? ORDER BY sequence ASC")
      .all(sessionId) as Array<{ payload_json?: unknown }>;
    return rows.map((row) => decodeStoredMessage(requireRowString(row["payload_json"], "payload_json"), sessionId));
  }

  private insertSessionMessageLocked(
    sessionId: string,
    sequence: number,
    eventId: string,
    messageTs: string,
    message: Message,
  ): void {
    this.lease.database
      .prepare(
        `INSERT INTO session_messages (session_id, sequence, event_id, message_id, role, message_ts, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        sequence,
        eventId,
        // Message 无独立 id:消息身份锚定在事件上(sequence/event_id),列保留以服务索引。
        eventId,
        message.role,
        messageTs,
        canonicalJson(message),
      );
  }

  /**
   * 会话启动恢复的单读事务直读:manifest + 物化消息 + 状态事件
   * (session.state.committed / model.call.settled,经 by_kind 索引)+ 头部游标。
   */
  async readSessionRecovery(sessionId: string): Promise<SqliteSessionRecovery | undefined> {
    return this.read(() => {
      const row = this.readSessionRow(sessionId);
      if (!row) return undefined;
      const stateRows = this.lease.database
        .prepare(
          `SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events
           WHERE session_id = ? AND kind IN ('session.state.committed', 'model.call.settled')
           ORDER BY event_seq ASC`,
        )
        .all(sessionId);
      const stateEntries = stateRows.map((stateRow) => entryFromRow(assertEventRow(stateRow)));
      const headRow = this.lease.database
        .prepare(
          "SELECT event_seq, event_id FROM runtime_events WHERE session_id = ? ORDER BY event_seq DESC LIMIT 1",
        )
        .get(sessionId) as { event_seq?: unknown; event_id?: unknown } | undefined;
      const cursor =
        headRow &&
        typeof headRow.event_seq === "number" &&
        typeof headRow.event_id === "string"
          ? cursorFor(sessionId, headRow.event_seq, headRow.event_id)
          : undefined;
      return {
        manifest: manifestFromRow(row),
        messages: this.readSessionMessagesLocked(sessionId),
        stateEntries,
        ...(cursor ? { cursor } : {}),
        ...(row.last_event_at ? { lastEventAt: row.last_event_at } : {}),
      };
    });
  }

  // ------------------------------------------------------------------
  // session_catalog_projection:列表/点查(keyset 分页)+ 归档/置顶
  // ------------------------------------------------------------------

  /** catalog 单条 keyset 页:ORDER BY activity_at DESC, session_id ASC;limit+1 判 hasMore。 */
  async readSessionCatalogPage(
    options: SqliteSessionCatalogPageOptions = {},
  ): Promise<SqliteSessionCatalogPage> {
    const after = options.after ? normalizeCatalogCursor(options.after, "after") : undefined;
    const limit = normalizeCatalogPageLimit(options.limit);
    const rawRows = this.read(() => {
      const sql = after
        ? `SELECT ${CATALOG_ROW_COLUMNS} FROM session_catalog_projection
           WHERE activity_at < ? OR (activity_at = ? AND session_id > ?)
           ORDER BY activity_at DESC, session_id ASC
           LIMIT ?`
        : `SELECT ${CATALOG_ROW_COLUMNS} FROM session_catalog_projection
           ORDER BY activity_at DESC, session_id ASC
           LIMIT ?`;
      const rows = after
        ? this.lease.database.prepare(sql).all(after.activityAt, after.activityAt, after.sessionId, limit + 1)
        : this.lease.database.prepare(sql).all(limit + 1);
      return rows.map((row) => assertCatalogRow(row));
    });
    const hasMore = rawRows.length > limit;
    const pageRows = rawRows.slice(0, limit);
    const entries = this.hydrateCatalogRows(pageRows);
    const last = pageRows.at(-1);
    return {
      entries,
      hasMore,
      ...(last ? { nextCursor: { activityAt: last.activity_at, sessionId: last.session_id } } : {}),
    };
  }

  /** 列表全量(分页循环);调用方再做发布过滤(journal 侧读时补查)。 */
  async listSessionCatalogEntries(): Promise<readonly SqliteSessionCatalogEntry[]> {
    const entries: SqliteSessionCatalogEntry[] = [];
    let after: SqliteSessionCatalogCursor | undefined;
    for (;;) {
      const page = await this.readSessionCatalogPage({ ...(after ? { after } : {}) });
      entries.push(...page.entries);
      if (!page.hasMore || !page.nextCursor) break;
      after = page.nextCursor;
    }
    return entries;
  }

  /**
   * 单会话点查:行缺失、fold 损坏或水位失配(headSequence/event_count/storage_bytes
   * 与 sessions 不一致)时先走全量重建阀门,再回读——即 JSONL 纪元 catalog 点查的
   * statSync 水位校验自愈路径。会话本身不存在返回 undefined。decode 与重建阀门
   * 都在读写事务之外驱动(hydrate 的修复写事务不能嵌在读事务里)。
   */
  async findSessionCatalogEntry(sessionId: string): Promise<SqliteSessionCatalogEntry | undefined> {
    const sessionRow = this.read(() => this.readSessionRow(sessionId));
    if (!sessionRow) return undefined;
    const catalogRow = this.read(() => this.readCatalogRowRawLocked(sessionId));
    let entry: SqliteSessionCatalogEntry | undefined;
    let needsRebuild = false;
    if (catalogRow) {
      try {
        entry = this.hydrateCatalogRows([catalogRow])[0];
      } catch (error) {
        if (!(error instanceof SessionCatalogIntegrityError)) throw error;
        needsRebuild = true;
      }
    }
    if (
      !needsRebuild &&
      (!entry ||
        entry.fold.headSequence !== sessionRow.last_event_seq ||
        entry.headEventCount !== sessionRow.event_count ||
        entry.headStorageBytes !== sessionRow.storage_bytes)
    ) {
      needsRebuild = true;
    }
    if (!needsRebuild) return entry;
    this.write(() => this.rebuildCatalogRowLocked(sessionId));
    const repaired = this.read(() => this.readCatalogRowRawLocked(sessionId));
    return repaired ? this.hydrateCatalogRows([repaired])[0] : undefined;
  }

  /** 全量重建该会话的 catalog 行 + session_messages(可丢弃派生,可从事件重建)。 */
  async rebuildSessionCatalogRow(sessionId: string): Promise<boolean> {
    return this.write(() => this.rebuildCatalogRowLocked(sessionId).existed);
  }

  /** 归档/置顶并入 sessions 表(原 desktop session-state 语义:幂等置位,取消置 NULL)。 */
  setSessionArchived(sessionId: string, archived: boolean, now: () => number = Date.now): boolean {
    return this.write(() => {
      if (!this.readSessionRow(sessionId)) return false;
      this.lease.database
        .prepare(
          archived
            ? "UPDATE sessions SET archived_at = COALESCE(archived_at, ?) WHERE session_id = ?"
            : "UPDATE sessions SET archived_at = NULL WHERE session_id = ?",
        )
        .run(...(archived ? [now(), sessionId] : [sessionId]));
      return true;
    });
  }

  setSessionPinned(sessionId: string, pinned: boolean, now: () => number = Date.now): boolean {
    return this.write(() => {
      if (!this.readSessionRow(sessionId)) return false;
      this.lease.database
        .prepare(
          pinned
            ? "UPDATE sessions SET pinned_at = COALESCE(pinned_at, ?) WHERE session_id = ?"
            : "UPDATE sessions SET pinned_at = NULL WHERE session_id = ?",
        )
        .run(...(pinned ? [now(), sessionId] : [sessionId]));
      return true;
    });
  }

  // ------------------------------------------------------------------
  // catalog 写路径内部:fold 装载(增量/重建阀门)、行 UPSERT、全量重建
  // ------------------------------------------------------------------

  /**
   * append 事务装载折叠起点:行存在且水位匹配(headSequence === sessions.last_event_seq,
   * event_count/storage_bytes 作第二校验)走增量;行缺失、fold 损坏或失配即该行
   * 全量重建(防漂移阀门,对齐旧实现 runtime-event-store.ts 行 ~441-448)。
   */
  private loadFoldForAppendLocked(sessionId: string, row: SessionRow): SessionSummaryFold {
    const catalogRow = this.readCatalogRowRawLocked(sessionId);
    if (catalogRow) {
      try {
        const fold = decodeFoldJson(catalogRow.fold_json, sessionId);
        if (
          fold.headSequence === row.last_event_seq &&
          catalogRow.event_count === row.event_count &&
          catalogRow.storage_bytes === row.storage_bytes
        ) {
          return fold;
        }
      } catch (error) {
        if (!(error instanceof SessionCatalogIntegrityError)) throw error;
      }
    }
    return this.rebuildCatalogRowLocked(sessionId).fold;
  }

  private readCatalogRowRawLocked(sessionId: string): CatalogRow | undefined {
    const row = this.lease.database
      .prepare(`SELECT ${CATALOG_ROW_COLUMNS} FROM session_catalog_projection WHERE session_id = ?`)
      .get(sessionId);
    return row === undefined ? undefined : assertCatalogRow(row);
  }

  /**
   * 折叠态 → catalog 行(结构列 + fold_json),与 runtime_events 插入、sessions 水位
   * 同一写事务。is_archived/is_pinned 归 sessions UPDATE 触发器管,UPSERT 不回写。
   */
  private upsertCatalogRowLocked(
    sessionId: string,
    manifest: RuntimeSessionManifest,
    fold: SessionSummaryFold,
    watermark: CatalogWatermark,
  ): void {
    if (fold.headSequence !== watermark.lastEventSeq) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} summary fold head ${fold.headSequence} disagrees with ledger watermark ${watermark.lastEventSeq}`,
      );
    }
    const { summary } = finalizeSessionSummary(manifest, fold);
    const updatedAt = (fold.lastEventAt ?? manifest.createdAt);
    this.lease.database
      .prepare(
        `INSERT INTO session_catalog_projection (
           session_id, work_dir, created_at, updated_at, activity_at, title, first_message,
           last_message, last_message_preview, message_count, fork_parent_session_id, fork_event_id,
           is_published, head_sequence, event_count, storage_bytes, fold_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           work_dir = excluded.work_dir,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           activity_at = excluded.activity_at,
           title = excluded.title,
           first_message = excluded.first_message,
           last_message = excluded.last_message,
           last_message_preview = excluded.last_message_preview,
           message_count = excluded.message_count,
           fork_parent_session_id = excluded.fork_parent_session_id,
           fork_event_id = excluded.fork_event_id,
           is_published = excluded.is_published,
           head_sequence = excluded.head_sequence,
           event_count = excluded.event_count,
           storage_bytes = excluded.storage_bytes,
           fold_json = excluded.fold_json`,
      )
      .run(
        sessionId,
        summary.cwd,
        manifest.createdAt,
        updatedAt,
        updatedAt,
        summary.title ?? null,
        summary.firstMessage ?? null,
        summary.lastMessage ?? null,
        previewOf(summary.lastMessage) ?? null,
        summary.messageCount ?? 0,
        summary.forkFrom ?? null,
        fold.forkEventId ?? null,
        (!fold.hasForkFacts || fold.completedBootstrap) ? 1 : 0,
        fold.headSequence,
        watermark.eventCount,
        watermark.storageBytes,
        encodeFoldJson(fold),
      );
  }

  /**
   * 全量重建:readSessionEntries + 逐条折叠(等价 summaryFromRuntimeSession),
   * 同事务回写 catalog 行并整体重物化 session_messages。
   */
  private rebuildCatalogRowLocked(sessionId: string): {
    readonly existed: boolean;
    readonly fold: SessionSummaryFold;
  } {
    const row = this.readSessionRow(sessionId);
    if (!row) {
      this.lease.database
        .prepare("DELETE FROM session_catalog_projection WHERE session_id = ?")
        .run(sessionId);
      this.lease.database
        .prepare("DELETE FROM session_messages WHERE session_id = ?")
        .run(sessionId);
      return { existed: false, fold: createInitialSessionSummaryFold() };
    }
    const entries = this.readSessionEntriesLocked(sessionId);
    let fold = createInitialSessionSummaryFold();
    for (const { event } of entries) {
      fold = foldSessionSummaryEvent(fold, event);
    }
    this.lease.database
      .prepare("DELETE FROM session_messages WHERE session_id = ?")
      .run(sessionId);
    for (const { sequence, event } of entries) {
      if (!runtimeEventHasModelHistoryEntry(event)) continue;
      const message = projectRuntimeModelMessage(event);
      if (!message) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event ${event.eventId} lost its model history message during rebuild`,
        );
      }
      this.insertSessionMessageLocked(sessionId, sequence, event.eventId, event.at, message);
    }
    this.upsertCatalogRowLocked(sessionId, manifestFromRow(row), fold, {
      lastEventSeq: row.last_event_seq,
      eventCount: row.event_count,
      storageBytes: row.storage_bytes,
    });
    return { existed: true, fold };
  }

  /** 批内行 decode:fold 损坏的行在写事务重建后按主键回读,保持页内顺序。 */
  private hydrateCatalogRows(rows: readonly CatalogRow[]): SqliteSessionCatalogEntry[] {
    const decoded = new Map<string, SqliteSessionCatalogEntry>();
    const corrupt = new Set<string>();
    for (const row of rows) {
      try {
        decoded.set(row.session_id, catalogEntryFromRow(row));
      } catch (error) {
        if (!(error instanceof SessionCatalogIntegrityError)) throw error;
        corrupt.add(row.session_id);
      }
    }
    if (corrupt.size > 0) {
      this.write(() => {
        for (const sessionId of corrupt) this.rebuildCatalogRowLocked(sessionId);
      });
      for (const sessionId of corrupt) {
        const repaired = this.read(() => this.readCatalogRowRawLocked(sessionId));
        if (!repaired) continue;
        decoded.set(sessionId, catalogEntryFromRow(repaired));
      }
    }
    return rows
      .map((row) => decoded.get(row.session_id))
      .filter((entry): entry is SqliteSessionCatalogEntry => entry !== undefined);
  }

  private appendBatchLocked(
    canonicalEvents: readonly RuntimeEvent[],
    options: AppendRuntimeEventBatchOptions,
    txId: string,
    transactionCommittedAt: string,
  ): readonly RuntimeEventStoreAppendResult[] {
    const contexts = new Map<string, SessionAppendContext>();
    for (const event of canonicalEvents) {
      if (contexts.has(event.sessionId)) continue;
      contexts.set(event.sessionId, this.requireSessionAppendContext(event.sessionId));
    }

    for (const [sessionId, expectedHighWater] of Object.entries(
      options.expectedSessionHighWater ?? {},
    )) {
      if (!Number.isSafeInteger(expectedHighWater) || expectedHighWater < 0) {
        throw new Error(`Runtime session ${sessionId} expected high-water is invalid`);
      }
      if (!contexts.has(sessionId)) {
        throw new Error(
          `Runtime session ${sessionId} high-water CAS has no event in this append batch`,
        );
      }
    }

    if (options.planOperation) {
      const { operationId, fingerprint } = options.planOperation;
      if (!operationId.trim() || !/^sha256:[a-f0-9]{64}$/u.test(fingerprint)) {
        throw new Error("Plan operation identity is invalid");
      }
      const bound = this.findOperationEvent([...contexts.keys()], operationId);
      if (bound) {
        if (operationFingerprintOf(bound) !== fingerprint) {
          throw new RuntimeEventStorePlanOperationConflictError(operationId);
        }
        return canonicalEvents.map((event) => {
          const existing = this.readEventRow(event.eventId);
          if (!existing) {
            throw new RuntimeEventStoreIntegrityError(
              `Plan operation ${operationId} replay batch is incomplete`,
            );
          }
          if (existing.session_id !== event.sessionId) {
            throw new RuntimeEventStoreIntegrityError(
              `Runtime event ID ${event.eventId} belongs to another session`,
            );
          }
          return appendResultFor(
            event.sessionId,
            existing.event_seq,
            existing.event_id,
            existing.at,
            false,
          );
        });
      }
    }

    let hasNewEvent = false;
    const requestedEventBySession = new Map<string, Map<string, RuntimeEvent>>();
    const existingRows = new Map<string, RuntimeEventRow>();
    const batchForkParent = new Map<string, string>();
    for (const event of canonicalEvents) {
      const context = contexts.get(event.sessionId)!;
      const requestedEvents =
        requestedEventBySession.get(event.sessionId) ?? new Map<string, RuntimeEvent>();
      requestedEventBySession.set(event.sessionId, requestedEvents);
      const requested = requestedEvents.get(event.eventId);
      if (requested && !isDeepStrictEqual(requested, event)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event ID ${event.eventId} is bound to conflicting payloads in one append batch`,
        );
      }
      if (!requested) requestedEvents.set(event.eventId, event);
      if (
        event.kind === "run.started" &&
        canonicalizeWorkspacePath(event.data.workDir) !== context.row.work_dir
      ) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event workspace does not match session ${event.sessionId}`,
        );
      }
      const existing = this.readEventRow(event.eventId);
      if (!existing) {
        hasNewEvent = true;
        if (event.kind === "session.forked") {
          assertForkTargetAvailable(context.row, batchForkParent, event);
        }
        continue;
      }
      if (existing.session_id !== event.sessionId) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event ID ${event.eventId} belongs to another session`,
        );
      }
      if (existing.payload_json !== canonicalJson(event)) {
        throw new RuntimeEventStoreIntegrityError(
          `Runtime event ID ${event.eventId} is already bound to another payload`,
        );
      }
      existingRows.set(event.eventId, existing);
    }
    if (!hasNewEvent) {
      return canonicalEvents.map((event) => {
        const existing = existingRows.get(event.eventId)!;
        return appendResultFor(
          event.sessionId,
          existing.event_seq,
          existing.event_id,
          existing.at,
          false,
        );
      });
    }

    for (const [sessionId, expectedHighWater] of Object.entries(
      options.expectedSessionHighWater ?? {},
    )) {
      const context = contexts.get(sessionId)!;
      if (context.row.last_event_seq !== expectedHighWater) {
        throw new RuntimeEventStoreHighWaterConflictError(
          sessionId,
          expectedHighWater,
          context.row.last_event_seq,
        );
      }
    }

    const results: RuntimeEventStoreAppendResult[] = [];
    const insertEvent = this.lease.database.prepare(
      `INSERT INTO runtime_events (
         event_id, session_id, invocation_id, run_id, turn_id, event_seq, kind, visibility,
         partial, tx_id, tool_call_id, provider_call_id, operation_id, payload_json, at, committed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // ADR 29 §4 run seal 缓存:key `${sessionId}\0${runId}`;批内一旦插入终态即视为
    // 封口,同批后续该 run 的新事件同样被拒(终态必须是其 run 的最后一条新事实)。
    const runSealCache = new Map<string, boolean>();
    for (const event of canonicalEvents) {
      const context = contexts.get(event.sessionId)!;
      const existing = existingRows.get(event.eventId);
      if (existing) {
        results.push(
          appendResultFor(
            event.sessionId,
            existing.event_seq,
            existing.event_id,
            existing.at,
            false,
          ),
        );
        continue;
      }
      // ADR 29 §4 源封口(fail-closed):已终态的 run 拒收新的非恢复类事件。
      // 幂等重放(上方 existing 分支)不受影响——崩溃后重试同 eventId 永远合法。
      if (!isRecoveryClassSealedAppend(event)) {
        const sealKey = `${event.sessionId}\u0000${event.runId}`;
        let sealed = runSealCache.get(sealKey);
        if (sealed === undefined) {
          sealed = this.hasRunTerminalLocked(event.sessionId, event.runId);
          runSealCache.set(sealKey, sealed);
        }
        if (sealed) {
          throw new RuntimeEventStoreRunSealedError(event.sessionId, event.runId, event.eventId);
        }
      }
      const sequence = context.nextSequence;
      context.nextSequence += 1;
      const payloadJson = canonicalJson(event);
      insertEvent.run(
        event.eventId,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        sequence,
        event.kind,
        event.visibility,
        event.partial ? 1 : 0,
        txId,
        event.refs?.toolCallId ?? null,
        event.refs?.providerCallId ?? null,
        operationIdProjection(event),
        payloadJson,
        event.at,
        event.at,
      );
      context.appendedCount += 1;
      context.appendedBytes += payloadJson.length;
      if (event.kind === "run.terminal") {
        runSealCache.set(`${event.sessionId}\u0000${event.runId}`, true);
      }
      // 增量折叠只吃本批真正 INSERT 的事件(幂等重放不折叠,防 headSequence 超前)。
      context.fold = foldSessionSummaryEvent(context.fold, event);
      context.lastAppendedAt = event.at;
      // message.committed / tool.result.recorded(model、非 partial)同事务物化。
      if (runtimeEventHasModelHistoryEntry(event)) {
        const message = projectRuntimeModelMessage(event);
        if (!message) {
          throw new RuntimeEventStoreIntegrityError(
            `Runtime event ${event.eventId} lost its model history message during projection`,
          );
        }
        this.insertSessionMessageLocked(event.sessionId, sequence, event.eventId, event.at, message);
      }
      // 与旧 store 的批内语义对齐:本批刚插入的事件立刻进入幂等视图,
      // 同批后续同 id 同载荷副本走重放分支(inserted:false,同 sequence),
      // 而不是撞 event_id 主键约束以原始 SqliteError 失败。
      existingRows.set(event.eventId, {
        event_id: event.eventId,
        session_id: event.sessionId,
        event_seq: sequence,
        payload_json: payloadJson,
        at: event.at,
      });
      results.push(appendResultFor(event.sessionId, sequence, event.eventId, event.at, true));
    }

    const updateSessionWatermark = this.lease.database.prepare(
      `UPDATE sessions
       SET last_event_seq = ?, last_tx_id = ?, event_count = ?, storage_bytes = ?, last_event_at = ?, updated_at = ?
       WHERE session_id = ?`,
    );
    const setForkParent = this.lease.database.prepare(
      "UPDATE sessions SET fork_parent_session_id = ? WHERE session_id = ?",
    );
    for (const [sessionId, context] of contexts) {
      if (context.appendedCount === 0) continue;
      const lastEventSeq = context.nextSequence - 1;
      const eventCount = context.row.event_count + context.appendedCount;
      const storageBytes = context.row.storage_bytes + context.appendedBytes;
      updateSessionWatermark.run(
        lastEventSeq,
        txId,
        eventCount,
        storageBytes,
        context.lastAppendedAt ?? context.row.last_event_at,
        transactionCommittedAt,
        sessionId,
      );
      // catalog 投影行与 runtime_events 插入、sessions 水位同一写事务。
      this.upsertCatalogRowLocked(sessionId, manifestFromRow(context.row), context.fold, {
        lastEventSeq,
        eventCount,
        storageBytes,
      });
    }
    for (const [sessionId, parentSessionId] of batchForkParent) {
      if (contexts.get(sessionId)!.row.fork_parent_session_id === null) {
        setForkParent.run(parentSessionId, sessionId);
      }
    }
    return results;
  }

  /** appendBatch 专用:sessions 行 + MAX(event_seq) 水位一致性断言 + catalog fold 装载。 */
  private requireSessionAppendContext(sessionId: string): SessionAppendContext {
    const row = this.readSessionRow(sessionId);
    if (!row) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} must be initialized before appending events`,
      );
    }
    const maxRow = this.lease.database
      .prepare("SELECT COALESCE(MAX(event_seq), 0) AS max_seq FROM runtime_events WHERE session_id = ?")
      .get(sessionId) as { max_seq?: unknown } | undefined;
    const maxSeq = typeof maxRow?.max_seq === "number" ? maxRow.max_seq : 0;
    if (maxSeq !== row.last_event_seq) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime session ${sessionId} watermark disagrees with its event ledger`,
      );
    }
    return {
      row,
      nextSequence: maxSeq + 1,
      appendedCount: 0,
      appendedBytes: 0,
      lastAppendedAt: undefined,
      fold: this.loadFoldForAppendLocked(sessionId, row),
    };
  }

  /** plan/graph CAS:operation_id 投影列 + (session_id, operation_id) 部分索引点查。 */
  private findOperationEvent(
    sessionIds: readonly string[],
    operationId: string,
  ): RuntimeEvent | undefined {
    for (const sessionId of sessionIds) {
      const row = this.lease.database
        .prepare(
          "SELECT payload_json FROM runtime_events WHERE session_id = ? AND operation_id = ? LIMIT 1",
        )
        .get(sessionId, operationId) as { payload_json?: unknown } | undefined;
      if (typeof row?.payload_json === "string") {
        return decodeStoredEvent(row.payload_json);
      }
    }
    return undefined;
  }

  private readEventRow(eventId: string): RuntimeEventRow | undefined {
    const row = this.lease.database
      .prepare(
        "SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events WHERE event_id = ?",
      )
      .get(eventId);
    return row === undefined ? undefined : assertEventRow(row);
  }

  private readSessionRow(sessionId: string): SessionRow | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT session_id, work_dir, created_at, last_event_seq, last_tx_id, event_count,
                storage_bytes, fork_parent_session_id, archived_at, pinned_at, last_event_at, updated_at
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId);
    return row === undefined ? undefined : assertSessionRow(row, sessionId);
  }

  private readSessionEntriesLocked(sessionId: string): RuntimeEventStoreEntry[] {
    const rows = this.lease.database
      .prepare(
        "SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events WHERE session_id = ? ORDER BY event_seq ASC",
      )
      .all(sessionId);
    return rows.map((row) => entryFromRow(assertEventRow(row)));
  }

  /** run 视图直查(runtime_events_by_run 索引),不再读全会话后过滤。 */
  private readRunEntriesLocked(sessionId: string, runId: string): RuntimeEventStoreEntry[] {
    const rows = this.lease.database
      .prepare(
        "SELECT event_id, session_id, event_seq, payload_json, at FROM runtime_events WHERE session_id = ? AND run_id = ? ORDER BY event_seq ASC",
      )
      .all(sessionId, runId);
    return rows.map((row) => entryFromRow(assertEventRow(row)));
  }

  /** 会话末条 event_seq(空会话为 0);与切片查询同事务调用保持快照一致。 */
  private readHeadSequenceLocked(sessionId: string): number {
    const row = this.lease.database
      .prepare(
        "SELECT event_seq FROM runtime_events WHERE session_id = ? ORDER BY event_seq DESC LIMIT 1",
      )
      .get(sessionId) as { event_seq?: unknown } | undefined;
    return typeof row?.event_seq === "number" ? row.event_seq : 0;
  }

  private listSessionManifestsLocked(): RuntimeSessionManifest[] {
    const rows = this.lease.database
      .prepare("SELECT session_id, work_dir, created_at FROM sessions")
      .all();
    return rows
      .map((row) => {
        const sessionId = requireString(row["session_id"], "session_id");
        return {
          schemaVersion: 2 as const,
          sessionId,
          workDir: requireString(row["work_dir"], `sessions[${sessionId}].work_dir`),
          historySource: "runtime-event-v2" as const,
          createdAt: requireString(row["created_at"], `sessions[${sessionId}].created_at`),
        };
      })
      .sort(compareManifestsDescending);
  }

  private write<Result>(operation: () => Result): Result {
    this.assertNotClosed();
    return this.lease.transaction("write", operation);
  }

  private read<Result>(operation: () => Result): Result {
    this.assertNotClosed();
    return this.lease.transaction("read", operation);
  }

  private assertNotClosed(): void {
    if (this.closed) throw new Error("SqliteRuntimeEventStore is closed");
  }
}

/** 读回仲裁点查行(ADR 27 P1):event_id 主键命中行的原始列快照。 */
export interface RuntimeEventPointRead {
  readonly eventId: string;
  readonly sessionId: string;
  readonly eventSeq: number;
  readonly payloadJson: string;
  readonly at: string;
}

/**
 * ADR 27 P1 写失败读回仲裁:包装一次 durable appendBatch,异常时点查该批全部
 * event_id(复用幂等读路径的 event_id 主键点查 + canonical payload 口径):
 * - 全部落地且载荷等价 → 判定实际已成功,用读回结果等价正常返回(inserted:false),
 *   会话保持可写,不进 write_uncertain;
 * - 任一缺失/载荷不等价/属于另一会话 → 重抛原始异常(照旧保守失败);
 * - 读回自身失败(存储不可用) → 同样重抛(仲裁异常等价于不仲裁)。
 *
 * 只仲裁"结果模糊"的失败。store 的确定性拒绝(完整性错误、plan/graph
 * fingerprint CAS 冲突、高水位 CAS 冲突)不模糊——事务确定没有提交,且读回
 * 载荷相等不代表 options 信封(CAS/fingerprint)语义成立,一律原样重抛。
 * 仲裁路径只读,不产生任何新写入(A2)。owner lease 检查在调用方守卫层
 * (writeWithRuntimeEventGuard / Session.enqueuePersistence),不经过本函数:
 * lease 丢失仍直接 fail-closed(P1.2)。
 */
export async function appendRuntimeEventBatchWithArbitration(
  store: SqliteRuntimeEventStore,
  events: readonly RuntimeEvent[],
  options: AppendRuntimeEventBatchOptions = {},
): Promise<readonly RuntimeEventStoreAppendResult[]> {
  try {
    return await store.appendBatch(events, options);
  } catch (error) {
    if (isDeterministicStoreRefusal(error)) throw error;
    const recovered = await arbitrateDurableAppendFailure(store, events).catch(
      () => undefined,
    );
    if (!recovered) throw error;
    logger.warn(
      { eventIds: [...new Set(events.map((event) => event.eventId))] },
      "[runtime-event-store] durable append 失败但读回仲裁确认全部落地,按已成功继续",
    );
    return recovered;
  }
}

/** store 契约层确定性拒绝(事务未提交,读回翻案会掩盖 CAS/完整性语义)。 */
function isDeterministicStoreRefusal(error: unknown): boolean {
  return (
    error instanceof RuntimeEventStoreIntegrityError ||
    error instanceof RuntimeEventStorePlanOperationConflictError ||
    error instanceof RuntimeEventStoreHighWaterConflictError
  );
}

/** 单事件 append 的读回仲裁同构包装(append ≡ appendBatch([event]) 首元素)。 */
export async function appendRuntimeEventWithArbitration(
  store: SqliteRuntimeEventStore,
  event: RuntimeEvent,
): Promise<RuntimeEventStoreAppendResult> {
  const results = await appendRuntimeEventBatchWithArbitration(store, [event]);
  return results[0]!;
}

/**
 * 仲裁本体:逐事件点查。任一 event_id 缺失、绑定到另一会话、或 canonical
 * payload 不等价(与 appendBatchLocked 幂等分支同一条比较)即返回 undefined,
 * 只允许"确认全部落地"一种翻案(A1)。读回抛错由调用方 catch 为不仲裁(A3)。
 */
async function arbitrateDurableAppendFailure(
  store: SqliteRuntimeEventStore,
  events: readonly RuntimeEvent[],
): Promise<readonly RuntimeEventStoreAppendResult[] | undefined> {
  const rows = await store.readEventRowsByEventIds(
    [...new Set(events.map((event) => event.eventId))],
  );
  const results: RuntimeEventStoreAppendResult[] = [];
  for (const event of events) {
    const row = rows.get(event.eventId);
    if (!row) return undefined;
    if (row.sessionId !== event.sessionId) return undefined;
    if (row.payloadJson !== canonicalJson(canonicalizeRuntimeEvent(event))) {
      return undefined;
    }
    results.push(appendResultFor(event.sessionId, row.eventSeq, row.eventId, row.at, false));
  }
  return results;
}

function sessionStateRuntimeEventOf(
  sessionId: string,
  normalized: SessionRuntimeStateWritePatch,
  options: AppendRuntimeSessionStateOptions,
): RuntimeEvent {
  const at = (options.now ?? (() => new Date()))().toISOString();
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: options.eventId ?? createRuntimeEventId("session-state"),
    sessionId,
    invocationId: `session:${sessionId}:state`,
    runId: "session-state",
    turnId: "session-state",
    at,
    partial: false,
    visibility: "internal",
    kind: "session.state.committed",
    data: {
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      patch: structuredClone(normalized),
    },
  };
}

function transcriptRuntimeEventOf(
  sessionId: string,
  event: DurableTranscriptEvent,
  options: AppendRuntimeTranscriptEventOptions,
): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: options.eventId ?? `transcript:${event.eventId}`,
    sessionId,
    invocationId: `session:${sessionId}:transcript`,
    runId: "session-transcript",
    turnId: "transcript",
    at: new Date(event.createdAt).toISOString(),
    partial: false,
    visibility: "transcript",
    kind: "transcript.event.recorded",
    data: { event: structuredClone(event) },
  };
}

interface SessionRow {
  readonly session_id: string;
  readonly work_dir: string;
  readonly created_at: string;
  readonly last_event_seq: number;
  readonly last_tx_id: string | null;
  readonly event_count: number;
  readonly storage_bytes: number;
  readonly fork_parent_session_id: string | null;
  readonly archived_at: number | null;
  readonly pinned_at: number | null;
  readonly last_event_at: string | null;
  readonly updated_at: string;
}

interface RuntimeEventRow {
  readonly event_id: string;
  readonly session_id: string;
  readonly event_seq: number;
  readonly payload_json: string;
  readonly at: string;
}

interface SessionAppendContext {
  readonly row: SessionRow;
  nextSequence: number;
  appendedCount: number;
  appendedBytes: number;
  fold: SessionSummaryFold;
  lastAppendedAt: string | undefined;
}

/** catalog 投影行的原始 SQL 行(未 decode fold)。 */
interface CatalogRow {
  readonly session_id: string;
  readonly work_dir: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly activity_at: string;
  readonly title: string | null;
  readonly first_message: string | null;
  readonly last_message: string | null;
  readonly message_count: number;
  readonly fork_parent_session_id: string | null;
  readonly fork_event_id: string | null;
  readonly is_archived: number;
  readonly is_pinned: number;
  readonly head_sequence: number;
  readonly event_count: number;
  readonly storage_bytes: number;
  readonly fold_json: string;
}

/** catalog 行水位(重建阀门第二校验,对应 JSONL 纪元的 ledgerByteLength)。 */
interface CatalogWatermark {
  readonly lastEventSeq: number;
  readonly eventCount: number;
  readonly storageBytes: number;
}

function assertSessionRow(row: Record<string, unknown>, sessionId: string): SessionRow {
  const lastTxId = optionalString(row["last_tx_id"], `sessions[${sessionId}].last_tx_id`);
  const forkParent = optionalString(
    row["fork_parent_session_id"],
    `sessions[${sessionId}].fork_parent_session_id`,
  );
  const decoded: SessionRow = {
    session_id: requireString(row["session_id"], `sessions[?].session_id`),
    work_dir: requireString(row["work_dir"], `sessions[${sessionId}].work_dir`),
    created_at: requireString(row["created_at"], `sessions[${sessionId}].created_at`),
    last_event_seq: requireSafeInteger(row["last_event_seq"], `sessions[${sessionId}].last_event_seq`),
    last_tx_id: lastTxId,
    event_count: requireSafeInteger(row["event_count"], `sessions[${sessionId}].event_count`),
    storage_bytes: requireSafeInteger(row["storage_bytes"], `sessions[${sessionId}].storage_bytes`),
    fork_parent_session_id: forkParent,
    archived_at: optionalEpoch(row["archived_at"], `sessions[${sessionId}].archived_at`),
    pinned_at: optionalEpoch(row["pinned_at"], `sessions[${sessionId}].pinned_at`),
    last_event_at: optionalString(row["last_event_at"], `sessions[${sessionId}].last_event_at`),
    updated_at: requireString(row["updated_at"], `sessions[${sessionId}].updated_at`),
  };
  if (decoded.session_id !== sessionId) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime session row does not match its primary key: ${sessionId}`,
    );
  }
  return decoded;
}

function assertEventRow(row: Record<string, unknown>): RuntimeEventRow {
  return {
    event_id: requireString(row["event_id"], "runtime_events.event_id"),
    session_id: requireString(row["session_id"], "runtime_events.session_id"),
    event_seq: requireSafeInteger(row["event_seq"], "runtime_events.event_seq"),
    payload_json: requireString(row["payload_json"], "runtime_events.payload_json"),
    at: requireString(row["at"], "runtime_events.at"),
  };
}

function entryFromRow(row: RuntimeEventRow): RuntimeEventStoreEntry {
  return { sequence: row.event_seq, event: decodeStoredEvent(row.payload_json) };
}

/** decode = JSON.parse 后走既有校验;库内损坏 fail-closed 为 store 完整性错误。 */
function decodeStoredEvent(payloadJson: string): RuntimeEvent {
  try {
    return decodeRuntimeEventJson(payloadJson);
  } catch (error) {
    if (error instanceof RuntimeEventStoreIntegrityError) throw error;
    throw new RuntimeEventStoreIntegrityError(
      "Runtime event payload in pico.sqlite is invalid",
      { cause: error },
    );
  }
}

/** 与旧 store 的 canonicalizeRuntimeEvent 相同的规范化(JSON 往返 + 既有校验)。 */
function canonicalizeRuntimeEvent(event: RuntimeEvent): RuntimeEvent {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(event);
  } catch (error) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${event.eventId} must be JSON-serializable: ${String(error)}`,
    );
  }
  if (encoded === undefined) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime event ${event.eventId} encoded to undefined`,
    );
  }
  try {
    const canonical = decodeRuntimeEvent(JSON.parse(encoded) as unknown);
    if (isLegacyDecodeOnlyKind(canonical.kind)) {
      throw new RuntimeEventStoreIntegrityError(
        `Runtime event kind ${canonical.kind} is legacy-only and cannot be appended`,
      );
    }
    return canonical;
  } catch (error) {
    if (error instanceof RuntimeEventStoreIntegrityError) throw error;
    throw new RuntimeEventStoreIntegrityError(`Runtime event ${event.eventId} is invalid`, {
      cause: error,
    });
  }
}

/** canonical JSON:键排序 stringify。深比较 = 两侧 canonical 串相等。 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// ADR 29 continuation claim:行 decode、前缀 digest、run seal 恢复类豁免
// ---------------------------------------------------------------------------

const CONTINUATION_CLAIM_ROW_COLUMNS =
  "claim_id, source_session_id, source_run_id, source_high_water, source_prefix_digest, target_session_id, target_run_id, created_at";

function continuationClaimFromRow(row: Record<string, unknown>): RuntimeContinuationClaim {
  const claimId = requireRowString(row["claim_id"], "runtime_continuation_claims.claim_id");
  const label = `runtime_continuation_claims[${claimId}]`;
  return {
    claimId,
    sourceSessionId: requireRowString(row["source_session_id"], `${label}.source_session_id`),
    sourceRunId: requireRowString(row["source_run_id"], `${label}.source_run_id`),
    sourceHighWater: requireRowSafeInteger(
      row["source_high_water"],
      `${label}.source_high_water`,
    ),
    sourcePrefixDigest: requireRowString(
      row["source_prefix_digest"],
      `${label}.source_prefix_digest`,
    ),
    targetSessionId: requireRowString(row["target_session_id"], `${label}.target_session_id`),
    targetRunId: requireRowString(row["target_run_id"], `${label}.target_run_id`),
    createdAt: requireRowString(row["created_at"], `${label}.created_at`),
  };
}

/**
 * ADR 29 前缀 digest(确定性序列化,与 run.started 的
 * continuationOf.prefixDigest 同一口径):
 * - 输入 = 会话账本 seq∈[1..high_water] 的行,按 event_seq 升序;
 * - 每行序列化为一层 `JSON.stringify({ seq, eventId, payload })`,其中 payload
 *   为库内 canonical payload JSON **字符串**(键排序 stringify 的完整事件对象,
 *   不再做二次解析/重排序);
 * - 逐行后跟换行符 "\n"(含末行),对全文取 sha256,输出 64 位小写 hex。
 */
function continuationPrefixDigest(rows: readonly Record<string, unknown>[]): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    const line = JSON.stringify({
      seq: row["event_seq"],
      eventId: row["event_id"],
      payload: row["payload_json"],
    });
    hash.update(line, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

/**
 * ADR 29 §4 恢复类豁免:携带 ADR 27 P0 恢复标记(data.recovery)的合成
 * tool.result.recorded 允许落在已终态 run 上。现状恢复写入
 * (reconcileIncompleteRuns)均发生在无终态 run(同批先补合成结果、末尾补终态)
 * 或全新恢复 run 上,本豁免当前无生产触发路径,仅为 ADR 语义保留的显式通道。
 */
function isRecoveryClassSealedAppend(event: RuntimeEvent): boolean {
  return event.kind === "tool.result.recorded" && event.data.recovery !== undefined;
}

/** plan/graph 操作身份投影(与旧事件索引的提取规则一致)。 */
function operationIdProjection(event: RuntimeEvent): string | null {
  if (!event.kind.startsWith("plan.") && !event.kind.startsWith("graph.")) return null;
  const data = event.data as Record<string, unknown>;
  return typeof data["operationId"] === "string" ? data["operationId"] : null;
}

function operationFingerprintOf(event: RuntimeEvent): string | undefined {
  const data = event.data as Record<string, unknown>;
  return typeof data["fingerprint"] === "string" ? data["fingerprint"] : undefined;
}

/**
 * fork 目标冲突检测:新 session.forked 声明的父会话必须与库内已绑定的
 * fork_parent_session_id 及本批先行声明一致,否则拒绝(事务回滚)。
 */
function assertForkTargetAvailable(
  row: SessionRow,
  batchForkParent: Map<string, string>,
  event: RuntimeEvent & { kind: "session.forked" },
): void {
  const parentSessionId = event.data.parentSessionId;
  const declared = batchForkParent.get(event.sessionId);
  if (declared === parentSessionId) return;
  if (declared !== undefined || row.fork_parent_session_id !== null) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime session ${event.sessionId} is already forked from another parent`,
    );
  }
  batchForkParent.set(event.sessionId, parentSessionId);
}

function manifestFromRow(row: SessionRow): RuntimeSessionManifest {
  return {
    schemaVersion: 2,
    sessionId: row.session_id,
    workDir: row.work_dir,
    historySource: "runtime-event-v2",
    createdAt: row.created_at,
  };
}

function appendResultFor(
  sessionId: string,
  sequence: number,
  eventId: string,
  committedAt: string,
  inserted: boolean,
): RuntimeEventStoreAppendResult {
  // epoch 恒为 0:rewind/branch 机制移除后无生产者,字段保留为持久化 cursor
  // schema 的一部分(与旧 store 的 cursorForEntries 语义一致)。
  return {
    inserted,
    cursor: cursorFor(sessionId, sequence, eventId),
    committedAt,
  };
}

function cursorFor(sessionId: string, sequence: number, eventId: string): SessionCursor {
  return { logId: sessionId, seq: sequence, epoch: 0, eventId };
}

function compareManifestsDescending(
  left: RuntimeSessionManifest,
  right: RuntimeSessionManifest,
): number {
  return (
    right.createdAt.localeCompare(left.createdAt) || right.sessionId.localeCompare(left.sessionId)
  );
}

/**
 * Returns a positive value when a descending manifest is strictly after the cursor,
 * zero for equality, and a negative value when it is before it.
 */
function compareManifestToCursor(
  manifest: RuntimeSessionManifest,
  cursor: RuntimeSessionManifestCursor,
): number {
  return (
    cursor.createdAt.localeCompare(manifest.createdAt) ||
    cursor.sessionId.localeCompare(manifest.sessionId)
  );
}

function normalizePageOffset(value = 0, field = "offset"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Runtime event store ${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizePageLimit(value = RUNTIME_EVENT_STORE_MAX_PAGE_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > RUNTIME_EVENT_STORE_MAX_PAGE_SIZE) {
    throw new Error(
      `Runtime event store page limit must be between 1 and ${RUNTIME_EVENT_STORE_MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

function normalizeManifestCursor(
  value: RuntimeSessionManifestCursor,
  field: string,
): RuntimeSessionManifestCursor {
  if (
    !value ||
    typeof value.createdAt !== "string" ||
    !value.createdAt.trim() ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim()
  ) {
    throw new Error(`Runtime event store ${field} manifest cursor is invalid`);
  }
  return { createdAt: value.createdAt, sessionId: value.sessionId };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeEventStoreIntegrityError(`SQLite sessions row ${field} is invalid`);
  }
  return value;
}

function requireSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeEventStoreIntegrityError(`SQLite sessions row ${field} is invalid`);
  }
  return value;
}

/** SQLite NULL surfaces as JS null — treat null and undefined as absent. */
function optionalString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new RuntimeEventStoreIntegrityError(`SQLite sessions row ${field} is invalid`);
  }
  return value;
}

function optionalEpoch(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeEventStoreIntegrityError(`SQLite sessions row ${field} is invalid`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// catalog 投影:公开类型、行 decode、fold 编解码、分页参数归一
// ---------------------------------------------------------------------------

/** keyset 游标:排序键 (activity_at DESC, session_id ASC) 的闭开区间边界。 */
export interface SqliteSessionCatalogCursor {
  readonly activityAt: string;
  readonly sessionId: string;
}

/** catalog 行的读取形态:结构列重组的 summary + 行内折叠态 + 归档/置顶。 */
export interface SqliteSessionCatalogEntry {
  readonly summary: CliSessionSummary;
  readonly fold: SessionSummaryFold;
  readonly activityAt: string;
  readonly isArchived: boolean;
  readonly isPinned: boolean;
  /** 行内水位副本(与 sessions 比对即重建阀门输入)。 */
  readonly headSequence: number;
  readonly headEventCount: number;
  readonly headStorageBytes: number;
}

export interface SqliteSessionCatalogPageOptions {
  readonly after?: SqliteSessionCatalogCursor;
  /** 默认 32,硬上限 128。 */
  readonly limit?: number;
}

export interface SqliteSessionCatalogPage {
  readonly entries: readonly SqliteSessionCatalogEntry[];
  readonly hasMore: boolean;
  readonly nextCursor?: SqliteSessionCatalogCursor;
}

/** 启动恢复直读形态:物化消息 + 状态事件 + 头部游标,不再全量重放。 */
export interface SqliteSessionRecovery {
  readonly manifest: RuntimeSessionManifest;
  readonly messages: readonly Message[];
  readonly stateEntries: readonly RuntimeEventStoreEntry[];
  readonly cursor?: SessionCursor;
  readonly lastEventAt?: string;
}

/**
 * kind 切片读取形态(票 04):entries 为按 kind 过滤、event_seq 升序的事件子集;
 * headSequence 为全会话水位(会话末条 event_seq),供投影的 sessionSequence /
 * persistenceSequence 等水位字段保持与全量读口径一致。
 */
export interface SqliteSessionEventSlice {
  readonly entries: readonly RuntimeEventStoreEntry[];
  readonly headSequence: number;
}

/** kind 索引扫描选项(票 07):afterSequence 排他,upToSequence 含端。 */
export interface SqliteEventKindScanOptions {
  readonly afterSequence?: number;
  readonly upToSequence?: number;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  /** 只取 visibility='model' 且非 partial 的事件(投影口径)。 */
  readonly modelOnly?: boolean;
}

/** run 索引扫描选项(票 07):beforeSequence 排他(terminal 边界)。 */
export interface SqliteEventRunScanOptions {
  readonly kind?: string;
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  /** 只取 visibility='model' 且非 partial 的事件(投影口径)。 */
  readonly modelOnly?: boolean;
}

const CATALOG_PAGE_SIZE = 32;
const CATALOG_MAX_PAGE_SIZE = 128;
const CATALOG_ROW_COLUMNS = `session_id, work_dir, created_at, updated_at, activity_at, title,
  first_message, last_message, message_count, fork_parent_session_id, fork_event_id,
  is_archived, is_pinned, head_sequence, event_count, storage_bytes, fold_json`;

function assertCatalogRow(row: Record<string, unknown>): CatalogRow {
  const sessionId = requireRowString(row["session_id"], "session_catalog_projection.session_id");
  return {
    session_id: sessionId,
    work_dir: requireRowString(row["work_dir"], `catalog[${sessionId}].work_dir`),
    created_at: requireRowString(row["created_at"], `catalog[${sessionId}].created_at`),
    updated_at: requireRowString(row["updated_at"], `catalog[${sessionId}].updated_at`),
    activity_at: requireRowString(row["activity_at"], `catalog[${sessionId}].activity_at`),
    title: optionalRowString(row["title"], `catalog[${sessionId}].title`),
    first_message: optionalRowString(row["first_message"], `catalog[${sessionId}].first_message`),
    last_message: optionalRowString(row["last_message"], `catalog[${sessionId}].last_message`),
    message_count: requireRowSafeInteger(row["message_count"], `catalog[${sessionId}].message_count`),
    fork_parent_session_id: optionalRowString(
      row["fork_parent_session_id"],
      `catalog[${sessionId}].fork_parent_session_id`,
    ),
    fork_event_id: optionalRowString(row["fork_event_id"], `catalog[${sessionId}].fork_event_id`),
    is_archived: requireRowFlag(row["is_archived"], `catalog[${sessionId}].is_archived`),
    is_pinned: requireRowFlag(row["is_pinned"], `catalog[${sessionId}].is_pinned`),
    head_sequence: requireRowSafeInteger(row["head_sequence"], `catalog[${sessionId}].head_sequence`),
    event_count: requireRowSafeInteger(row["event_count"], `catalog[${sessionId}].event_count`),
    storage_bytes: requireRowSafeInteger(row["storage_bytes"], `catalog[${sessionId}].storage_bytes`),
    fold_json: requireRowString(row["fold_json"], `catalog[${sessionId}].fold_json`),
  };
}

/** 结构列 → CliSessionSummary + fold decode(fold 损坏抛 SessionCatalogIntegrityError)。 */
function catalogEntryFromRow(row: CatalogRow): SqliteSessionCatalogEntry {
  const fold = decodeFoldJson(row.fold_json, row.session_id);
  return {
    summary: {
      id: row.session_id,
      cwd: row.work_dir,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      messageCount: row.message_count,
      ...(row.title ? { title: row.title } : {}),
      ...(row.first_message ? { firstMessage: row.first_message } : {}),
      ...(row.last_message ? { lastMessage: row.last_message } : {}),
      ...(row.fork_parent_session_id ? { forkFrom: row.fork_parent_session_id } : {}),
      historySource: "runtime-event-v2",
      logId: row.session_id,
      ...(fold.forkEventParent ? { parentLogId: fold.forkEventParent } : {}),
      ...(fold.forkEventId ? { forkEventId: fold.forkEventId } : {}),
    },
    fold,
    activityAt: row.activity_at,
    isArchived: row.is_archived === 1,
    isPinned: row.is_pinned === 1,
    headSequence: row.head_sequence,
    headEventCount: row.event_count,
    headStorageBytes: row.storage_bytes,
  };
}

/**
 * fold_json decode:字段校验集对齐 session-catalog.ts decodeRow 的 fold 部分;
 * 任何缺字段/类型漂移 → SessionCatalogIntegrityError(调用方触发该行全量重建)。
 */
function decodeFoldJson(json: string, sessionId: string): SessionSummaryFold {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new SessionCatalogIntegrityError(
      `Session catalog fold for ${sessionId} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new SessionCatalogIntegrityError(`Session catalog fold for ${sessionId} is not an object`);
  }
  const label = `catalog[${sessionId}].fold`;
  const pendingForkRuns = value["pendingForkRuns"];
  if (
    !Array.isArray(pendingForkRuns) ||
    !pendingForkRuns.every((runId) => typeof runId === "string" && runId)
  ) {
    throw new SessionCatalogIntegrityError(`Session catalog ${label} pendingForkRuns is invalid`);
  }
  return {
    messageCount: requireCatalogNonNegative(value["messageCount"], `${label}.messageCount`),
    ...optionalCatalogString(value["firstMessage"], "firstMessage"),
    ...optionalCatalogString(value["lastMessage"], "lastMessage"),
    ...optionalCatalogString(value["settingsTitle"], "settingsTitle"),
    ...optionalCatalogString(value["settingsForkFrom"], "settingsForkFrom"),
    ...optionalCatalogString(value["forkEventParent"], "forkEventParent"),
    ...optionalCatalogString(value["forkEventId"], "forkEventId"),
    hasForkFacts: requireCatalogBoolean(value["hasForkFacts"], `${label}.hasForkFacts`),
    completedBootstrap: requireCatalogBoolean(value["completedBootstrap"], `${label}.completedBootstrap`),
    pendingForkRuns: pendingForkRuns as readonly string[],
    ...optionalCatalogString(value["lastEventAt"], "lastEventAt"),
    headSequence: requireCatalogNonNegative(value["headSequence"], `${label}.headSequence`),
  };
}

/** 与 session-catalog.ts serializeFold 同款字段集,canonical(键排序)JSON。 */
function encodeFoldJson(fold: SessionSummaryFold): string {
  return canonicalJson({
    messageCount: fold.messageCount,
    ...(fold.firstMessage !== undefined ? { firstMessage: fold.firstMessage } : {}),
    ...(fold.lastMessage !== undefined ? { lastMessage: fold.lastMessage } : {}),
    ...(fold.settingsTitle !== undefined ? { settingsTitle: fold.settingsTitle } : {}),
    ...(fold.settingsForkFrom !== undefined ? { settingsForkFrom: fold.settingsForkFrom } : {}),
    ...(fold.forkEventParent !== undefined ? { forkEventParent: fold.forkEventParent } : {}),
    ...(fold.forkEventId !== undefined ? { forkEventId: fold.forkEventId } : {}),
    hasForkFacts: fold.hasForkFacts,
    completedBootstrap: fold.completedBootstrap,
    pendingForkRuns: fold.pendingForkRuns,
    ...(fold.lastEventAt !== undefined ? { lastEventAt: fold.lastEventAt } : {}),
    headSequence: fold.headSequence,
  });
}

/** TUI 列表预览:在 compactSessionText(≤240)之上再截到 ≤96,超长加省略号。 */
function previewOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= 96 ? value : `${value.slice(0, 95)}…`;
}

function decodeStoredMessage(payloadJson: string, sessionId: string): Message {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch (error) {
    throw new RuntimeEventStoreIntegrityError(
      `Session message payload in pico.sqlite is invalid for session ${sessionId}`,
      { cause: error },
    );
  }
  if (
    !isRecord(value) ||
    (value["role"] !== "system" && value["role"] !== "user" && value["role"] !== "assistant") ||
    typeof value["content"] !== "string"
  ) {
    throw new RuntimeEventStoreIntegrityError(
      `Session message payload in pico.sqlite is invalid for session ${sessionId}`,
    );
  }
  return value as unknown as Message;
}

function normalizeCatalogCursor(
  value: SqliteSessionCatalogCursor,
  field: string,
): SqliteSessionCatalogCursor {
  if (
    !value ||
    typeof value.activityAt !== "string" ||
    !value.activityAt.trim() ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim()
  ) {
    throw new Error(`Session catalog ${field} cursor is invalid`);
  }
  return { activityAt: value.activityAt, sessionId: value.sessionId };
}

function normalizeCatalogPageLimit(value = CATALOG_PAGE_SIZE): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > CATALOG_MAX_PAGE_SIZE) {
    throw new Error(
      `Session catalog page limit must be between 1 and ${CATALOG_MAX_PAGE_SIZE}`,
    );
  }
  return value;
}

function requireRowString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeEventStoreIntegrityError(`SQLite catalog row ${field} is invalid`);
  }
  return value;
}

function optionalRowString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new RuntimeEventStoreIntegrityError(`SQLite catalog row ${field} is invalid`);
  }
  return value;
}

function requireRowSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeEventStoreIntegrityError(`SQLite catalog row ${field} is invalid`);
  }
  return value;
}

function requireRowFlag(value: unknown, field: string): number {
  if (value !== 0 && value !== 1) {
    throw new RuntimeEventStoreIntegrityError(`SQLite catalog row ${field} is invalid`);
  }
  return value;
}

function requireCatalogNonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SessionCatalogIntegrityError(`Session catalog field ${label} must be a non-negative integer`);
  }
  return value as number;
}

function requireCatalogBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SessionCatalogIntegrityError(`Session catalog field ${label} must be a boolean`);
  }
  return value;
}

function optionalCatalogString(value: unknown, key: string): Record<string, string> {
  return typeof value === "string" ? { [key]: value } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取既有会话的完整投影(transcript 深读路径)。存储根缺失时不创建、
 * 返回 undefined——对齐旧 readExistingRuntimeSessionProjection 的非创建语义。
 */
export async function readExistingSqliteSessionProjection(options: {
  readonly storageRoot: string;
  readonly sessionId: string;
}): Promise<RuntimeSessionProjectionSnapshot | undefined> {
  if (!options.storageRoot.trim()) {
    throw new Error("SqliteRuntimeEventStore requires storageRoot");
  }
  const root = resolve(options.storageRoot);
  if (!existsSync(operationalDatabasePath(root))) return undefined;
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    return await store.readSessionProjection(options.sessionId);
  } finally {
    store.close();
  }
}

/**
 * 读取既有会话的 kind 切片 + manifest(票 04 深读路径:transcript 分页 /
 * evidence 点查)。存储根缺失时不创建、返回 undefined,与
 * {@link readExistingSqliteSessionProjection} 的非创建语义一致。
 */
export async function readExistingSqliteSessionEventSlice(options: {
  readonly storageRoot: string;
  readonly sessionId: string;
  readonly kinds: readonly string[];
}): Promise<
  { readonly manifest: RuntimeSessionManifest; readonly slice: SqliteSessionEventSlice } | undefined
> {
  if (!options.storageRoot.trim()) {
    throw new Error("SqliteRuntimeEventStore requires storageRoot");
  }
  const root = resolve(options.storageRoot);
  if (!existsSync(operationalDatabasePath(root))) return undefined;
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    const manifest = await store.readSessionManifest(options.sessionId);
    if (!manifest) return undefined;
    const slice = await store.readSessionEntriesOfKinds(options.sessionId, options.kinds);
    return { manifest, slice };
  } finally {
    store.close();
  }
}
