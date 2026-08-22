import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import type { SQLInputValue, StatementSync } from "node:sqlite";
import { parseAnyCredentialRef } from "../../provider/credential-vault.js";
import { generateRuntimeId } from "../../tasks/runtime-store-contracts.js";
import { parseBackgroundYoloPolicySnapshot } from "../../safety/background-yolo-policy-schema.js";
import {
  DAEMON_RUN_STATUSES,
  isTerminalJobStatus,
  type CompletionOutboxRecord,
  type CronJobRecord,
  type CronRunRecord,
  type CronRunStatus,
  type DaemonRunRecord,
  type JobAttemptRecord,
  type JobCommandKind,
  type JobCommandRecord,
  type JobListFilter,
  type JobRecord,
  type MergeRequestRecord,
  type MergeRequestStatus,
  type ProviderCallRecord,
  type RuntimeEventRecord,
  type RuntimeLeaseRecord,
  type UsageBaselineRecord,
  type UsageLedgerFilter,
  type UsageLedgerSummary,
  type UsageLedgerTotals,
} from "../../tasks/runtime-types.js";
import type {
  CancelQueuedJobInput,
  ClaimCronRunInput,
  CreateCronJobInput,
  CreateCronRunInput,
  CreateJobInput,
  DaemonCommandState,
  DaemonIdempotentCommandResult,
  FinishCronRunInput,
  FinishJobInput,
  FinishJobResult,
  SettleRecoverableJobAfterTaskTerminalInput,
  SettleRecoverableJobAfterTaskTerminalResult,
  StartJobInput,
  StartRecoverableJobSuccessorInput,
  StartRecoverableJobSuccessorResult,
  UpdateCronJobInput,
} from "../../tasks/runtime-store-contracts.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "./workspace-scopes.js";
import {
  prepareWorkspaceSqliteStorageSync,
  type WorkspaceStorageRootIdentity,
} from "./sqlite-workspace-storage.js";
import type { OperationalDatabaseLease } from "./sqlite-database.js";

export type {
  CancelQueuedJobInput,
  ClaimCronRunInput,
  CreateCronJobInput,
  CreateCronRunInput,
  CreateJobInput,
  DaemonCommandState,
  DaemonIdempotentCommandResult,
  FinishCronRunInput,
  FinishJobInput,
  FinishJobResult,
  RecoverableJobTerminalStatus,
  SettleRecoverableJobAfterTaskTerminalInput,
  SettleRecoverableJobAfterTaskTerminalResult,
  StartJobInput,
  StartRecoverableJobSuccessorInput,
  StartRecoverableJobSuccessorResult,
  UpdateCronJobInput,
} from "../../tasks/runtime-store-contracts.js";

/**
 * SQLite 版控制面(ADR 24 §4.3,票 06)。
 *
 * 语义对齐旧 RuntimeStore(src/tasks/runtime-store.ts,产线基准):
 * - 旧"state.json 整写 + 双 jsonl append 三文件联动"的原子性,在这里是单个
 *   BEGIN IMMEDIATE 内的多表写;control_metadata 的 revision / lastTransactionId /
 *   nextRuntimeEventSequence 与业务表同事务更新,不存在部分提交路径。
 * - 旧 revision 的乐观并发含义由 BEGIN IMMEDIATE 串行化保持:同库写事务互斥,
 *   记录级 CAS 仍走 expectedVersion 显式比对。
 * - lease TTL / 续约、job/cron 状态机、恢复语义逐方法照抄旧实现(含错误消息)。
 *
 * 与旧实现的差异:无进程内索引缓存(旧 rebuildRuntimeStoreIndex+字节尾读被 SQL
 * 查询取代);读取走引擎 deferred 读事务,写入的未提交数据对同根活跃写事务可见。
 */

const DEFAULT_LEASE_TTL_MS = 30_000;
const DAEMON_RUN_RECOVERY_EVENT_PREFIX = "daemon-run-recovery:";
const REVISION_KEY = "revision";
const LAST_TRANSACTION_ID_KEY = "lastTransactionId";
const NEXT_RUNTIME_EVENT_SEQUENCE_KEY = "nextRuntimeEventSequence";

export class RuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

export interface SqliteRuntimeControlStoreOptions {
  /** Canonical workspace storage root holding pico.sqlite. */
  storageRoot: string;
  now?: () => number;
}

interface ControlWriteTx {
  readonly transactionId: string;
  dirty: boolean;
  eventSequenceCache: number | undefined;
  savepointCounter: number;
}

const activeControlWrites = new Map<string, ControlWriteTx>();

export class SqliteRuntimeControlStore {
  readonly storageRoot: string;
  /** 首次打开时校验过的根身份;后续写由引擎级 binding 校验兜底。 */
  readonly rootIdentity: WorkspaceStorageRootIdentity;
  private readonly now: () => number;
  private readonly lease: OperationalDatabaseLease;
  private readonly statements = new Map<string, StatementSync>();
  private closed = false;

  constructor(options: SqliteRuntimeControlStoreOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("RuntimeStore storageRoot must not be empty");
    }
    this.now = options.now ?? Date.now;
    // 单一 scope 组合点:与同库其它 store 一致传全量(引擎只在首开连接时迁移,
    // 组合打开若少传 scope,后开的 store 会看到缺表的库)。
    const preparation = prepareWorkspaceSqliteStorageSync(
      resolve(options.storageRoot),
      ALL_WORKSPACE_SQLITE_SCOPES,
    );
    this.lease = preparation.lease;
    this.rootIdentity = preparation.rootIdentity;
    this.storageRoot = this.lease.storageRoot;
    // 首次打开播种 control_metadata(等价旧实现的空 state.json 落盘)。
    this.write(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lease.release();
  }

  acquireLease(
    resourceKey: string,
    ownerId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    if (ttlMs <= 0 || !Number.isFinite(ttlMs)) throw new Error("lease ttlMs 必须为正数");
    return this.write(() => {
      const now = this.now();
      const current = this.selectLease(resourceKey);
      if (current && current.expiresAt > now && current.ownerId !== ownerId) {
        throw new RuntimeConflictError(
          `资源 ${resourceKey} 已由 ${current.ownerId} 持有至 ${current.expiresAt}`,
        );
      }
      const next: RuntimeLeaseRecord = current
        ? {
            ...current,
            ownerId,
            leaseEpoch:
              current.expiresAt > now && current.ownerId === ownerId
                ? current.leaseEpoch
                : current.leaseEpoch + 1,
            heartbeatAt: now,
            expiresAt: now + ttlMs,
            version: current.version + 1,
          }
        : {
            resourceKey,
            ownerId,
            leaseEpoch: 1,
            heartbeatAt: now,
            expiresAt: now + ttlMs,
            version: 1,
          };
      this.upsertLease(next);
      return next;
    });
  }

  heartbeatLease(
    resourceKey: string,
    ownerId: string,
    leaseEpoch: number,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    return this.write(() => {
      const current = this.selectLease(resourceKey);
      const now = this.now();
      if (
        !current ||
        current.ownerId !== ownerId ||
        current.leaseEpoch !== leaseEpoch ||
        current.expiresAt <= now
      ) {
        throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 已失效`);
      }
      const next = {
        ...current,
        heartbeatAt: now,
        expiresAt: now + ttlMs,
        version: current.version + 1,
      };
      this.upsertLease(next);
      return next;
    });
  }

  releaseLease(resourceKey: string, ownerId: string, leaseEpoch: number): void {
    this.write(() => {
      const current = this.selectLease(resourceKey);
      if (!current || current.ownerId !== ownerId || current.leaseEpoch !== leaseEpoch) {
        throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化`);
      }
      this.upsertLease({
        ...current,
        expiresAt: this.now(),
        version: current.version + 1,
      });
    });
  }

  /**
   * 只读查询某个 resourceKey 的当前 lease(含 TTL 未过期的活租约与已过期但未清理的残影)。
   * 调用方自行按 expiresAt > now 判定活性;不校验 owner/epoch。
   */
  getLease(resourceKey: string): RuntimeLeaseRecord | undefined {
    return this.read(() => this.selectLease(resourceKey));
  }

  createJob(input: CreateJobInput): JobRecord {
    return this.write(() => {
      if (this.getJobRow(input.jobId)) throw new RuntimeConflictError(`任务 ${input.jobId} 已存在`);
      const now = this.now();
      const job: JobRecord = compact({
        ...input,
        status: "queued" as const,
        version: 1,
        leaseEpoch: 0,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      this.mutate(
        `INSERT INTO jobs (job_id, type, status, execution_class, completion_policy, description,
           owner_session_id, child_session_id, tool_use_id, output_path, data_json,
           version, lease_epoch, attempt_count, created_at, updated_at, terminal_at, error)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, NULL, NULL)`,
        input.jobId,
        input.type,
        input.executionClass,
        input.completionPolicy,
        input.description,
        input.ownerSessionId ?? null,
        input.childSessionId ?? null,
        input.toolUseId ?? null,
        input.outputPath ?? null,
        input.data === undefined ? null : canonicalJson(input.data),
        now,
        now,
      );
      return job;
    });
  }

  startJob(input: StartJobInput): { job: JobRecord; attempt: JobAttemptRecord } {
    return this.write(() => {
      const current = this.requireJob(input.jobId);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`任务 ${input.jobId} 当前为 ${current.status}，不能启动`);
      }
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(
          `任务 ${input.jobId} 版本已从 ${input.expectedVersion} 变化`,
        );
      }
      if (this.getAttemptRow(input.attemptId)) {
        throw new RuntimeConflictError(`attempt ${input.attemptId} 已存在`);
      }
      this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attemptNumber = current.attemptCount + 1;
      const outputPath = input.outputPath ?? current.outputPath;
      const attempt: JobAttemptRecord = compact({
        attemptId: input.attemptId,
        jobId: input.jobId,
        attemptNumber,
        status: "running" as const,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputPath,
        outputOffset: 0,
        startedAt: now,
        updatedAt: now,
        version: 1,
      });
      const job: JobRecord = compact({
        ...current,
        status: "running" as const,
        outputPath,
        leaseEpoch: input.leaseEpoch,
        attemptCount: attemptNumber,
        updatedAt: now,
        version: current.version + 1,
      });
      this.mutate(
        `INSERT INTO job_attempts (attempt_id, job_id, attempt_number, status, owner_id,
           lease_epoch, output_path, output_offset, started_at, updated_at, finished_at,
           error, result_json, version)
         VALUES (?, ?, ?, 'running', ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, 1)`,
        input.attemptId,
        input.jobId,
        attemptNumber,
        input.ownerId,
        input.leaseEpoch,
        outputPath ?? null,
        now,
        now,
      );
      this.mutate(
        `UPDATE jobs SET status = 'running', output_path = ?, lease_epoch = ?,
           attempt_count = ?, updated_at = ?, version = version + 1 WHERE job_id = ?`,
        outputPath ?? null,
        input.leaseEpoch,
        attemptNumber,
        now,
        input.jobId,
      );
      return { job, attempt };
    });
  }

  /**
   * Atomically replaces an expired recoverable Attempt without publishing a terminal outbox.
   * 语义照抄旧实现:仅 TaskRun 终态事实允许收敛 Job 与补建 completion。
   */
  startRecoverableJobSuccessor(
    input: StartRecoverableJobSuccessorInput,
  ): StartRecoverableJobSuccessorResult {
    return this.write(() => {
      const currentJob = this.requireJob(input.jobId);
      const source = this.requireAttempt(input.sourceAttemptId);
      const existing = this.getAttemptRow(input.successorAttemptId);
      const reason = input.reason ?? "owner_lost_recovering";
      if (existing) {
        if (
          currentJob.executionClass !== "recoverable" ||
          currentJob.status !== "running" ||
          currentJob.leaseEpoch !== input.leaseEpoch ||
          source.jobId !== input.jobId ||
          source.status !== "interrupted" ||
          source.error !== reason ||
          existing.jobId !== input.jobId ||
          existing.status !== "running" ||
          existing.attemptNumber !== source.attemptNumber + 1 ||
          existing.ownerId !== input.ownerId ||
          existing.leaseEpoch !== input.leaseEpoch ||
          existing.outputPath !== (input.outputPath ?? currentJob.outputPath)
        ) {
          throw new RuntimeConflictError(
            `recoverable successor ${input.successorAttemptId} 已绑定到其他执行`,
          );
        }
        this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
        return {
          inserted: false,
          job: currentJob,
          sourceAttempt: source,
          successorAttempt: rowToAttempt(existing),
        };
      }
      if (
        currentJob.executionClass !== "recoverable" ||
        currentJob.status !== "running" ||
        currentJob.version !== input.expectedJobVersion ||
        currentJob.attemptCount !== source.attemptNumber ||
        currentJob.leaseEpoch !== source.leaseEpoch ||
        source.jobId !== input.jobId ||
        source.status !== "running" ||
        source.version !== input.expectedSourceAttemptVersion ||
        input.leaseEpoch <= source.leaseEpoch
      ) {
        throw new RuntimeConflictError(
          `recoverable Job ${input.jobId} 的 source/version/lease 已变化`,
        );
      }
      this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const sourceAttempt: JobAttemptRecord = {
        ...source,
        status: "interrupted",
        error: reason,
        finishedAt: now,
        updatedAt: now,
        version: source.version + 1,
      };
      const outputPath = input.outputPath ?? currentJob.outputPath;
      const successorAttempt: JobAttemptRecord = compact({
        attemptId: input.successorAttemptId,
        jobId: input.jobId,
        attemptNumber: source.attemptNumber + 1,
        status: "running" as const,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputPath,
        outputOffset: 0,
        startedAt: now,
        updatedAt: now,
        version: 1,
      });
      const job: JobRecord = compact({
        ...currentJob,
        status: "running" as const,
        leaseEpoch: input.leaseEpoch,
        attemptCount: successorAttempt.attemptNumber,
        outputPath,
        updatedAt: now,
        version: currentJob.version + 1,
      });
      this.mutate(
        `UPDATE job_attempts SET status = 'interrupted', error = ?, finished_at = ?,
           updated_at = ?, version = version + 1 WHERE attempt_id = ?`,
        reason,
        now,
        now,
        input.sourceAttemptId,
      );
      this.mutate(
        `INSERT INTO job_attempts (attempt_id, job_id, attempt_number, status, owner_id,
           lease_epoch, output_path, output_offset, started_at, updated_at, finished_at,
           error, result_json, version)
         VALUES (?, ?, ?, 'running', ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, 1)`,
        input.successorAttemptId,
        input.jobId,
        successorAttempt.attemptNumber,
        input.ownerId,
        input.leaseEpoch,
        outputPath ?? null,
        now,
        now,
      );
      this.mutate(
        `UPDATE jobs SET status = 'running', lease_epoch = ?, attempt_count = ?,
           output_path = ?, updated_at = ?, version = version + 1 WHERE job_id = ?`,
        input.leaseEpoch,
        successorAttempt.attemptNumber,
        outputPath ?? null,
        now,
        input.jobId,
      );
      return {
        inserted: true,
        job,
        sourceAttempt,
        successorAttempt,
      };
    });
  }

  /**
   * Converges a recoverable Job/outbox from an already-durable TaskRun terminal fact.
   * 语义照抄旧实现,包括终态幂等重放分支与 takeover 高 epoch 栅栏。
   */
  settleRecoverableJobAfterTaskTerminal(
    input: SettleRecoverableJobAfterTaskTerminalInput,
  ): SettleRecoverableJobAfterTaskTerminalResult {
    return this.write(() => {
      const currentJob = this.requireJob(input.jobId);
      const currentAttempt = this.requireAttempt(input.attemptId);
      const existingCompletion = this.getCompletionRow(input.completionId);
      if (currentJob.executionClass !== "recoverable" || currentAttempt.jobId !== input.jobId) {
        throw new RuntimeConflictError(
          `TaskRun terminal cannot settle non-recoverable Job ${input.jobId}`,
        );
      }
      if (isTerminalJobStatus(currentJob.status)) {
        if (
          currentJob.status !== input.status ||
          currentJob.error !== input.error ||
          currentAttempt.status !== input.status ||
          currentAttempt.error !== input.error ||
          currentAttempt.outputOffset !== (input.outputOffset ?? currentAttempt.outputOffset) ||
          !sameJson(currentAttempt.result, input.result) ||
          existingCompletion?.jobId !== input.jobId ||
          existingCompletion.attemptId !== input.attemptId ||
          existingCompletion.status !== input.status ||
          !sameJson(existingCompletion.payload, input.completionPayload)
        ) {
          throw new RuntimeConflictError(
            `TaskRun completion ${input.completionId} conflicts with Job ${input.jobId} terminal`,
          );
        }
        if (input.completionAlreadyDelivered && existingCompletion.deliveredAt === undefined) {
          this.markCompletionRowDelivered(input.completionId);
        }
        return {
          inserted: false,
          job: currentJob,
          attempt: currentAttempt,
          completion: this.requireCompletion(input.completionId),
        };
      }
      const sameFence =
        currentAttempt.ownerId === input.ownerId && currentAttempt.leaseEpoch === input.leaseEpoch;
      const takeoverFence = input.leaseEpoch > currentAttempt.leaseEpoch;
      if (
        currentJob.status !== "running" ||
        currentAttempt.status !== "running" ||
        currentJob.attemptCount !== currentAttempt.attemptNumber ||
        currentJob.leaseEpoch !== currentAttempt.leaseEpoch ||
        (!sameFence && !takeoverFence)
      ) {
        throw new RuntimeConflictError(
          `recoverable Job ${input.jobId} has no matching running Attempt ${input.attemptId}`,
        );
      }
      this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attempt: JobAttemptRecord = compact<JobAttemptRecord>({
        ...currentAttempt,
        status: input.status,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputOffset: input.outputOffset ?? currentAttempt.outputOffset,
        error: input.error,
        result: input.result,
        finishedAt: now,
        updatedAt: now,
        version: currentAttempt.version + 1,
      });
      const job: JobRecord = compact<JobRecord>({
        ...currentJob,
        status: input.status,
        leaseEpoch: input.leaseEpoch,
        terminalAt: now,
        updatedAt: now,
        error: input.error,
        version: currentJob.version + 1,
      });
      this.updateAttemptTerminal(input.attemptId, attempt, now);
      this.mutate(
        `UPDATE jobs SET status = ?, lease_epoch = ?, terminal_at = ?, updated_at = ?,
           error = ?, version = version + 1 WHERE job_id = ?`,
        input.status,
        input.leaseEpoch,
        now,
        now,
        input.error ?? null,
        input.jobId,
      );
      this.insertCompletion({
        completionId: input.completionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        policy: currentJob.completionPolicy,
        status: input.status,
        payload: input.completionPayload,
        createdAt: now,
      });
      const completion = this.requireCompletion(input.completionId);
      if (input.completionAlreadyDelivered) this.markCompletionRowDelivered(input.completionId);
      return {
        inserted: true,
        job,
        attempt,
        completion,
      };
    });
  }

  finishJob(input: FinishJobInput): FinishJobResult {
    return this.write(() => {
      const currentJob = this.requireJob(input.jobId);
      const currentAttempt = this.requireAttempt(input.attemptId);
      const existingCompletion = this.getCompletionRow(input.completionId);
      if (
        currentAttempt.jobId !== input.jobId ||
        currentAttempt.ownerId !== input.ownerId ||
        currentJob.leaseEpoch !== input.leaseEpoch ||
        currentAttempt.leaseEpoch !== input.leaseEpoch
      ) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 的 ownerId/leaseEpoch 与调用者不一致`);
      }
      if (
        isTerminalJobStatus(currentJob.status) &&
        currentJob.status === input.status &&
        currentAttempt.status === input.status &&
        existingCompletion?.jobId === input.jobId &&
        existingCompletion.attemptId === input.attemptId
      ) {
        if (input.completionAlreadyDelivered && existingCompletion.deliveredAt === undefined) {
          this.markCompletionRowDelivered(input.completionId);
        }
        return {
          job: currentJob,
          attempt: currentAttempt,
          completion: this.requireCompletion(input.completionId),
        };
      }
      if (currentJob.status !== "running" || currentAttempt.status !== "running") {
        throw new RuntimeConflictError(
          `任务 ${input.jobId} 或 attempt ${input.attemptId} 已非运行态`,
        );
      }
      if (
        currentJob.version !== input.expectedJobVersion ||
        currentAttempt.version !== input.expectedAttemptVersion
      ) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 的 version/leaseEpoch CAS 失败`);
      }
      this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attempt: JobAttemptRecord = compact<JobAttemptRecord>({
        ...currentAttempt,
        status: input.status,
        outputOffset: input.outputOffset ?? currentAttempt.outputOffset,
        error: input.error,
        result: input.result,
        finishedAt: now,
        updatedAt: now,
        version: currentAttempt.version + 1,
      });
      const job: JobRecord = compact<JobRecord>({
        ...currentJob,
        status: input.status,
        terminalAt: now,
        updatedAt: now,
        error: input.error,
        version: currentJob.version + 1,
      });
      this.updateAttemptTerminal(input.attemptId, attempt, now);
      this.mutate(
        `UPDATE jobs SET status = ?, terminal_at = ?, updated_at = ?, error = ?,
           version = version + 1 WHERE job_id = ?`,
        input.status,
        now,
        now,
        input.error ?? null,
        input.jobId,
      );
      this.insertCompletion({
        completionId: input.completionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        policy: currentJob.completionPolicy,
        status: input.status,
        payload: input.completionPayload,
        createdAt: now,
      });
      if (input.completionAlreadyDelivered) this.markCompletionRowDelivered(input.completionId);
      return {
        job,
        attempt,
        completion: this.requireCompletion(input.completionId),
      };
    });
  }

  cancelQueuedJob(input: CancelQueuedJobInput): {
    job: JobRecord;
    completion: CompletionOutboxRecord;
  } {
    return this.write(() => {
      const current = this.requireJob(input.jobId);
      const existing = this.getCompletionRow(input.completionId);
      if (current.status === "cancelled" && existing?.jobId === input.jobId) {
        return { job: current, completion: rowToCompletion(existing) };
      }
      if (current.status !== "queued" || current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 已非可取消的 queued 版本`);
      }
      const now = this.now();
      const job: JobRecord = {
        ...current,
        status: "cancelled",
        error: input.reason ?? "cancelled",
        terminalAt: now,
        updatedAt: now,
        version: current.version + 1,
      };
      this.mutate(
        `UPDATE jobs SET status = 'cancelled', error = ?, terminal_at = ?, updated_at = ?,
           version = version + 1 WHERE job_id = ?`,
        input.reason ?? "cancelled",
        now,
        now,
        input.jobId,
      );
      this.insertCompletion(
        compact<CompletionOutboxRecord>({
          completionId: input.completionId,
          jobId: input.jobId,
          policy: current.completionPolicy,
          status: "cancelled" as const,
          payload: input.reason ? { reason: input.reason } : undefined,
          createdAt: now,
        }),
      );
      return { job, completion: this.requireCompletion(input.completionId) };
    });
  }

  retryJob(jobId: string, expectedVersion: number): JobRecord {
    return this.write(() => {
      const current = this.requireJob(jobId);
      if (!isTerminalJobStatus(current.status) || current.version !== expectedVersion) {
        throw new RuntimeConflictError(`任务 ${jobId} 已非可重试的终态版本`);
      }
      const now = this.now();
      const job: JobRecord = compact({
        ...current,
        status: "queued" as const,
        updatedAt: now,
        version: current.version + 1,
      });
      delete (job as Partial<JobRecord>).terminalAt;
      delete (job as Partial<JobRecord>).error;
      this.mutate(
        `UPDATE jobs SET status = 'queued', updated_at = ?, version = version + 1,
           terminal_at = NULL, error = NULL WHERE job_id = ?`,
        now,
        jobId,
      );
      return job;
    });
  }

  interruptExpiredJobs(reason = "owner_lost"): JobRecord[] {
    return this.write(() => {
      const now = this.now();
      const interrupted: JobRecord[] = [];
      const candidates = this.allRows(
        `SELECT * FROM jobs WHERE status = 'running' ORDER BY job_id`,
      ).map(rowToJob);
      for (const current of candidates) {
        const lease = this.selectLease(`job:${current.jobId}`);
        if (current.executionClass === "recoverable" || (lease && lease.expiresAt > now)) {
          continue;
        }
        const attemptRow = this.getRow(
          `SELECT * FROM job_attempts WHERE job_id = ? AND status = 'running'
           ORDER BY attempt_number DESC LIMIT 1`,
          current.jobId,
        );
        if (!attemptRow) continue;
        const attempt = rowToAttempt(attemptRow);
        const job: JobRecord = {
          ...current,
          status: "interrupted",
          error: reason,
          terminalAt: now,
          updatedAt: now,
          version: current.version + 1,
        };
        this.mutate(
          `UPDATE job_attempts SET status = 'interrupted', error = ?, finished_at = ?,
             updated_at = ?, version = version + 1 WHERE attempt_id = ?`,
          reason,
          now,
          now,
          attempt.attemptId,
        );
        this.mutate(
          `UPDATE jobs SET status = 'interrupted', error = ?, terminal_at = ?, updated_at = ?,
             version = version + 1 WHERE job_id = ?`,
          reason,
          now,
          now,
          current.jobId,
        );
        const completionId = `completion:${attempt.attemptId}`;
        this.insertCompletion({
          completionId,
          jobId: current.jobId,
          attemptId: attempt.attemptId,
          policy: job.completionPolicy,
          status: "interrupted",
          payload: interruptedCompletionPayload(job, completionId, reason, now),
          createdAt: now,
        });
        interrupted.push(job);
      }
      return interrupted;
    });
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.read(() => {
      const row = this.getJobRow(jobId);
      return row === undefined ? undefined : rowToJob(row);
    });
  }

  getAttempt(attemptId: string): JobAttemptRecord | undefined {
    return this.read(() => {
      const row = this.getAttemptRow(attemptId);
      return row === undefined ? undefined : rowToAttempt(row);
    });
  }

  listAttempts(jobId: string): JobAttemptRecord[] {
    return this.read(() =>
      this.allRows(`SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number`, jobId),
    ).map(rowToAttempt);
  }

  listJobs(filter: JobListFilter = {}): JobRecord[] {
    return this.read(() => {
      const limit = Math.max(1, Math.min(filter.limit ?? 1_000, 10_000));
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.statuses?.length) {
        clauses.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
        params.push(...filter.statuses);
      }
      if (filter.ownerSessionId !== undefined) {
        clauses.push("owner_session_id = ?");
        params.push(filter.ownerSessionId);
      }
      if (filter.completionPolicy !== undefined) {
        clauses.push("completion_policy = ?");
        params.push(filter.completionPolicy);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return this.allRows(
        `SELECT * FROM jobs${where} ORDER BY created_at, job_id LIMIT ?`,
        ...params,
        limit,
      ).map(rowToJob);
    });
  }

  createCronJob(input: CreateCronJobInput): CronJobRecord {
    return this.write((tx) => {
      if (this.getCronJobRow(input.cronJobId)) {
        throw new RuntimeConflictError(`Cron Job ${input.cronJobId} 已存在`);
      }
      const policySnapshot = parseBackgroundYoloPolicySnapshot(input.policySnapshot);
      const parsedCredential =
        input.credentialRef === undefined ? undefined : parseAnyCredentialRef(input.credentialRef);
      const modelRouteId = normalizeOptionalModelRouteId(input.modelRouteId);
      validateCredentialRoute(parsedCredential, modelRouteId);
      const now = this.now();
      const job: CronJobRecord = compact({
        cronJobId: input.cronJobId,
        workspacePath: input.workspacePath,
        name: normalizeCronJobName(input.name, input.prompt),
        schedule: input.schedule,
        timeZone: input.timeZone,
        prompt: input.prompt,
        enabled: input.enabled !== false,
        policySnapshot,
        credentialRef: parsedCredential?.ref,
        modelRouteId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.mutate(
        `INSERT INTO cron_jobs (cron_job_id, workspace_path, name, schedule, time_zone, prompt,
           enabled, policy_snapshot_json, credential_ref, model_route_id, version,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        input.cronJobId,
        input.workspacePath,
        job.name,
        input.schedule,
        input.timeZone,
        input.prompt,
        job.enabled ? 1 : 0,
        canonicalJson(policySnapshot),
        job.credentialRef ?? null,
        job.modelRouteId ?? null,
        now,
        now,
      );
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.created",
        workspacePath: input.workspacePath,
        cronJobId: input.cronJobId,
        payload: { enabled: job.enabled, schedule: input.schedule, timeZone: input.timeZone },
      });
      return job;
    });
  }

  updateCronJob(input: UpdateCronJobInput): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(input.cronJobId);
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${input.cronJobId} 的版本已变化`);
      }
      const name = input.name === undefined ? current.name : normalizeCronJobName(input.name);
      const schedule = input.schedule ?? current.schedule;
      const prompt =
        input.prompt === undefined ? current.prompt : normalizeCronPrompt(input.prompt);
      const now = this.now();
      const job = {
        ...current,
        name,
        schedule,
        prompt,
        updatedAt: now,
        version: current.version + 1,
      };
      this.mutate(
        `UPDATE cron_jobs SET name = ?, schedule = ?, prompt = ?, updated_at = ?,
           version = version + 1 WHERE cron_job_id = ?`,
        name,
        schedule,
        prompt,
        now,
        input.cronJobId,
      );
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.updated",
        workspacePath: current.workspacePath,
        cronJobId: input.cronJobId,
        payload: { name, schedule },
      });
      return job;
    });
  }

  getCronJob(cronJobId: string): CronJobRecord | undefined {
    return this.read(() => {
      const row = this.getCronJobRow(cronJobId);
      return row === undefined ? undefined : rowToCronJob(row);
    });
  }

  listCronJobs(input: { workspacePath?: string; enabled?: boolean } = {}): CronJobRecord[] {
    return this.read(() => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (input.workspacePath !== undefined) {
        clauses.push("workspace_path = ?");
        params.push(input.workspacePath);
      }
      if (input.enabled !== undefined) {
        clauses.push("enabled = ?");
        params.push(input.enabled ? 1 : 0);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return this.allRows(
        `SELECT * FROM cron_jobs${where} ORDER BY created_at, cron_job_id`,
        ...params,
      ).map(rowToCronJob);
    });
  }

  setCronJobEnabled(cronJobId: string, expectedVersion: number, enabled: boolean): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(cronJobId);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const now = this.now();
      const job = { ...current, enabled, updatedAt: now, version: current.version + 1 };
      this.mutate(
        `UPDATE cron_jobs SET enabled = ?, updated_at = ?, version = version + 1
           WHERE cron_job_id = ?`,
        enabled ? 1 : 0,
        now,
        cronJobId,
      );
      this.insertRuntimeEvent(tx, {
        topic: enabled ? "cron.job.enabled" : "cron.job.disabled",
        workspacePath: current.workspacePath,
        cronJobId,
      });
      return job;
    });
  }

  deleteCronJob(cronJobId: string, expectedVersion: number): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(cronJobId);
      if (current.enabled)
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 必须先禁用才能删除`);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const running = this.getCronRunRowByStatus(cronJobId, "running");
      if (running) {
        throw new RuntimeConflictError(
          `Cron Job ${cronJobId} 仍有运行中的 Run ${rowToCronRun(running).cronRunId}`,
        );
      }
      this.mutate(`DELETE FROM cron_jobs WHERE cron_job_id = ?`, cronJobId);
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.deleted",
        workspacePath: current.workspacePath,
        payload: { cronJobId },
      });
      return current;
    });
  }

  createCronRun(input: CreateCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const job = this.requireCronJob(input.cronJobId);
      const existing = this.getRow(
        `SELECT * FROM cron_runs WHERE cron_job_id = ? AND scheduled_for = ?`,
        input.cronJobId,
        input.scheduledFor,
      );
      if (existing) return rowToCronRun(existing);
      if (this.getCronRunRow(input.cronRunId)) {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 已存在`);
      }
      let status = input.status;
      let reason = input.reason;
      if (
        status === "queued" &&
        this.getRow(
          `SELECT 1 AS one FROM cron_runs WHERE workspace_path = ?
           AND status IN ('queued','running') LIMIT 1`,
          job.workspacePath,
        )
      ) {
        status = "skipped";
        reason = "workspace_busy";
      }
      const now = this.now();
      const run: CronRunRecord = compact({
        cronRunId: input.cronRunId,
        cronJobId: input.cronJobId,
        workspacePath: job.workspacePath,
        scheduledFor: input.scheduledFor,
        status,
        leaseEpoch: 0,
        createdAt: now,
        finishedAt: status === "queued" ? undefined : now,
        reason,
        version: 1,
      });
      this.mutate(
        `INSERT INTO cron_runs (cron_run_id, cron_job_id, workspace_path, scheduled_for,
           status, owner_id, lease_epoch, created_at, started_at, finished_at, reason,
           result_json, version)
         VALUES (?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?, NULL, 1)`,
        input.cronRunId,
        input.cronJobId,
        job.workspacePath,
        input.scheduledFor,
        status,
        now,
        run.finishedAt ?? null,
        reason ?? null,
      );
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${status}`,
        workspacePath: job.workspacePath,
        cronJobId: job.cronJobId,
        cronRunId: input.cronRunId,
        payload: { scheduledFor: input.scheduledFor, ...(reason ? { reason } : {}) },
      });
      return run;
    });
  }

  getCronRun(cronRunId: string): CronRunRecord | undefined {
    return this.read(() => {
      const row = this.getCronRunRow(cronRunId);
      return row === undefined ? undefined : rowToCronRun(row);
    });
  }

  listCronRuns(
    input: { cronJobId?: string; workspacePath?: string; limit?: number } = {},
  ): CronRunRecord[] {
    return this.read(() => {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (input.cronJobId !== undefined) {
        clauses.push("cron_job_id = ?");
        params.push(input.cronJobId);
      }
      if (input.workspacePath !== undefined) {
        clauses.push("workspace_path = ?");
        params.push(input.workspacePath);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return this.allRows(
        `SELECT * FROM cron_runs${where} ORDER BY scheduled_for DESC, cron_run_id DESC LIMIT ?`,
        ...params,
        limit,
      ).map(rowToCronRun);
    });
  }

  listActiveCronRuns(workspacePath: string): CronRunRecord[] {
    return this.read(() =>
      this.allRows(
        `SELECT * FROM cron_runs WHERE workspace_path = ? AND status IN ('queued','running')
           ORDER BY scheduled_for DESC, cron_run_id DESC`,
        workspacePath,
      ),
    ).map(rowToCronRun);
  }

  recoverInterruptedCronRuns(reason = "daemon_interrupted_after_lease_expiry"): CronRunRecord[] {
    return this.write((tx) => {
      const now = this.now();
      const recovered: CronRunRecord[] = [];
      for (const row of this.allRows(`SELECT * FROM cron_runs WHERE status = 'running'`)) {
        const current = rowToCronRun(row);
        const lease = this.selectLease(`cron-run:${current.cronRunId}`);
        if (lease && lease.expiresAt > now) continue;
        const run: CronRunRecord = {
          ...current,
          status: "failed",
          finishedAt: now,
          reason,
          version: current.version + 1,
        };
        this.mutate(
          `UPDATE cron_runs SET status = 'failed', finished_at = ?, reason = ?,
             version = version + 1 WHERE cron_run_id = ?`,
          now,
          reason,
          current.cronRunId,
        );
        if (lease && lease.expiresAt <= now) {
          this.upsertLease({
            ...lease,
            expiresAt: now,
            version: lease.version + 1,
          });
        }
        this.insertRuntimeEvent(tx, {
          topic: "cron.run.failed",
          workspacePath: current.workspacePath,
          cronJobId: current.cronJobId,
          cronRunId: current.cronRunId,
          payload: { reason, recovered: true },
        });
        recovered.push(run);
      }
      return recovered;
    });
  }

  claimCronRun(input: ClaimCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(input.cronRunId);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(
          `Cron Run ${input.cronRunId} 当前为 ${current.status}，不能启动`,
        );
      }
      this.assertLease(`cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const run: CronRunRecord = {
        ...current,
        status: "running",
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        startedAt: now,
        version: current.version + 1,
      };
      this.mutate(
        `UPDATE cron_runs SET status = 'running', owner_id = ?, lease_epoch = ?, started_at = ?,
           version = version + 1 WHERE cron_run_id = ?`,
        input.ownerId,
        input.leaseEpoch,
        now,
        input.cronRunId,
      );
      this.insertRuntimeEvent(tx, {
        topic: "cron.run.running",
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: input.cronRunId,
      });
      return run;
    });
  }

  finishCronRun(input: FinishCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(input.cronRunId);
      if (
        current.status !== "running" ||
        current.ownerId !== input.ownerId ||
        current.leaseEpoch !== input.leaseEpoch ||
        current.version !== input.expectedVersion
      ) {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 的 owner/version/lease 已变化`);
      }
      this.assertLease(`cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const run: CronRunRecord = compact<CronRunRecord>({
        ...current,
        status: input.status,
        finishedAt: now,
        reason: input.reason,
        result: input.result,
        version: current.version + 1,
      });
      this.mutate(
        `UPDATE cron_runs SET status = ?, finished_at = ?, reason = ?, result_json = ?,
           version = version + 1 WHERE cron_run_id = ?`,
        input.status,
        now,
        input.reason ?? null,
        input.result === undefined ? null : canonicalJson(input.result),
        input.cronRunId,
      );
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${input.status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: input.cronRunId,
        payload: input.reason ? { reason: input.reason } : {},
      });
      return run;
    });
  }

  blockQueuedCronRun(cronRunId: string, reason: string): CronRunRecord {
    return this.closeQueuedCronRun(cronRunId, "blocked", reason);
  }

  skipQueuedCronRun(cronRunId: string, reason = "workspace_busy"): CronRunRecord {
    return this.closeQueuedCronRun(cronRunId, "skipped", reason);
  }

  listRuntimeEvents(
    input: {
      afterEventId?: string;
      throughEventId?: string;
      workspacePath?: string;
      limit?: number;
    } = {},
  ): RuntimeEventRecord[] {
    return this.read(() => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (input.afterEventId !== undefined) {
        const boundary = this.getEventSequence(input.afterEventId, input.workspacePath);
        if (boundary === undefined) return [];
        clauses.push("sequence > ?");
        params.push(boundary);
      }
      if (input.throughEventId !== undefined) {
        const boundary = this.getEventSequence(input.throughEventId, input.workspacePath);
        if (boundary === undefined) return [];
        clauses.push("sequence <= ?");
        params.push(boundary);
      }
      if (input.workspacePath !== undefined) {
        clauses.push("workspace_path = ?");
        params.push(input.workspacePath);
      }
      const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return this.allRows(
        `SELECT * FROM daemon_events${where} ORDER BY sequence LIMIT ?`,
        ...params,
        limit,
      ).map(rowToRuntimeEvent);
    });
  }

  hasRuntimeEvent(eventId: string, workspacePath?: string): boolean {
    return this.read(() => this.getEventSequence(eventId, workspacePath) !== undefined);
  }

  getRuntimeEventHighWatermark(workspacePath?: string): RuntimeEventRecord | undefined {
    return this.read(() => {
      const row =
        workspacePath === undefined
          ? this.getRow(`SELECT * FROM daemon_events ORDER BY sequence DESC LIMIT 1`)
          : this.getRow(
              `SELECT * FROM daemon_events WHERE workspace_path = ? ORDER BY sequence DESC LIMIT 1`,
              workspacePath,
            );
      return row === undefined ? undefined : rowToRuntimeEvent(row);
    });
  }

  listDaemonRunRecoveryEvents(workspacePath: string): RuntimeEventRecord[] {
    return this.read(() =>
      this.allRows(
        `SELECT * FROM daemon_events WHERE workspace_path = ? AND event_id LIKE ?
           ORDER BY sequence`,
        workspacePath,
        `${DAEMON_RUN_RECOVERY_EVENT_PREFIX}%`,
      ),
    ).map(rowToRuntimeEvent);
  }

  appendRuntimeEvent(
    input: Omit<RuntimeEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: number;
    },
    projection?: { daemonRun: DaemonRunRecord },
  ): RuntimeEventRecord {
    if (projection && projection.daemonRun.workspacePath !== input.workspacePath) {
      throw new RuntimeConflictError(
        `Run ${projection.daemonRun.runId} 的工作区与事件工作区不一致`,
      );
    }
    return this.write((tx) => {
      if (projection) this.persistDaemonRun(projection.daemonRun);
      return this.insertRuntimeEvent(tx, input);
    });
  }

  executeIdempotentDaemonCommand<Result extends Record<string, unknown>>(
    input: {
      commandType: string;
      idempotencyKey: string;
      request: Record<string, unknown>;
    },
    execute: () => { result: Result; resourceId?: string },
  ): DaemonIdempotentCommandResult<Result> {
    const commandType = input.commandType.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!commandType) throw new Error("daemon commandType 必须是非空字符串");
    if (!idempotencyKey) throw new Error("daemon idempotencyKey 必须是非空字符串");
    const requestJson = canonicalJson(input.request);
    const requestHash = createHash("sha256").update(requestJson).digest("hex");
    return this.write(() => {
      const key = daemonCommandKey(commandType, idempotencyKey);
      const existingRow = this.getRow(
        `SELECT * FROM daemon_commands WHERE idempotency_key = ?`,
        key,
      );
      if (existingRow) {
        const existing = rowToDaemonCommand(existingRow);
        if (existing.requestHash !== requestHash || existing.requestJson !== requestJson) {
          throw new RuntimeConflictError(
            `${commandType} 的幂等键 ${idempotencyKey} 已用于其他参数`,
          );
        }
        if (existing.status !== "completed" || !existing.result) {
          throw new RuntimeConflictError(
            `${commandType} 的幂等键 ${idempotencyKey} 尚未完成持久化`,
          );
        }
        return compact({
          result: existing.result as Result,
          replayed: true,
          resourceId: existing.resourceId,
        });
      }
      const now = this.now();
      this.mutate(
        `INSERT INTO daemon_commands (idempotency_key, command_type, request_hash, request_json,
           status, result_json, resource_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
        key,
        commandType,
        requestHash,
        requestJson,
        now,
        now,
      );
      const executed = execute();
      this.mutate(
        `UPDATE daemon_commands SET status = 'completed', result_json = ?, resource_id = ?,
           updated_at = ? WHERE idempotency_key = ?`,
        canonicalJson(executed.result),
        executed.resourceId ?? null,
        this.now(),
        key,
      );
      return compact({
        result: executed.result,
        replayed: false,
        resourceId: executed.resourceId,
      });
    });
  }

  upsertDaemonRun(input: DaemonRunRecord): DaemonRunRecord {
    return this.write(() => this.persistDaemonRun(input));
  }

  getDaemonRun(workspacePath: string, runId: string): DaemonRunRecord | undefined {
    return this.read(() => {
      const row = this.getRow(`SELECT * FROM daemon_runs WHERE run_id = ?`, runId);
      if (row === undefined) return undefined;
      const run = rowToDaemonRun(row);
      return run.workspacePath === workspacePath ? run : undefined;
    });
  }

  listDaemonRuns(input: { workspacePath: string; sessionId?: string }): DaemonRunRecord[] {
    return this.read(() => {
      const clauses = ["workspace_path = ?"];
      const params: unknown[] = [input.workspacePath];
      if (input.sessionId !== undefined) {
        clauses.push("session_id = ?");
        params.push(input.sessionId);
      }
      return this.allRows(
        `SELECT * FROM daemon_runs WHERE ${clauses.join(" AND ")} ORDER BY started_at, run_id`,
        ...params,
      ).map(rowToDaemonRun);
    });
  }

  recoverInterruptedDaemonRuns(
    workspacePath: string,
    reason = "daemon restarted before the Run reached a terminal state",
  ): DaemonRunRecord[] {
    return this.write((tx) => {
      const active = new Set(DAEMON_RUN_STATUSES.slice(0, 4));
      const now = this.now();
      const recovered: DaemonRunRecord[] = [];
      for (const row of this.allRows(
        `SELECT * FROM daemon_runs WHERE workspace_path = ? ORDER BY run_id`,
        workspacePath,
      )) {
        const current = rowToDaemonRun(row);
        if (!active.has(current.status)) continue;
        const run: DaemonRunRecord = {
          ...current,
          status: "failed",
          error: reason,
          updatedAt: now,
          finishedAt: now,
          version: current.version + 1,
        };
        this.mutate(
          `UPDATE daemon_runs SET status = 'failed', error = ?, updated_at = ?, finished_at = ?,
             version = version + 1 WHERE run_id = ?`,
          reason,
          now,
          now,
          run.runId,
        );
        recovered.push(run);
        this.insertRuntimeEvent(tx, daemonRunRecoveryEvent(run));
      }
      return recovered;
    });
  }

  insertCommand(input: {
    commandId: string;
    jobId: string;
    kind: JobCommandKind;
    payload?: Record<string, unknown>;
  }): { record: JobCommandRecord; inserted: boolean } {
    return this.write(() => {
      this.requireJob(input.jobId);
      const existingRow = this.getCommandRow(input.commandId);
      if (existingRow) {
        const existing = rowToJobCommand(existingRow);
        if (
          existing.jobId !== input.jobId ||
          existing.kind !== input.kind ||
          !sameJson(existing.payload, input.payload)
        ) {
          throw new RuntimeConflictError(`命令 ID ${input.commandId} 已被其他命令使用`);
        }
        return { record: existing, inserted: false };
      }
      const record: JobCommandRecord = compact({ ...input, createdAt: this.now() });
      this.mutate(
        `INSERT INTO job_commands (command_id, job_id, kind, payload_json, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        input.commandId,
        input.jobId,
        input.kind,
        input.payload === undefined ? null : canonicalJson(input.payload),
        record.createdAt,
      );
      return { record, inserted: true };
    });
  }

  listPendingCommands(jobId: string): JobCommandRecord[] {
    return this.read(() =>
      this.allRows(
        `SELECT * FROM job_commands WHERE job_id = ? AND delivered_at IS NULL
           ORDER BY created_at, command_id`,
        jobId,
      ),
    ).map(rowToJobCommand);
  }

  markCommandDelivered(commandId: string): JobCommandRecord {
    return this.write(() => {
      this.requireCommand(commandId);
      this.mutate(
        `UPDATE job_commands SET delivered_at = ? WHERE command_id = ? AND delivered_at IS NULL`,
        this.now(),
        commandId,
      );
      return this.requireCommand(commandId);
    });
  }

  getCompletion(completionId: string): CompletionOutboxRecord | undefined {
    return this.read(() => {
      const row = this.getCompletionRow(completionId);
      return row === undefined ? undefined : rowToCompletion(row);
    });
  }

  listPendingCompletions(
    input: number | { limit?: number; ownerSessionId?: string } = 100,
  ): CompletionOutboxRecord[] {
    const options = typeof input === "number" ? { limit: input } : input;
    return this.read(() => {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
      if (options.ownerSessionId === undefined) {
        return this.allRows(
          `SELECT * FROM completion_outbox WHERE delivered_at IS NULL
           ORDER BY created_at, completion_id LIMIT ?`,
          limit,
        ).map(rowToCompletion);
      }
      return this.allRows(
        `SELECT c.* FROM completion_outbox c
         JOIN jobs j ON j.job_id = c.job_id
         WHERE c.delivered_at IS NULL AND j.owner_session_id = ?
         ORDER BY c.created_at, c.completion_id LIMIT ?`,
        options.ownerSessionId,
        limit,
      ).map(rowToCompletion);
    });
  }

  markCompletionDelivered(completionId: string): CompletionOutboxRecord {
    return this.write(() => {
      this.requireCompletion(completionId);
      this.markCompletionRowDelivered(completionId);
      return this.requireCompletion(completionId);
    });
  }

  createMergeRequest(
    input: Omit<MergeRequestRecord, "version" | "createdAt" | "updatedAt">,
  ): MergeRequestRecord {
    return this.write(() => {
      if (this.getMergeRow(input.mergeRequestId)) {
        throw new RuntimeConflictError(`合并请求 ${input.mergeRequestId} 已存在`);
      }
      this.requireJob(input.jobId);
      if (input.attemptId) {
        const attempt = this.requireAttempt(input.attemptId);
        if (attempt.jobId !== input.jobId) {
          throw new RuntimeConflictError(
            `合并请求 ${input.mergeRequestId} 的 attempt ${input.attemptId} 不属于 job ${input.jobId}`,
          );
        }
      }
      const now = this.now();
      const record: MergeRequestRecord = compact({
        ...input,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      this.mutate(
        `INSERT INTO merge_requests (merge_request_id, job_id, attempt_id, source_branch,
           source_worktree, target_branch, target_worktree, source_head, status, error,
           version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        input.mergeRequestId,
        input.jobId,
        input.attemptId ?? null,
        input.sourceBranch,
        input.sourceWorktree,
        input.targetBranch,
        input.targetWorktree,
        input.sourceHead ?? null,
        input.status,
        now,
        now,
      );
      return record;
    });
  }

  updateMergeRequest(
    mergeRequestId: string,
    expectedVersion: number,
    status: MergeRequestStatus,
    error?: string,
  ): MergeRequestRecord {
    return this.write(() => {
      const current = this.requireMerge(mergeRequestId);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`合并请求 ${mergeRequestId} 的版本 CAS 失败`);
      }
      const record: MergeRequestRecord = compact<MergeRequestRecord>({
        ...current,
        status,
        error,
        updatedAt: this.now(),
        version: current.version + 1,
      });
      this.mutate(
        `UPDATE merge_requests SET status = ?, error = ?, updated_at = ?,
           version = version + 1 WHERE merge_request_id = ?`,
        status,
        error ?? null,
        record.updatedAt,
        mergeRequestId,
      );
      return record;
    });
  }

  listMergeRequests(jobId?: string): MergeRequestRecord[] {
    return this.read(() =>
      jobId === undefined
        ? this.allRows(`SELECT * FROM merge_requests ORDER BY created_at, merge_request_id`)
        : this.allRows(
            `SELECT * FROM merge_requests WHERE job_id = ? ORDER BY created_at, merge_request_id`,
            jobId,
          ),
    ).map(rowToMerge);
  }

  recordProviderCall(record: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number }): {
    record: ProviderCallRecord;
    inserted: boolean;
  } {
    return this.write((tx) => {
      if (record.jobId) this.requireJob(record.jobId);
      if (record.attemptId) {
        const attempt = this.requireAttempt(record.attemptId);
        if (record.jobId && attempt.jobId !== record.jobId) {
          throw new RuntimeConflictError(
            `Provider call ${record.callId} 的 attempt ${record.attemptId} 不属于 job ${record.jobId}`,
          );
        }
      }
      const existingRow = this.getRow(
        `SELECT * FROM usage_provider_calls WHERE call_id = ?`,
        record.callId,
      );
      if (existingRow) {
        const existing = rowToProviderCall(existingRow);
        if (!sameProviderCall(existing, record)) {
          throw new RuntimeConflictError(`Provider call ID ${record.callId} 已被其他调用使用`);
        }
        return { record: existing, inserted: false };
      }
      const stored: ProviderCallRecord = compact({
        ...record,
        createdAt: record.createdAt ?? this.now(),
      });
      this.mutate(
        `INSERT INTO usage_provider_calls (call_id, tx_id, session_id, conversation_id, goal_id,
           job_id, attempt_id, purpose, provider, model, route, status, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens, cost, reported_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        stored.callId,
        tx.transactionId,
        stored.sessionId ?? null,
        stored.conversationId ?? null,
        stored.goalId ?? null,
        stored.jobId ?? null,
        stored.attemptId ?? null,
        stored.purpose,
        stored.provider,
        stored.model,
        stored.route ?? null,
        stored.status,
        stored.inputTokens,
        stored.outputTokens,
        stored.cacheReadTokens,
        stored.cacheWriteTokens,
        stored.cost,
        stored.reported === undefined ? null : canonicalJson(stored.reported),
        stored.createdAt,
      );
      return { record: stored, inserted: true };
    });
  }

  putUsageBaseline(record: UsageBaselineRecord): {
    record: UsageBaselineRecord;
    inserted: boolean;
  } {
    return this.write(() => {
      const existingRow = this.getRow(
        `SELECT * FROM usage_baselines WHERE baseline_id = ?`,
        record.baselineId,
      );
      if (existingRow) return { record: rowToBaseline(existingRow), inserted: false };
      this.mutate(
        `INSERT INTO usage_baselines (baseline_id, session_id, goal_id, input_tokens,
           output_tokens, cache_read_tokens, cache_write_tokens, cost, imported_at, source_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.baselineId,
        record.sessionId ?? null,
        record.goalId ?? null,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.cost,
        record.importedAt,
        record.source === undefined ? null : canonicalJson(record.source),
      );
      return { record, inserted: true };
    });
  }

  listProviderCalls(filter: UsageLedgerFilter = {}): ProviderCallRecord[] {
    return this.read(() => {
      const { clauses, params } = usageCallFilterClauses(filter);
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return this.allRows(
        `SELECT * FROM usage_provider_calls${where} ORDER BY created_at, call_id`,
        ...params,
      ).map(rowToProviderCall);
    });
  }

  listUsageBaselines(filter: Omit<UsageLedgerFilter, "jobId"> = {}): UsageBaselineRecord[] {
    return this.read(() => {
      const { clauses, params } = usageCallFilterClauses({ ...filter, jobId: undefined });
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      return this.allRows(
        `SELECT * FROM usage_baselines${where} ORDER BY imported_at, baseline_id`,
        ...params,
      ).map(rowToBaseline);
    });
  }

  getUsageSummary(filter: UsageLedgerFilter = {}): UsageLedgerSummary {
    return this.read(() => {
      const { clauses, params } = usageCallFilterClauses(filter);
      const callWhere = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const providerCallCount = this.getNumber(
        `SELECT COUNT(*) AS n FROM usage_provider_calls${callWhere}`,
        ...params,
      );
      const providerTotals = this.usageTotals(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(cost), 0) AS cost
         FROM usage_provider_calls${callWhere}`,
        ...params,
      );
      let baselineCount = 0;
      let baselineTotals = emptyUsage();
      if (filter.jobId === undefined) {
        const { clauses: baselineClauses, params: baselineParams } = usageCallFilterClauses({
          ...filter,
          jobId: undefined,
        });
        const baselineWhere = baselineClauses.length
          ? ` WHERE ${baselineClauses.join(" AND ")}`
          : "";
        baselineCount = this.getNumber(
          `SELECT COUNT(*) AS n FROM usage_baselines${baselineWhere}`,
          ...baselineParams,
        );
        baselineTotals = this.usageTotals(
          `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             COALESCE(SUM(cost), 0) AS cost
           FROM usage_baselines${baselineWhere}`,
          ...baselineParams,
        );
      }
      return {
        providerCallCount,
        baselineCount,
        providerCalls: providerTotals,
        baselines: baselineTotals,
        total: addUsage(providerTotals, baselineTotals),
      };
    });
  }

  // ---- 内部:事务与 SQL 基础设施 ----

  private write<T>(operation: (tx: ControlWriteTx) => T): T {
    const active = activeControlWrites.get(this.storageRoot);
    if (active) {
      // 嵌套写(同根活跃事务,可能来自另一个 store 实例):SAVEPOINT 划出与旧实现
      // savepoint 等价的回滚边界;失败只回滚嵌套段的行变更。
      const savepoint = `control_sp_${active.savepointCounter++}`;
      this.database().exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation(active);
        this.database().exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.database().exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database().exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // 保留原始错误
        }
        throw error;
      }
    }
    return this.lease.transaction("write", () => {
      const tx: ControlWriteTx = {
        transactionId: randomUUID(),
        dirty: false,
        eventSequenceCache: undefined,
        savepointCounter: 0,
      };
      activeControlWrites.set(this.storageRoot, tx);
      try {
        this.seedControlMetadata();
        const result = operation(tx);
        if (tx.dirty) {
          const revision = this.readMetadataNumber(REVISION_KEY);
          this.mutate(
            `UPDATE control_metadata SET value_json = ? WHERE key = ?`,
            JSON.stringify(revision + 1),
            REVISION_KEY,
          );
          this.mutate(
            `INSERT INTO control_metadata (key, value_json) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
            LAST_TRANSACTION_ID_KEY,
            JSON.stringify(tx.transactionId),
          );
        }
        return result;
      } finally {
        activeControlWrites.delete(this.storageRoot);
      }
    });
  }

  private read<T>(operation: () => T): T {
    if (activeControlWrites.has(this.storageRoot)) return operation();
    return this.lease.transaction("read", operation);
  }

  private database() {
    return this.lease.database;
  }

  private statement(sql: string): StatementSync {
    let cached = this.statements.get(sql);
    if (cached === undefined) {
      cached = this.database().prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  private mutate(sql: string, ...params: unknown[]): number {
    const result = this.statement(sql).run(...(params as SQLInputValue[]));
    const changes = typeof result.changes === "number" ? result.changes : Number(result.changes);
    const tx = activeControlWrites.get(this.storageRoot);
    if (tx && changes > 0) tx.dirty = true;
    return changes;
  }

  private allRows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
    return this.statement(sql).all(...(params as SQLInputValue[])) as Array<
      Record<string, unknown>
    >;
  }

  private getRow(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.statement(sql).get(...(params as SQLInputValue[])) as
      | Record<string, unknown>
      | undefined;
  }

  private getNumber(sql: string, ...params: unknown[]): number {
    const row = this.getRow(sql, ...params);
    const value = row?.["n"];
    if (typeof value !== "number") throw corrupt("数值聚合结果");
    return value;
  }

  private usageTotals(sql: string, ...params: unknown[]): UsageLedgerTotals {
    const row = this.getRow(sql, ...params);
    if (row === undefined) throw corrupt("usage 聚合结果");
    return {
      inputTokens: numberField(row, "input_tokens"),
      outputTokens: numberField(row, "output_tokens"),
      cacheReadTokens: numberField(row, "cache_read_tokens"),
      cacheWriteTokens: numberField(row, "cache_write_tokens"),
      cost: numberField(row, "cost"),
    };
  }

  private seedControlMetadata(): void {
    this.mutate(
      `INSERT INTO control_metadata (key, value_json) VALUES (?, ?), (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      REVISION_KEY,
      "0",
      NEXT_RUNTIME_EVENT_SEQUENCE_KEY,
      "1",
    );
  }

  private readMetadataNumber(key: string): number {
    const row = this.getRow(`SELECT value_json FROM control_metadata WHERE key = ?`, key);
    if (row === undefined) throw corrupt(`control_metadata.${key}`);
    const value = JSON.parse(textField(row, "value_json")) as unknown;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw corrupt(`control_metadata.${key}`);
    }
    return value;
  }

  private allocateEventSequence(tx: ControlWriteTx): number {
    if (tx.eventSequenceCache === undefined) {
      tx.eventSequenceCache = this.readMetadataNumber(NEXT_RUNTIME_EVENT_SEQUENCE_KEY);
    }
    const sequence = tx.eventSequenceCache;
    tx.eventSequenceCache = sequence + 1;
    this.mutate(
      `UPDATE control_metadata SET value_json = ? WHERE key = ?`,
      JSON.stringify(sequence + 1),
      NEXT_RUNTIME_EVENT_SEQUENCE_KEY,
    );
    return sequence;
  }

  private insertRuntimeEvent(
    tx: ControlWriteTx,
    input: Omit<RuntimeEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: number;
    },
  ): RuntimeEventRecord {
    const eventId = input.eventId ?? generateRuntimeId("event");
    if (this.getRow(`SELECT 1 AS one FROM daemon_events WHERE event_id = ?`, eventId)) {
      throw new RuntimeConflictError(`Runtime event ID ${eventId} 已存在`);
    }
    const event: RuntimeEventRecord = compact({
      ...input,
      eventId,
      createdAt: input.createdAt ?? this.now(),
    });
    const sequence = this.allocateEventSequence(tx);
    this.mutate(
      `INSERT INTO daemon_events (event_id, tx_id, sequence, topic, workspace_path, cron_job_id,
         cron_run_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      tx.transactionId,
      sequence,
      event.topic,
      event.workspacePath,
      event.cronJobId ?? null,
      event.cronRunId ?? null,
      event.payload === undefined ? null : canonicalJson(event.payload),
      event.createdAt,
    );
    return event;
  }

  private getEventSequence(eventId: string, workspacePath: string | undefined): number | undefined {
    const row =
      workspacePath === undefined
        ? this.getRow(`SELECT sequence FROM daemon_events WHERE event_id = ?`, eventId)
        : this.getRow(
            `SELECT sequence FROM daemon_events WHERE event_id = ? AND workspace_path = ?`,
            eventId,
            workspacePath,
          );
    if (row === undefined) return undefined;
    return numberField(row, "sequence");
  }

  private insertCompletion(record: CompletionOutboxRecord): void {
    const existingRow = this.getCompletionRow(record.completionId);
    if (existingRow) {
      const existing = rowToCompletion(existingRow);
      if (
        existing.jobId !== record.jobId ||
        existing.attemptId !== record.attemptId ||
        existing.status !== record.status ||
        !sameJson(existing.payload, record.payload)
      ) {
        throw new RuntimeConflictError(`Completion ID ${record.completionId} 已被其他终态使用`);
      }
      return;
    }
    this.mutate(
      `INSERT INTO completion_outbox (completion_id, job_id, attempt_id, policy, status,
         payload_json, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      record.completionId,
      record.jobId,
      record.attemptId ?? null,
      record.policy,
      record.status,
      record.payload === undefined ? null : canonicalJson(record.payload),
      record.createdAt,
    );
  }

  private markCompletionRowDelivered(completionId: string): void {
    this.mutate(
      `UPDATE completion_outbox SET delivered_at = ? WHERE completion_id = ? AND delivered_at IS NULL`,
      this.now(),
      completionId,
    );
  }

  private persistDaemonRun(input: DaemonRunRecord): DaemonRunRecord {
    const existingRow = this.getRow(`SELECT * FROM daemon_runs WHERE run_id = ?`, input.runId);
    if (existingRow && rowToDaemonRun(existingRow).workspacePath !== input.workspacePath) {
      throw new RuntimeConflictError(`Run ID ${input.runId} 已属于其他工作区`);
    }
    if (existingRow) {
      const existing = rowToDaemonRun(existingRow);
      if (input.version >= existing.version) {
        this.mutate(
          `UPDATE daemon_runs SET session_id = ?, checkpoint_id = ?, description = ?, status = ?,
             updated_at = ?, finished_at = ?, error = ?, result_json = ?, version = ?
           WHERE run_id = ?`,
          input.sessionId ?? null,
          input.checkpointId ?? null,
          input.description,
          input.status,
          input.updatedAt,
          input.finishedAt ?? null,
          input.error ?? null,
          input.result === undefined ? null : canonicalJson(input.result),
          input.version,
          input.runId,
        );
        return input;
      }
      return existing;
    }
    this.mutate(
      `INSERT INTO daemon_runs (run_id, workspace_path, session_id, checkpoint_id, description,
         status, started_at, updated_at, finished_at, error, result_json, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.runId,
      input.workspacePath,
      input.sessionId ?? null,
      input.checkpointId ?? null,
      input.description,
      input.status,
      input.startedAt,
      input.updatedAt,
      input.finishedAt ?? null,
      input.error ?? null,
      input.result === undefined ? null : canonicalJson(input.result),
      input.version,
    );
    return input;
  }

  private updateAttemptTerminal(attemptId: string, attempt: JobAttemptRecord, now: number): void {
    this.mutate(
      `UPDATE job_attempts SET status = ?, owner_id = ?, lease_epoch = ?, output_offset = ?,
         error = ?, result_json = ?, finished_at = ?, updated_at = ?, version = version + 1
       WHERE attempt_id = ?`,
      attempt.status,
      attempt.ownerId,
      attempt.leaseEpoch,
      attempt.outputOffset,
      attempt.error ?? null,
      attempt.result === undefined ? null : canonicalJson(attempt.result),
      now,
      now,
      attemptId,
    );
  }

  private upsertLease(record: RuntimeLeaseRecord): void {
    this.mutate(
      `INSERT INTO runtime_leases (resource_key, owner_id, lease_epoch, heartbeat_at, expires_at, version)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET owner_id = excluded.owner_id,
         lease_epoch = excluded.lease_epoch, heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at, version = excluded.version`,
      record.resourceKey,
      record.ownerId,
      record.leaseEpoch,
      record.heartbeatAt,
      record.expiresAt,
      record.version,
    );
  }

  private selectLease(resourceKey: string): RuntimeLeaseRecord | undefined {
    const row = this.getRow(`SELECT * FROM runtime_leases WHERE resource_key = ?`, resourceKey);
    return row === undefined ? undefined : rowToLease(row);
  }

  private assertLease(resourceKey: string, ownerId: string, leaseEpoch: number): void {
    const current = this.selectLease(resourceKey);
    if (
      !current ||
      current.ownerId !== ownerId ||
      current.leaseEpoch !== leaseEpoch ||
      current.expiresAt <= this.now()
    ) {
      throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化或过期`);
    }
  }

  private getJobRow(jobId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM jobs WHERE job_id = ?`, jobId);
  }

  private requireJob(jobId: string): JobRecord {
    const row = this.getJobRow(jobId);
    if (row === undefined) throw new Error(`未知任务: ${jobId}`);
    return rowToJob(row);
  }

  private getAttemptRow(attemptId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM job_attempts WHERE attempt_id = ?`, attemptId);
  }

  private requireAttempt(attemptId: string): JobAttemptRecord {
    const row = this.getAttemptRow(attemptId);
    if (row === undefined) throw new Error(`未知 attempt: ${attemptId}`);
    return rowToAttempt(row);
  }

  private getCommandRow(commandId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM job_commands WHERE command_id = ?`, commandId);
  }

  private requireCommand(commandId: string): JobCommandRecord {
    const row = this.getCommandRow(commandId);
    if (row === undefined) throw new Error(`未知命令: ${commandId}`);
    return rowToJobCommand(row);
  }

  private getCompletionRow(completionId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM completion_outbox WHERE completion_id = ?`, completionId);
  }

  private requireCompletion(completionId: string): CompletionOutboxRecord {
    const row = this.getCompletionRow(completionId);
    if (row === undefined) throw new Error(`未知 completion: ${completionId}`);
    return rowToCompletion(row);
  }

  private getMergeRow(mergeRequestId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM merge_requests WHERE merge_request_id = ?`, mergeRequestId);
  }

  private requireMerge(mergeRequestId: string): MergeRequestRecord {
    const row = this.getMergeRow(mergeRequestId);
    if (row === undefined) throw new Error(`未知合并请求: ${mergeRequestId}`);
    return rowToMerge(row);
  }

  private getCronJobRow(cronJobId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM cron_jobs WHERE cron_job_id = ?`, cronJobId);
  }

  private requireCronJob(cronJobId: string): CronJobRecord {
    const row = this.getCronJobRow(cronJobId);
    if (row === undefined) throw new Error(`未知 Cron Job: ${cronJobId}`);
    return rowToCronJob(row);
  }

  private getCronRunRow(cronRunId: string): Record<string, unknown> | undefined {
    return this.getRow(`SELECT * FROM cron_runs WHERE cron_run_id = ?`, cronRunId);
  }

  private getCronRunRowByStatus(
    cronJobId: string,
    status: string,
  ): Record<string, unknown> | undefined {
    return this.getRow(
      `SELECT * FROM cron_runs WHERE cron_job_id = ? AND status = ? LIMIT 1`,
      cronJobId,
      status,
    );
  }

  private requireCronRun(cronRunId: string): CronRunRecord {
    const row = this.getCronRunRow(cronRunId);
    if (row === undefined) throw new Error(`未知 Cron Run: ${cronRunId}`);
    return rowToCronRun(row);
  }

  private closeQueuedCronRun(
    cronRunId: string,
    status: "blocked" | "skipped",
    reason: string,
  ): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(cronRunId);
      if (current.status === status) return current;
      if (current.status !== "queued") {
        throw new RuntimeConflictError(
          `Cron Run ${cronRunId} 已进入 ${current.status}，不能${
            status === "blocked" ? "阻断" : "跳过"
          }`,
        );
      }
      const now = this.now();
      const run: CronRunRecord = {
        ...current,
        status,
        reason,
        finishedAt: now,
        version: current.version + 1,
      };
      this.mutate(
        `UPDATE cron_runs SET status = ?, reason = ?, finished_at = ?, version = version + 1
           WHERE cron_run_id = ?`,
        status,
        reason,
        now,
        cronRunId,
      );
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId,
        payload: { reason },
      });
      return run;
    });
  }
}

// ---- 行解码:SQLite NULL → JS null,统一视作字段缺省 ----

type Row = Record<string, unknown>;

function rowToJob(row: Row): JobRecord {
  return compact({
    jobId: textField(row, "job_id"),
    type: textField(row, "type"),
    status: textField(row, "status") as JobRecord["status"],
    executionClass: textField(row, "execution_class") as JobRecord["executionClass"],
    completionPolicy: textField(row, "completion_policy") as JobRecord["completionPolicy"],
    description: textField(row, "description"),
    ownerSessionId: optionalTextField(row, "owner_session_id"),
    childSessionId: optionalTextField(row, "child_session_id"),
    toolUseId: optionalTextField(row, "tool_use_id"),
    outputPath: optionalTextField(row, "output_path"),
    data: jsonRecordField(row, "data_json"),
    version: numberField(row, "version"),
    leaseEpoch: numberField(row, "lease_epoch"),
    attemptCount: numberField(row, "attempt_count"),
    createdAt: numberField(row, "created_at"),
    updatedAt: numberField(row, "updated_at"),
    terminalAt: optionalNumberField(row, "terminal_at"),
    error: optionalTextField(row, "error"),
  });
}

function rowToAttempt(row: Row): JobAttemptRecord {
  return compact({
    attemptId: textField(row, "attempt_id"),
    jobId: textField(row, "job_id"),
    attemptNumber: numberField(row, "attempt_number"),
    status: textField(row, "status") as JobAttemptRecord["status"],
    ownerId: textField(row, "owner_id"),
    leaseEpoch: numberField(row, "lease_epoch"),
    outputPath: optionalTextField(row, "output_path"),
    outputOffset: numberField(row, "output_offset"),
    startedAt: numberField(row, "started_at"),
    updatedAt: numberField(row, "updated_at"),
    finishedAt: optionalNumberField(row, "finished_at"),
    error: optionalTextField(row, "error"),
    result: jsonRecordField(row, "result_json"),
    version: numberField(row, "version"),
  });
}

function rowToLease(row: Row): RuntimeLeaseRecord {
  return {
    resourceKey: textField(row, "resource_key"),
    ownerId: textField(row, "owner_id"),
    leaseEpoch: numberField(row, "lease_epoch"),
    heartbeatAt: numberField(row, "heartbeat_at"),
    expiresAt: numberField(row, "expires_at"),
    version: numberField(row, "version"),
  };
}

function rowToCronJob(row: Row): CronJobRecord {
  const credentialRef = optionalTextField(row, "credential_ref");
  return compact({
    cronJobId: textField(row, "cron_job_id"),
    workspacePath: textField(row, "workspace_path"),
    name: textField(row, "name"),
    schedule: textField(row, "schedule"),
    timeZone: textField(row, "time_zone"),
    prompt: textField(row, "prompt"),
    enabled: numberField(row, "enabled") === 1,
    policySnapshot: parseBackgroundYoloPolicySnapshot(jsonField(row, "policy_snapshot_json")),
    credentialRef:
      credentialRef === undefined ? undefined : parseAnyCredentialRef(credentialRef).ref,
    modelRouteId: optionalTextField(row, "model_route_id"),
    version: numberField(row, "version"),
    createdAt: numberField(row, "created_at"),
    updatedAt: numberField(row, "updated_at"),
  });
}

function rowToCronRun(row: Row): CronRunRecord {
  return compact({
    cronRunId: textField(row, "cron_run_id"),
    cronJobId: textField(row, "cron_job_id"),
    workspacePath: textField(row, "workspace_path"),
    scheduledFor: numberField(row, "scheduled_for"),
    status: textField(row, "status") as CronRunStatus,
    ownerId: optionalTextField(row, "owner_id"),
    leaseEpoch: numberField(row, "lease_epoch"),
    createdAt: numberField(row, "created_at"),
    startedAt: optionalNumberField(row, "started_at"),
    finishedAt: optionalNumberField(row, "finished_at"),
    reason: optionalTextField(row, "reason"),
    result: jsonRecordField(row, "result_json"),
    version: numberField(row, "version"),
  });
}

function rowToDaemonCommand(row: Row): DaemonCommandState {
  return compact({
    commandType: textField(row, "command_type"),
    idempotencyKey: textField(row, "idempotency_key"),
    requestHash: textField(row, "request_hash"),
    requestJson: textField(row, "request_json"),
    status: textField(row, "status") as DaemonCommandState["status"],
    result: jsonRecordField(row, "result_json"),
    resourceId: optionalTextField(row, "resource_id"),
    createdAt: numberField(row, "created_at"),
    updatedAt: numberField(row, "updated_at"),
  });
}

function rowToDaemonRun(row: Row): DaemonRunRecord {
  return compact({
    runId: textField(row, "run_id"),
    workspacePath: textField(row, "workspace_path"),
    sessionId: optionalTextField(row, "session_id"),
    checkpointId: optionalTextField(row, "checkpoint_id"),
    description: textField(row, "description"),
    status: textField(row, "status") as DaemonRunRecord["status"],
    startedAt: numberField(row, "started_at"),
    updatedAt: numberField(row, "updated_at"),
    finishedAt: optionalNumberField(row, "finished_at"),
    error: optionalTextField(row, "error"),
    result: jsonRecordField(row, "result_json"),
    version: numberField(row, "version"),
  });
}

function rowToJobCommand(row: Row): JobCommandRecord {
  return compact({
    commandId: textField(row, "command_id"),
    jobId: textField(row, "job_id"),
    kind: textField(row, "kind") as JobCommandKind,
    payload: jsonRecordField(row, "payload_json"),
    createdAt: numberField(row, "created_at"),
    deliveredAt: optionalNumberField(row, "delivered_at"),
  });
}

function rowToCompletion(row: Row): CompletionOutboxRecord {
  return compact({
    completionId: textField(row, "completion_id"),
    jobId: textField(row, "job_id"),
    attemptId: optionalTextField(row, "attempt_id"),
    policy: textField(row, "policy") as CompletionOutboxRecord["policy"],
    status: textField(row, "status") as CompletionOutboxRecord["status"],
    payload: jsonRecordField(row, "payload_json"),
    createdAt: numberField(row, "created_at"),
    deliveredAt: optionalNumberField(row, "delivered_at"),
  });
}

function rowToMerge(row: Row): MergeRequestRecord {
  return compact({
    mergeRequestId: textField(row, "merge_request_id"),
    jobId: textField(row, "job_id"),
    attemptId: optionalTextField(row, "attempt_id"),
    sourceBranch: textField(row, "source_branch"),
    sourceWorktree: textField(row, "source_worktree"),
    targetBranch: textField(row, "target_branch"),
    targetWorktree: textField(row, "target_worktree"),
    sourceHead: optionalTextField(row, "source_head"),
    status: textField(row, "status") as MergeRequestRecord["status"],
    error: optionalTextField(row, "error"),
    version: numberField(row, "version"),
    createdAt: numberField(row, "created_at"),
    updatedAt: numberField(row, "updated_at"),
  });
}

function rowToRuntimeEvent(row: Row): RuntimeEventRecord {
  return compact({
    eventId: textField(row, "event_id"),
    topic: textField(row, "topic"),
    workspacePath: optionalTextField(row, "workspace_path") ?? "",
    cronJobId: optionalTextField(row, "cron_job_id"),
    cronRunId: optionalTextField(row, "cron_run_id"),
    payload: jsonRecordField(row, "payload_json"),
    createdAt: numberField(row, "created_at"),
  });
}

function rowToProviderCall(row: Row): ProviderCallRecord {
  return compact({
    callId: textField(row, "call_id"),
    sessionId: optionalTextField(row, "session_id"),
    conversationId: optionalTextField(row, "conversation_id"),
    goalId: optionalTextField(row, "goal_id"),
    jobId: optionalTextField(row, "job_id"),
    attemptId: optionalTextField(row, "attempt_id"),
    purpose: textField(row, "purpose") as ProviderCallRecord["purpose"],
    provider: textField(row, "provider"),
    model: textField(row, "model"),
    route: optionalTextField(row, "route"),
    status: textField(row, "status") as ProviderCallRecord["status"],
    inputTokens: numberField(row, "input_tokens"),
    outputTokens: numberField(row, "output_tokens"),
    cacheReadTokens: numberField(row, "cache_read_tokens"),
    cacheWriteTokens: numberField(row, "cache_write_tokens"),
    cost: numberField(row, "cost"),
    reported: jsonRecordField(row, "reported_json"),
    createdAt: numberField(row, "created_at"),
  });
}

function rowToBaseline(row: Row): UsageBaselineRecord {
  return compact({
    baselineId: textField(row, "baseline_id"),
    sessionId: optionalTextField(row, "session_id"),
    goalId: optionalTextField(row, "goal_id"),
    inputTokens: numberField(row, "input_tokens"),
    outputTokens: numberField(row, "output_tokens"),
    cacheReadTokens: numberField(row, "cache_read_tokens"),
    cacheWriteTokens: numberField(row, "cache_write_tokens"),
    cost: numberField(row, "cost"),
    importedAt: numberField(row, "imported_at"),
    source: jsonRecordField(row, "source_json"),
  });
}

// ---- 纯函数辅助(与旧实现同语义的小工具) ----

function usageCallFilterClauses(filter: { sessionId?: string; goalId?: string; jobId?: string }): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.goalId !== undefined) {
    clauses.push("goal_id = ?");
    params.push(filter.goalId);
  }
  if (filter.jobId !== undefined) {
    clauses.push("job_id = ?");
    params.push(filter.jobId);
  }
  return { clauses, params };
}

function daemonCommandKey(commandType: string, idempotencyKey: string): string {
  return `${commandType}\0${idempotencyKey}`;
}

function validateCredentialRoute(
  credential: ReturnType<typeof parseAnyCredentialRef> | undefined,
  modelRouteId: string | undefined,
): void {
  if (credential?.version === "v2" && modelRouteId === undefined) {
    throw new Error("v2 Provider credentialRef 必须配套固定 modelRouteId");
  }
  if (
    credential?.version === "v1" &&
    modelRouteId !== undefined &&
    credential.modelRouteId !== modelRouteId
  ) {
    throw new Error("modelRouteId 与 v1 credentialRef 绑定的路由不一致");
  }
  if (
    credential?.version === "v2" &&
    modelRouteId !== undefined &&
    providerIdFromModelRoute(modelRouteId) !== credential.providerId
  ) {
    throw new Error("modelRouteId 与 v2 credentialRef 绑定的 Provider 不一致");
  }
}

function normalizeOptionalModelRouteId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[^/\s]+\/.+$/u.test(normalized)) {
    throw new Error("modelRouteId 必须使用 providerID/modelID 格式");
  }
  return normalized;
}

function providerIdFromModelRoute(modelRouteId: string): string {
  return modelRouteId.slice(0, modelRouteId.indexOf("/"));
}

function normalizeCronJobName(name: string | undefined, prompt = ""): string {
  const normalized = (name ?? prompt).trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Cron Job name 必须是非空字符串");
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 79)}…`;
}

function normalizeCronPrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("Cron Job prompt 必须是非空字符串");
  return normalized;
}

function interruptedCompletionPayload(
  job: JobRecord,
  completionId: string,
  reason: string,
  completionSeq: number,
): Record<string, unknown> {
  const base = { reason, executionClass: job.executionClass };
  if (job.type !== "local_agent" || !job.ownerSessionId) return base;
  const activityIds = Array.isArray(job.data?.["activityIds"])
    ? job.data["activityIds"].filter((value): value is string => typeof value === "string")
    : [];
  const error = `子代理运行时 lease 过期，已中断：${reason}`;
  return {
    ...base,
    delegationCompletion: {
      completionId,
      jobId: job.jobId,
      ownerSessionId: job.ownerSessionId,
      completionSeq,
      activityIds,
      completionPolicy: job.completionPolicy,
      status: "error",
      outputSummary: error,
      error: reason,
    },
  };
}

function daemonRunRecoveryEvent(run: DaemonRunRecord): RuntimeEventRecord {
  const eventId = `${DAEMON_RUN_RECOVERY_EVENT_PREFIX}${createHash("sha256")
    .update(`${run.workspacePath}\0${run.runId}\0${run.version}`)
    .digest("hex")}`;
  return {
    eventId,
    topic: "run.finished",
    workspacePath: run.workspacePath,
    payload: {
      scope: compact({
        workspacePath: run.workspacePath,
        sessionId: run.sessionId,
        runId: run.runId,
      }),
      resourceVersion: run.version,
      payload: {
        run: compact({
          runId: run.runId,
          workspacePath: run.workspacePath,
          sessionId: run.sessionId,
          description: run.description,
          status: run.status,
          startedAt: run.startedAt,
          updatedAt: run.updatedAt,
          finishedAt: run.finishedAt,
          error: run.error,
          result: run.result,
          version: run.version,
        }),
      },
    },
    createdAt: run.finishedAt ?? run.updatedAt,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function sameProviderCall(
  stored: ProviderCallRecord,
  input: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number },
): boolean {
  return (
    stored.callId === input.callId &&
    stored.sessionId === input.sessionId &&
    stored.conversationId === input.conversationId &&
    stored.goalId === input.goalId &&
    stored.jobId === input.jobId &&
    stored.attemptId === input.attemptId &&
    stored.purpose === input.purpose &&
    stored.provider === input.provider &&
    stored.model === input.model &&
    stored.route === input.route &&
    stored.status === input.status &&
    stored.inputTokens === input.inputTokens &&
    stored.outputTokens === input.outputTokens &&
    stored.cacheReadTokens === input.cacheReadTokens &&
    stored.cacheWriteTokens === input.cacheWriteTokens &&
    stored.cost === input.cost &&
    isDeepStrictEqual(stored.reported, input.reported)
  );
}

function addUsage(left: UsageLedgerTotals, right: UsageLedgerTotals): UsageLedgerTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cost: left.cost + right.cost,
  };
}

function emptyUsage(): UsageLedgerTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, current]) => current !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corrupt(field: string): Error {
  return new Error(`pico.sqlite control 面数据已损坏: ${field}`);
}

function textField(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw corrupt(key);
  return value;
}

function optionalTextField(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw corrupt(key);
  return value;
}

function numberField(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw corrupt(key);
  return value;
}

function optionalNumberField(row: Row, key: string): number | undefined {
  return row[key] == null ? undefined : numberField(row, key);
}

function jsonField(row: Row, key: string): unknown {
  const value = row[key];
  if (typeof value !== "string") throw corrupt(key);
  return JSON.parse(value) as unknown;
}

function jsonRecordField(row: Row, key: string): Record<string, unknown> | undefined {
  const value = row[key];
  if (value == null) return undefined;
  if (typeof value !== "string") throw corrupt(key);
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw corrupt(key);
  return parsed;
}

export { generateRuntimeId } from "../../tasks/runtime-store-contracts.js";
