import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { quarantineCorruptJson } from "../storage/atomic-json.js";
import {
  JOB_COMPLETION_POLICIES,
  JOB_EXECUTION_CLASSES,
  JOB_STATUSES,
  CRON_RUN_STATUSES,
  MERGE_REQUEST_STATUSES,
  PROVIDER_CALL_PURPOSES,
  PROVIDER_CALL_STATUSES,
  type CompletionOutboxRecord,
  type CronJobRecord,
  type CronRunRecord,
  type CronRunStatus,
  type JobAttemptRecord,
  type JobCommandKind,
  type JobCommandRecord,
  type JobCompletionPolicy,
  type JobExecutionClass,
  type JobListFilter,
  type JobRecord,
  type JobStatus,
  type MergeRequestRecord,
  type MergeRequestStatus,
  type ProviderCallRecord,
  type RuntimeLeaseRecord,
  type RuntimeEventRecord,
  type TerminalJobStatus,
  type UsageBaselineRecord,
  type UsageLedgerFilter,
  type UsageLedgerSummary,
  type UsageLedgerTotals,
  type YoloPolicySnapshot,
  isTerminalJobStatus,
} from "./runtime-types.js";

const RUNTIME_SCHEMA_VERSION = 3;
const DEFAULT_LEASE_TTL_MS = 30_000;

export class RuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

export interface RuntimeStoreOptions {
  workDir: string;
  databasePath?: string;
  now?: () => number;
}

export interface CreateJobInput {
  jobId: string;
  type: string;
  executionClass: JobExecutionClass;
  completionPolicy: JobCompletionPolicy;
  description: string;
  ownerSessionId?: string;
  childSessionId?: string;
  toolUseId?: string;
  outputPath?: string;
  data?: Record<string, unknown>;
}

export interface StartJobInput {
  jobId: string;
  attemptId: string;
  ownerId: string;
  leaseEpoch: number;
  expectedVersion: number;
  outputPath?: string;
}

export interface FinishJobInput {
  jobId: string;
  attemptId: string;
  /** 调用 terminal 的宿主身份，必须与 attempt 及活跃 lease 的 owner 一致。 */
  ownerId: string;
  status: TerminalJobStatus;
  expectedJobVersion: number;
  expectedAttemptVersion: number;
  leaseEpoch: number;
  completionId: string;
  outputOffset?: number;
  error?: string;
  result?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
  completionAlreadyDelivered?: boolean;
}

export interface FinishJobResult {
  job: JobRecord;
  attempt: JobAttemptRecord;
  completion: CompletionOutboxRecord;
}

export interface CancelQueuedJobInput {
  jobId: string;
  expectedVersion: number;
  completionId: string;
  reason?: string;
}

export interface LegacyTaskImportResult {
  imported: number;
  skipped: number;
  interrupted: number;
  quarantinePath?: string;
}

export interface CreateCronJobInput {
  cronJobId: string;
  workspacePath: string;
  schedule: string;
  timeZone: string;
  prompt: string;
  policySnapshot: YoloPolicySnapshot;
  enabled?: boolean;
}

export interface CreateCronRunInput {
  cronRunId: string;
  cronJobId: string;
  scheduledFor: number;
  status: Extract<CronRunStatus, "queued" | "blocked" | "skipped">;
  reason?: string;
}

export interface ClaimCronRunInput {
  cronRunId: string;
  ownerId: string;
  leaseEpoch: number;
}

export interface FinishCronRunInput {
  cronRunId: string;
  ownerId: string;
  leaseEpoch: number;
  expectedVersion: number;
  status: Extract<CronRunStatus, "succeeded" | "failed" | "cancelled" | "blocked">;
  reason?: string;
  result?: Record<string, unknown>;
}

interface JobRow {
  job_id: string;
  type: string;
  status: string;
  execution_class: string;
  completion_policy: string;
  description: string;
  owner_session_id: string | null;
  child_session_id: string | null;
  tool_use_id: string | null;
  output_path: string | null;
  data_json: string | null;
  version: number;
  lease_epoch: number;
  attempt_count: number;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
  error: string | null;
}

interface AttemptRow {
  attempt_id: string;
  job_id: string;
  attempt_number: number;
  status: string;
  owner_id: string;
  lease_epoch: number;
  output_path: string | null;
  output_offset: number;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  error: string | null;
  result_json: string | null;
  version: number;
}

interface LeaseRow {
  resource_key: string;
  owner_id: string;
  lease_epoch: number;
  heartbeat_at: number;
  expires_at: number;
  version: number;
}

interface CommandRow {
  command_id: string;
  job_id: string;
  kind: string;
  payload_json: string | null;
  created_at: number;
  delivered_at: number | null;
}

interface CompletionRow {
  completion_id: string;
  job_id: string;
  attempt_id: string | null;
  policy: string;
  status: string;
  payload_json: string | null;
  created_at: number;
  delivered_at: number | null;
}

interface MergeRow {
  merge_request_id: string;
  job_id: string;
  attempt_id: string | null;
  source_branch: string;
  source_worktree: string;
  target_branch: string;
  target_worktree: string;
  source_head: string | null;
  status: string;
  error: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

interface ProviderCallRow {
  call_id: string;
  session_id: string | null;
  conversation_id: string | null;
  goal_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  purpose: string;
  provider: string;
  model: string;
  route: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  reported_json: string | null;
  created_at: number;
}

interface BaselineRow {
  baseline_id: string;
  session_id: string | null;
  goal_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  imported_at: number;
  source_json: string | null;
}

interface CronJobRow {
  cron_job_id: string;
  workspace_path: string;
  schedule: string;
  time_zone: string;
  prompt: string;
  enabled: number;
  policy_snapshot_json: string;
  version: number;
  created_at: number;
  updated_at: number;
}

interface CronRunRow {
  cron_run_id: string;
  cron_job_id: string;
  workspace_path: string;
  scheduled_for: number;
  status: string;
  owner_id: string | null;
  lease_epoch: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  reason: string | null;
  result_json: string | null;
  version: number;
}

interface RuntimeEventRow {
  event_id: string;
  topic: string;
  workspace_path: string;
  cron_job_id: string | null;
  cron_run_id: string | null;
  payload_json: string | null;
  created_at: number;
}

/** SQLite control plane for recoverable tasks. Session JSONL remains a separate source of truth. */
export class RuntimeStore {
  readonly databasePath: string;
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(options: RuntimeStoreOptions) {
    this.databasePath = options.databasePath ?? join(options.workDir, ".claw", "runtime.sqlite");
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.databasePath), 0o700);
    this.db = new Database(this.databasePath);
    try {
      chmodSync(this.databasePath, 0o600);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = FULL");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  get pragmas(): {
    journalMode: string;
    foreignKeys: number;
    busyTimeout: number;
    synchronous: number;
  } {
    return {
      journalMode: String(this.db.pragma("journal_mode", { simple: true })),
      foreignKeys: Number(this.db.pragma("foreign_keys", { simple: true })),
      busyTimeout: Number(this.db.pragma("busy_timeout", { simple: true })),
      synchronous: Number(this.db.pragma("synchronous", { simple: true })),
    };
  }

  acquireLease(
    resourceKey: string,
    ownerId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    if (ttlMs <= 0 || !Number.isFinite(ttlMs)) throw new Error("lease ttlMs 必须为正数");
    const acquire = this.db.transaction(() => {
      const now = this.now();
      const current = this.db
        .prepare("SELECT * FROM runtime_leases WHERE resource_key = ?")
        .get(resourceKey) as LeaseRow | undefined;
      if (current && current.expires_at > now && current.owner_id !== ownerId) {
        throw new RuntimeConflictError(
          `资源 ${resourceKey} 已由 ${current.owner_id} 持有至 ${current.expires_at}`,
        );
      }

      if (current && current.expires_at > now && current.owner_id === ownerId) {
        this.db
          .prepare(
            `UPDATE runtime_leases
             SET heartbeat_at = ?, expires_at = ?, version = version + 1
             WHERE resource_key = ? AND owner_id = ? AND lease_epoch = ?`,
          )
          .run(now, now + ttlMs, resourceKey, ownerId, current.lease_epoch);
      } else if (current) {
        this.db
          .prepare(
            `UPDATE runtime_leases
             SET owner_id = ?, lease_epoch = lease_epoch + 1,
                 heartbeat_at = ?, expires_at = ?, version = version + 1
             WHERE resource_key = ? AND version = ?`,
          )
          .run(ownerId, now, now + ttlMs, resourceKey, current.version);
      } else {
        this.db
          .prepare(
            `INSERT INTO runtime_leases
               (resource_key, owner_id, lease_epoch, heartbeat_at, expires_at, version)
             VALUES (?, ?, 1, ?, ?, 1)`,
          )
          .run(resourceKey, ownerId, now, now + ttlMs);
      }
      return this.requireLease(resourceKey);
    });
    return acquire();
  }

  heartbeatLease(
    resourceKey: string,
    ownerId: string,
    leaseEpoch: number,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE runtime_leases
         SET heartbeat_at = ?, expires_at = ?, version = version + 1
         WHERE resource_key = ? AND owner_id = ? AND lease_epoch = ? AND expires_at > ?`,
      )
      .run(now, now + ttlMs, resourceKey, ownerId, leaseEpoch, now);
    if (result.changes !== 1) throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 已失效`);
    return this.requireLease(resourceKey);
  }

  releaseLease(resourceKey: string, ownerId: string, leaseEpoch: number): void {
    const result = this.db
      .prepare(
        `UPDATE runtime_leases
         SET expires_at = ?, version = version + 1
         WHERE resource_key = ? AND owner_id = ? AND lease_epoch = ?`,
      )
      .run(this.now(), resourceKey, ownerId, leaseEpoch);
    if (result.changes !== 1)
      throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化`);
  }

  createJob(input: CreateJobInput): JobRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO jobs (
           job_id, type, status, execution_class, completion_policy, description,
           owner_session_id, child_session_id, tool_use_id, output_path, data_json,
           version, lease_epoch, attempt_count, created_at, updated_at
         ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
      )
      .run(
        input.jobId,
        input.type,
        input.executionClass,
        input.completionPolicy,
        input.description,
        input.ownerSessionId ?? null,
        input.childSessionId ?? null,
        input.toolUseId ?? null,
        input.outputPath ?? null,
        stringifyJson(input.data),
        now,
        now,
      );
    return this.requireJob(input.jobId);
  }

  startJob(input: StartJobInput): { job: JobRecord; attempt: JobAttemptRecord } {
    const start = this.db.transaction(() => {
      const current = this.requireJob(input.jobId);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`任务 ${input.jobId} 当前为 ${current.status}，不能启动`);
      }
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(
          `任务 ${input.jobId} 版本已从 ${input.expectedVersion} 变化`,
        );
      }
      this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attemptNumber = current.attemptCount + 1;
      this.db
        .prepare(
          `INSERT INTO job_attempts (
             attempt_id, job_id, attempt_number, status, owner_id, lease_epoch,
             output_path, output_offset, started_at, updated_at, version
           ) VALUES (?, ?, ?, 'running', ?, ?, ?, 0, ?, ?, 1)`,
        )
        .run(
          input.attemptId,
          input.jobId,
          attemptNumber,
          input.ownerId,
          input.leaseEpoch,
          input.outputPath ?? current.outputPath ?? null,
          now,
          now,
        );
      const changed = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running', output_path = COALESCE(?, output_path),
               lease_epoch = ?, attempt_count = ?, updated_at = ?, version = version + 1
           WHERE job_id = ? AND status = 'queued' AND version = ?`,
        )
        .run(
          input.outputPath ?? null,
          input.leaseEpoch,
          attemptNumber,
          now,
          input.jobId,
          input.expectedVersion,
        );
      if (changed.changes !== 1)
        throw new RuntimeConflictError(`任务 ${input.jobId} 启动 CAS 失败`);
      return { job: this.requireJob(input.jobId), attempt: this.requireAttempt(input.attemptId) };
    });
    return start();
  }

  finishJob(input: FinishJobInput): FinishJobResult {
    const finish = this.db.transaction(() => {
      const currentJob = this.requireJob(input.jobId);
      const currentAttempt = this.requireAttempt(input.attemptId);
      const existingCompletion = this.getCompletion(input.completionId);
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
          this.db
            .prepare("UPDATE completion_outbox SET delivered_at = ? WHERE completion_id = ?")
            .run(this.now(), input.completionId);
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
        currentAttempt.version !== input.expectedAttemptVersion ||
        currentJob.leaseEpoch !== input.leaseEpoch ||
        currentAttempt.leaseEpoch !== input.leaseEpoch
      ) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 的 version/leaseEpoch CAS 失败`);
      }
      this.assertLease(`job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attemptUpdate = this.db
        .prepare(
          `UPDATE job_attempts
           SET status = ?, output_offset = COALESCE(?, output_offset), error = ?,
               result_json = ?, finished_at = ?, updated_at = ?, version = version + 1
           WHERE attempt_id = ? AND status = 'running' AND version = ?
             AND owner_id = ? AND lease_epoch = ?`,
        )
        .run(
          input.status,
          input.outputOffset ?? null,
          input.error ?? null,
          stringifyJson(input.result),
          now,
          now,
          input.attemptId,
          input.expectedAttemptVersion,
          input.ownerId,
          input.leaseEpoch,
        );
      const jobUpdate = this.db
        .prepare(
          `UPDATE jobs
           SET status = ?, terminal_at = ?, updated_at = ?, error = ?, version = version + 1
           WHERE job_id = ? AND status = 'running' AND version = ? AND lease_epoch = ?`,
        )
        .run(
          input.status,
          now,
          now,
          input.error ?? null,
          input.jobId,
          input.expectedJobVersion,
          input.leaseEpoch,
        );
      if (attemptUpdate.changes !== 1 || jobUpdate.changes !== 1) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 终态 CAS 失败`);
      }
      this.insertCompletion({
        completionId: input.completionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        policy: currentJob.completionPolicy,
        status: input.status,
        payload: input.completionPayload,
        createdAt: now,
      });
      if (input.completionAlreadyDelivered) {
        this.db
          .prepare("UPDATE completion_outbox SET delivered_at = ? WHERE completion_id = ?")
          .run(now, input.completionId);
      }
      return {
        job: this.requireJob(input.jobId),
        attempt: this.requireAttempt(input.attemptId),
        completion: this.requireCompletion(input.completionId),
      };
    });
    return finish();
  }

  cancelQueuedJob(input: CancelQueuedJobInput): {
    job: JobRecord;
    completion: CompletionOutboxRecord;
  } {
    const cancel = this.db.transaction(() => {
      const current = this.requireJob(input.jobId);
      const existing = this.getCompletion(input.completionId);
      if (current.status === "cancelled" && existing?.jobId === input.jobId) {
        return { job: current, completion: existing };
      }
      if (current.status !== "queued" || current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(`任务 ${input.jobId} 已非可取消的 queued 版本`);
      }
      const now = this.now();
      const result = this.db
        .prepare(
          `UPDATE jobs SET status = 'cancelled', error = ?, terminal_at = ?, updated_at = ?,
             version = version + 1
           WHERE job_id = ? AND status = 'queued' AND version = ?`,
        )
        .run(input.reason ?? "cancelled", now, now, input.jobId, input.expectedVersion);
      if (result.changes !== 1) throw new RuntimeConflictError(`任务 ${input.jobId} 取消 CAS 失败`);
      this.insertCompletion({
        completionId: input.completionId,
        jobId: input.jobId,
        policy: current.completionPolicy,
        status: "cancelled",
        payload: input.reason ? { reason: input.reason } : undefined,
        createdAt: now,
      });
      return {
        job: this.requireJob(input.jobId),
        completion: this.requireCompletion(input.completionId),
      };
    });
    return cancel();
  }

  retryJob(jobId: string, expectedVersion: number): JobRecord {
    const current = this.requireJob(jobId);
    if (!isTerminalJobStatus(current.status) || current.version !== expectedVersion) {
      throw new RuntimeConflictError(`任务 ${jobId} 已非可重试的终态版本`);
    }
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'queued', terminal_at = NULL, error = NULL, updated_at = ?, version = version + 1
         WHERE job_id = ? AND version = ? AND status = ?`,
      )
      .run(now, jobId, expectedVersion, current.status);
    if (result.changes !== 1) throw new RuntimeConflictError(`任务 ${jobId} 重试 CAS 失败`);
    return this.requireJob(jobId);
  }

  interruptExpiredJobs(reason = "owner_lost"): JobRecord[] {
    const interrupt = this.db.transaction(() => {
      const now = this.now();
      const rows = this.db
        .prepare(
          `SELECT jobs.* FROM jobs
           LEFT JOIN runtime_leases ON runtime_leases.resource_key = 'job:' || jobs.job_id
           WHERE jobs.status = 'running'
             AND (runtime_leases.resource_key IS NULL OR runtime_leases.expires_at <= ?)`,
        )
        .all(now) as JobRow[];
      const interrupted: JobRecord[] = [];
      for (const row of rows) {
        const attempt = this.db
          .prepare(
            `SELECT * FROM job_attempts
             WHERE job_id = ? AND status = 'running'
             ORDER BY attempt_number DESC LIMIT 1`,
          )
          .get(row.job_id) as AttemptRow | undefined;
        if (!attempt) continue;
        this.db
          .prepare(
            `UPDATE job_attempts
             SET status = 'interrupted', error = ?, finished_at = ?, updated_at = ?,
                 version = version + 1
             WHERE attempt_id = ? AND status = 'running'`,
          )
          .run(reason, now, now, attempt.attempt_id);
        this.db
          .prepare(
            `UPDATE jobs
             SET status = 'interrupted', error = ?, terminal_at = ?, updated_at = ?,
                 version = version + 1
             WHERE job_id = ? AND status = 'running'`,
          )
          .run(reason, now, now, row.job_id);
        const job = this.requireJob(row.job_id);
        this.insertCompletion({
          completionId: `completion:${attempt.attempt_id}`,
          jobId: row.job_id,
          attemptId: attempt.attempt_id,
          policy: job.completionPolicy,
          status: "interrupted",
          payload: interruptedCompletionPayload(
            job,
            `completion:${attempt.attempt_id}`,
            reason,
            now,
          ),
          createdAt: now,
        });
        interrupted.push(job);
      }
      return interrupted;
    });
    return interrupt();
  }

  getJob(jobId: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      | JobRow
      | undefined;
    return row ? mapJob(row) : undefined;
  }

  getAttempt(attemptId: string): JobAttemptRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM job_attempts WHERE attempt_id = ?")
      .get(attemptId) as AttemptRow | undefined;
    return row ? mapAttempt(row) : undefined;
  }

  listAttempts(jobId: string): JobAttemptRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_number")
        .all(jobId) as AttemptRow[]
    ).map(mapAttempt);
  }

  listJobs(filter: JobListFilter = {}): JobRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (filter.statuses?.length) {
      conditions.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      values.push(...filter.statuses);
    }
    if (filter.ownerSessionId) {
      conditions.push("owner_session_id = ?");
      values.push(filter.ownerSessionId);
    }
    if (filter.completionPolicy) {
      conditions.push("completion_policy = ?");
      values.push(filter.completionPolicy);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 1_000, 10_000));
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at, job_id LIMIT ?`)
        .all(...values) as JobRow[]
    ).map(mapJob);
  }

  createCronJob(input: CreateCronJobInput): CronJobRecord {
    assertYoloPolicySnapshot(input.policySnapshot);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO cron_jobs (
           cron_job_id, workspace_path, schedule, time_zone, prompt, enabled,
           policy_snapshot_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.cronJobId,
        input.workspacePath,
        input.schedule,
        input.timeZone,
        input.prompt,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.policySnapshot),
        now,
        now,
      );
    this.insertRuntimeEvent({
      topic: "cron.job.created",
      workspacePath: input.workspacePath,
      cronJobId: input.cronJobId,
      payload: { enabled: input.enabled !== false, schedule: input.schedule, timeZone: input.timeZone },
    });
    return this.requireCronJob(input.cronJobId);
  }

  getCronJob(cronJobId: string): CronJobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cron_jobs WHERE cron_job_id = ?").get(cronJobId) as
      | CronJobRow
      | undefined;
    return row ? mapCronJob(row) : undefined;
  }

  listCronJobs(input: { workspacePath?: string; enabled?: boolean } = {}): CronJobRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.workspacePath !== undefined) {
      clauses.push("workspace_path = ?");
      params.push(input.workspacePath);
    }
    if (input.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(input.enabled ? 1 : 0);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db.prepare(`SELECT * FROM cron_jobs${where} ORDER BY created_at, cron_job_id`).all(...params) as CronJobRow[]
    ).map(mapCronJob);
  }

  setCronJobEnabled(cronJobId: string, expectedVersion: number, enabled: boolean): CronJobRecord {
    const current = this.requireCronJob(cronJobId);
    const result = this.db
      .prepare(
        `UPDATE cron_jobs SET enabled = ?, updated_at = ?, version = version + 1
         WHERE cron_job_id = ? AND version = ?`,
      )
      .run(enabled ? 1 : 0, this.now(), cronJobId, expectedVersion);
    if (result.changes !== 1) {
      throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
    }
    this.insertRuntimeEvent({
      topic: enabled ? "cron.job.enabled" : "cron.job.disabled",
      workspacePath: current.workspacePath,
      cronJobId,
    });
    return this.requireCronJob(cronJobId);
  }

  /** 删除前必须显式禁用；运行中的 Run 不能被级联抹除。 */
  deleteCronJob(cronJobId: string, expectedVersion: number): CronJobRecord {
    const remove = this.db.transaction(() => {
      const current = this.requireCronJob(cronJobId);
      if (current.enabled) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 必须先禁用才能删除`);
      }
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const running = this.db
        .prepare("SELECT cron_run_id FROM cron_runs WHERE cron_job_id = ? AND status = 'running' LIMIT 1")
        .get(cronJobId) as { cron_run_id: string } | undefined;
      if (running) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 仍有运行中的 Run ${running.cron_run_id}`);
      }
      const result = this.db
        .prepare("DELETE FROM cron_jobs WHERE cron_job_id = ? AND version = ? AND enabled = 0")
        .run(cronJobId, expectedVersion);
      if (result.changes !== 1) throw new RuntimeConflictError(`Cron Job ${cronJobId} 删除 CAS 失败`);
      // Job 行删除后不能保留 FK；以 payload 保存被删除的 ID 作为审计事实。
      this.insertRuntimeEvent({
        topic: "cron.job.deleted",
        workspacePath: current.workspacePath,
        payload: { cronJobId },
      });
      return current;
    });
    return remove();
  }

  /**
   * 对同一个 schedule minute 幂等；不会回填历史分钟。若工作区已有活跃 Run，
   * 当前触发写成 skipped，以保留完整审计而不是排队。
   */
  createCronRun(input: CreateCronRunInput): CronRunRecord {
    const create = this.db.transaction(() => {
      const job = this.requireCronJob(input.cronJobId);
      const existing = this.db
        .prepare("SELECT * FROM cron_runs WHERE cron_job_id = ? AND scheduled_for = ?")
        .get(input.cronJobId, input.scheduledFor) as CronRunRow | undefined;
      if (existing) return mapCronRun(existing);

      let status = input.status;
      let reason = input.reason;
      if (status === "queued") {
        const active = this.db
          .prepare(
            `SELECT cron_run_id FROM cron_runs
             WHERE workspace_path = ? AND status IN ('queued', 'running') LIMIT 1`,
          )
          .get(job.workspacePath) as { cron_run_id: string } | undefined;
        if (active) {
          status = "skipped";
          reason = "workspace_busy";
        }
      }
      const now = this.now();
      const terminalAt = status === "queued" ? null : now;
      this.db
        .prepare(
          `INSERT INTO cron_runs (
             cron_run_id, cron_job_id, workspace_path, scheduled_for, status, owner_id,
             lease_epoch, created_at, started_at, finished_at, reason, result_json, version
           ) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?, NULL, 1)`,
        )
        .run(
          input.cronRunId,
          input.cronJobId,
          job.workspacePath,
          input.scheduledFor,
          status,
          now,
          terminalAt,
          reason ?? null,
        );
        this.insertRuntimeEvent({
          topic: `cron.run.${status}`,
          workspacePath: job.workspacePath,
          cronJobId: job.cronJobId,
          cronRunId: input.cronRunId,
          payload: { scheduledFor: input.scheduledFor, ...(reason ? { reason } : {}) },
        });
        return this.requireCronRun(input.cronRunId);
    });
    return create();
  }

  getCronRun(cronRunId: string): CronRunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM cron_runs WHERE cron_run_id = ?").get(cronRunId) as
      | CronRunRow
      | undefined;
    return row ? mapCronRun(row) : undefined;
  }

  listCronRuns(input: { cronJobId?: string; workspacePath?: string; limit?: number } = {}): CronRunRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.cronJobId !== undefined) {
      clauses.push("cron_job_id = ?");
      params.push(input.cronJobId);
    }
    if (input.workspacePath !== undefined) {
      clauses.push("workspace_path = ?");
      params.push(input.workspacePath);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
    params.push(limit);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM cron_runs${where} ORDER BY scheduled_for DESC, cron_run_id DESC LIMIT ?`)
        .all(...params) as CronRunRow[]
    ).map(mapCronRun);
  }

  claimCronRun(input: ClaimCronRunInput): CronRunRecord {
    const claim = this.db.transaction(() => {
      const current = this.requireCronRun(input.cronRunId);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 当前为 ${current.status}，不能启动`);
      }
      this.assertLease(`cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const result = this.db
        .prepare(
          `UPDATE cron_runs SET status = 'running', owner_id = ?, lease_epoch = ?, started_at = ?, version = version + 1
           WHERE cron_run_id = ? AND status = 'queued' AND version = ?`,
        )
        .run(input.ownerId, input.leaseEpoch, now, input.cronRunId, current.version);
      if (result.changes !== 1) throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 启动 CAS 失败`);
      this.insertRuntimeEvent({
        topic: "cron.run.running",
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: current.cronRunId,
      });
      return this.requireCronRun(input.cronRunId);
    });
    return claim();
  }

  finishCronRun(input: FinishCronRunInput): CronRunRecord {
    const finish = this.db.transaction(() => {
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
      const result = this.db
        .prepare(
          `UPDATE cron_runs SET status = ?, finished_at = ?, reason = ?, result_json = ?, version = version + 1
           WHERE cron_run_id = ? AND status = 'running' AND version = ? AND owner_id = ? AND lease_epoch = ?`,
        )
        .run(
          input.status,
          now,
          input.reason ?? null,
          stringifyJson(input.result),
          input.cronRunId,
          input.expectedVersion,
          input.ownerId,
          input.leaseEpoch,
        );
      if (result.changes !== 1) throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 收口 CAS 失败`);
      this.insertRuntimeEvent({
        topic: `cron.run.${input.status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: current.cronRunId,
        payload: { ...(input.reason ? { reason: input.reason } : {}) },
      });
      return this.requireCronRun(input.cronRunId);
    });
    return finish();
  }

  blockQueuedCronRun(cronRunId: string, reason: string): CronRunRecord {
    const block = this.db.transaction(() => {
      const current = this.requireCronRun(cronRunId);
      if (current.status === "blocked") return current;
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`Cron Run ${cronRunId} 已进入 ${current.status}，不能阻断`);
      }
      const now = this.now();
      const result = this.db
        .prepare(
          `UPDATE cron_runs SET status = 'blocked', reason = ?, finished_at = ?, version = version + 1
           WHERE cron_run_id = ? AND status = 'queued' AND version = ?`,
        )
        .run(reason, now, cronRunId, current.version);
      if (result.changes !== 1) throw new RuntimeConflictError(`Cron Run ${cronRunId} 阻断 CAS 失败`);
      this.insertRuntimeEvent({
        topic: "cron.run.blocked",
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId,
        payload: { reason },
      });
      return this.requireCronRun(cronRunId);
    });
    return block();
  }

  /** 工作区正被前台或其他后台 Run 占用时，不排队，直接留下本次跳过的审计记录。 */
  skipQueuedCronRun(cronRunId: string, reason = "workspace_busy"): CronRunRecord {
    const skip = this.db.transaction(() => {
      const current = this.requireCronRun(cronRunId);
      if (current.status === "skipped") return current;
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`Cron Run ${cronRunId} 已进入 ${current.status}，不能跳过`);
      }
      const now = this.now();
      const result = this.db
        .prepare(
          `UPDATE cron_runs SET status = 'skipped', reason = ?, finished_at = ?, version = version + 1
           WHERE cron_run_id = ? AND status = 'queued' AND version = ?`,
        )
        .run(reason, now, cronRunId, current.version);
      if (result.changes !== 1) throw new RuntimeConflictError(`Cron Run ${cronRunId} 跳过 CAS 失败`);
      this.insertRuntimeEvent({
        topic: "cron.run.skipped",
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId,
        payload: { reason },
      });
      return this.requireCronRun(cronRunId);
    });
    return skip();
  }

  listRuntimeEvents(input: { afterEventId?: string; workspacePath?: string; limit?: number } = {}): RuntimeEventRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.afterEventId !== undefined) {
      const cursor = this.db
        .prepare("SELECT rowid AS row_id FROM runtime_events WHERE event_id = ?")
        .get(input.afterEventId) as { row_id: number } | undefined;
      // Event IDs are random, so their lexical order is not a valid replay cursor.
      // SQLite rowid preserves this ledger's append order within one database.
      if (!cursor) return [];
      clauses.push("rowid > ?");
      params.push(cursor.row_id);
    }
    if (input.workspacePath !== undefined) {
      clauses.push("workspace_path = ?");
      params.push(input.workspacePath);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
    params.push(limit);
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM runtime_events${where} ORDER BY rowid LIMIT ?`)
        .all(...params) as RuntimeEventRow[]
    ).map(mapRuntimeEvent);
  }

  insertCommand(input: {
    commandId: string;
    jobId: string;
    kind: JobCommandKind;
    payload?: Record<string, unknown>;
  }): { record: JobCommandRecord; inserted: boolean } {
    this.requireJob(input.jobId);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO job_commands
           (command_id, job_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.commandId, input.jobId, input.kind, stringifyJson(input.payload), this.now());
    const record = this.requireCommand(input.commandId);
    if (
      record.jobId !== input.jobId ||
      record.kind !== input.kind ||
      !sameJson(record.payload, input.payload)
    ) {
      throw new RuntimeConflictError(`命令 ID ${input.commandId} 已被其他命令使用`);
    }
    return { record, inserted: result.changes === 1 };
  }

  listPendingCommands(jobId: string): JobCommandRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM job_commands WHERE job_id = ? AND delivered_at IS NULL ORDER BY created_at, command_id",
        )
        .all(jobId) as CommandRow[]
    ).map(mapCommand);
  }

  markCommandDelivered(commandId: string): JobCommandRecord {
    this.db
      .prepare(
        "UPDATE job_commands SET delivered_at = COALESCE(delivered_at, ?) WHERE command_id = ?",
      )
      .run(this.now(), commandId);
    return this.requireCommand(commandId);
  }

  getCompletion(completionId: string): CompletionOutboxRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM completion_outbox WHERE completion_id = ?")
      .get(completionId) as CompletionRow | undefined;
    return row ? mapCompletion(row) : undefined;
  }

  listPendingCompletions(
    input: number | { limit?: number; ownerSessionId?: string } = 100,
  ): CompletionOutboxRecord[] {
    const options = typeof input === "number" ? { limit: input } : input;
    const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
    if (options.ownerSessionId) {
      return (
        this.db
          .prepare(
            `SELECT completion_outbox.* FROM completion_outbox
             INNER JOIN jobs ON jobs.job_id = completion_outbox.job_id
             WHERE completion_outbox.delivered_at IS NULL AND jobs.owner_session_id = ?
             ORDER BY completion_outbox.created_at, completion_outbox.completion_id LIMIT ?`,
          )
          .all(options.ownerSessionId, limit) as CompletionRow[]
      ).map(mapCompletion);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM completion_outbox
           WHERE delivered_at IS NULL ORDER BY created_at, completion_id LIMIT ?`,
        )
        .all(limit) as CompletionRow[]
    ).map(mapCompletion);
  }

  markCompletionDelivered(completionId: string): CompletionOutboxRecord {
    this.db
      .prepare(
        "UPDATE completion_outbox SET delivered_at = COALESCE(delivered_at, ?) WHERE completion_id = ?",
      )
      .run(this.now(), completionId);
    return this.requireCompletion(completionId);
  }

  createMergeRequest(
    input: Omit<MergeRequestRecord, "version" | "createdAt" | "updatedAt">,
  ): MergeRequestRecord {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO merge_requests (
           merge_request_id, job_id, attempt_id, source_branch, source_worktree,
           target_branch, target_worktree, source_head, status, error, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.mergeRequestId,
        input.jobId,
        input.attemptId ?? null,
        input.sourceBranch,
        input.sourceWorktree,
        input.targetBranch,
        input.targetWorktree,
        input.sourceHead ?? null,
        input.status,
        input.error ?? null,
        now,
        now,
      );
    return this.requireMerge(input.mergeRequestId);
  }

  updateMergeRequest(
    mergeRequestId: string,
    expectedVersion: number,
    status: MergeRequestStatus,
    error?: string,
  ): MergeRequestRecord {
    const result = this.db
      .prepare(
        `UPDATE merge_requests SET status = ?, error = ?, updated_at = ?, version = version + 1
         WHERE merge_request_id = ? AND version = ?`,
      )
      .run(status, error ?? null, this.now(), mergeRequestId, expectedVersion);
    if (result.changes !== 1) {
      throw new RuntimeConflictError(`合并请求 ${mergeRequestId} 的版本 CAS 失败`);
    }
    return this.requireMerge(mergeRequestId);
  }

  listMergeRequests(jobId?: string): MergeRequestRecord[] {
    const rows = jobId
      ? (this.db
          .prepare("SELECT * FROM merge_requests WHERE job_id = ? ORDER BY created_at")
          .all(jobId) as MergeRow[])
      : (this.db.prepare("SELECT * FROM merge_requests ORDER BY created_at").all() as MergeRow[]);
    return rows.map(mapMerge);
  }

  recordProviderCall(record: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number }): {
    record: ProviderCallRecord;
    inserted: boolean;
  } {
    if (record.jobId && record.attemptId) {
      const attempt = this.requireAttempt(record.attemptId);
      if (attempt.jobId !== record.jobId) {
        throw new RuntimeConflictError(
          `Provider call ${record.callId} 的 attempt ${record.attemptId} 不属于 job ${record.jobId}`,
        );
      }
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO provider_calls (
           call_id, session_id, conversation_id, goal_id, job_id, attempt_id,
           purpose, provider, model, route, status, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost, reported_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.callId,
        record.sessionId ?? null,
        record.conversationId ?? null,
        record.goalId ?? null,
        record.jobId ?? null,
        record.attemptId ?? null,
        record.purpose,
        record.provider,
        record.model,
        record.route ?? null,
        record.status,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.cost,
        stringifyJson(record.reported),
        record.createdAt ?? this.now(),
      );
    const stored = this.requireProviderCall(record.callId);
    if (!sameProviderCall(stored, record)) {
      throw new RuntimeConflictError(`Provider call ID ${record.callId} 已被其他调用使用`);
    }
    return { record: stored, inserted: result.changes === 1 };
  }

  putUsageBaseline(record: UsageBaselineRecord): {
    record: UsageBaselineRecord;
    inserted: boolean;
  } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_baselines (
           baseline_id, session_id, goal_id, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost, imported_at, source_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.baselineId,
        record.sessionId ?? null,
        record.goalId ?? null,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.cost,
        record.importedAt,
        stringifyJson(record.source),
      );
    return { record: this.requireBaseline(record.baselineId), inserted: result.changes === 1 };
  }

  listProviderCalls(filter: UsageLedgerFilter = {}): ProviderCallRecord[] {
    const { where, params } = usageWhere(filter, true);
    const rows = this.db
      .prepare(`SELECT * FROM provider_calls${where} ORDER BY created_at, call_id`)
      .all(...params) as ProviderCallRow[];
    return rows.map(mapProviderCall);
  }

  listUsageBaselines(filter: Omit<UsageLedgerFilter, "jobId"> = {}): UsageBaselineRecord[] {
    const { where, params } = usageWhere(filter, false);
    const rows = this.db
      .prepare(`SELECT * FROM usage_baselines${where} ORDER BY imported_at, baseline_id`)
      .all(...params) as BaselineRow[];
    return rows.map(mapBaseline);
  }

  /** baseline 与之后的逐调用事实只相加一次，避免再叠加 Session 聚合造成双计。 */
  getUsageSummary(filter: UsageLedgerFilter = {}): UsageLedgerSummary {
    const providerCalls = this.listProviderCalls(filter);
    // baseline 只属于 session/goal 历史，不能摊入某个 job。
    const baselines = filter.jobId ? [] : this.listUsageBaselines(filter);
    const providerTotals = sumUsage(providerCalls);
    const baselineTotals = sumUsage(baselines);
    return {
      providerCallCount: providerCalls.length,
      baselineCount: baselines.length,
      providerCalls: providerTotals,
      baselines: baselineTotals,
      total: addUsage(providerTotals, baselineTotals),
    };
  }

  async importLegacyTaskStore(filePath: string): Promise<LegacyTaskImportResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      assertLegacyTaskStore(parsed);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return { imported: 0, skipped: 0, interrupted: 0 };
      const quarantined = await quarantineCorruptJson(filePath, {
        reason: "legacy_task_store_invalid",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        imported: 0,
        skipped: 0,
        interrupted: 0,
        quarantinePath: quarantined.quarantinePath,
      };
    }

    const legacy = parsed as LegacyTaskStoreFile;
    let imported = 0;
    let skipped = 0;
    let interrupted = 0;
    const importAll = this.db.transaction(() => {
      for (const task of legacy.tasks) {
        const mapped = mapLegacyStatus(task.status);
        const current = this.getJob(task.taskId);
        if (current) {
          const decision = legacyReconciliationDecision(task, current);
          if (decision === "skip") {
            skipped++;
            continue;
          }
          this.reconcileLegacyTerminal(task, current, mapped.status);
          imported++;
          continue;
        }

        const fingerprint = legacyTaskFingerprint(task);
        const terminal = isTerminalJobStatus(mapped.status);
        const attemptNumber = terminal ? 1 : 0;
        const leaseEpoch = terminal ? 1 : 0;
        const terminalAt = terminal ? (task.endTime ?? this.now()) : undefined;
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO jobs (
               job_id, type, status, execution_class, completion_policy, description,
               tool_use_id, output_path, data_json, version, lease_epoch, attempt_count,
               created_at, updated_at, terminal_at, error
             ) VALUES (?, ?, ?, 'host_bound', 'optional', ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?)`,
          )
          .run(
            task.taskId,
            task.type,
            mapped.status,
            task.description,
            task.toolUseId ?? null,
            task.outputFile ?? null,
            stringifyJson({
              ...(task.data ?? {}),
              legacyTaskStore: { notified: task.notified, outputOffset: task.outputOffset },
              legacyTaskStoreImport: legacyImportMarker(task, fingerprint, 0, this.now()),
            }),
            task.startTime,
            terminalAt ?? task.startTime,
            terminalAt ?? null,
            mapped.error ?? task.error ?? null,
          );
        if (result.changes === 1) {
          if (isTerminalJobStatus(mapped.status)) {
            this.db
              .prepare(`UPDATE jobs SET lease_epoch = ?, attempt_count = ? WHERE job_id = ?`)
              .run(leaseEpoch, attemptNumber, task.taskId);
            this.insertLegacyTerminalAttempt(
              task,
              mapped.status,
              attemptNumber,
              leaseEpoch,
              fingerprint,
              terminalAt!,
            );
          }
          imported++;
          if (mapped.status === "interrupted") interrupted++;
        } else {
          skipped++;
        }
      }
    });
    importAll();
    return { imported, skipped, interrupted };
  }

  private reconcileLegacyTerminal(task: LegacyTask, current: JobRecord, status: JobStatus): void {
    if (!isTerminalJobStatus(status) || task.endTime === undefined) {
      throw new RuntimeConflictError(`legacy 任务 ${task.taskId} 缺少可安全前滚的终态证据`);
    }

    const now = this.now();
    const fingerprint = legacyTaskFingerprint(task);
    const error = mapLegacyStatus(task.status).error ?? task.error;
    let attemptNumber = current.attemptCount;
    let leaseEpoch = Math.max(current.leaseEpoch, 1);
    let attemptId: string;
    const runningAttempt =
      current.status === "running"
        ? (this.db
            .prepare(
              `SELECT * FROM job_attempts
               WHERE job_id = ? AND status = 'running'
               ORDER BY attempt_number DESC LIMIT 1`,
            )
            .get(task.taskId) as AttemptRow | undefined)
        : undefined;

    if (current.status === "running" && !runningAttempt) {
      throw new RuntimeConflictError(
        `runtime 任务 ${task.taskId} 缺少 running attempt，拒绝从 legacy 终态前滚`,
      );
    }

    if (runningAttempt) {
      attemptId = runningAttempt.attempt_id;
      leaseEpoch = runningAttempt.lease_epoch;
      const attemptUpdate = this.db
        .prepare(
          `UPDATE job_attempts
           SET status = ?, output_path = COALESCE(?, output_path), output_offset = ?,
               error = ?, result_json = ?, finished_at = ?, updated_at = ?, version = version + 1
           WHERE attempt_id = ? AND status = 'running' AND version = ?`,
        )
        .run(
          status,
          task.outputFile ?? null,
          task.outputOffset,
          error ?? null,
          stringifyJson(legacyTerminalResult(task, fingerprint)),
          task.endTime,
          now,
          runningAttempt.attempt_id,
          runningAttempt.version,
        );
      if (attemptUpdate.changes !== 1) {
        throw new RuntimeConflictError(
          `legacy 任务 ${task.taskId} 的 running attempt 前滚 CAS 失败`,
        );
      }
    } else {
      attemptNumber++;
      attemptId = this.insertLegacyTerminalAttempt(
        task,
        status,
        attemptNumber,
        leaseEpoch,
        fingerprint,
        task.endTime,
      );
    }

    const data = {
      ...(current.data ?? {}),
      ...(task.data ?? {}),
      legacyTaskStore: { notified: task.notified, outputOffset: task.outputOffset },
      legacyTaskStoreImport: legacyImportMarker(task, fingerprint, current.version, now),
    };
    const jobUpdate = this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, description = ?, tool_use_id = COALESCE(?, tool_use_id),
             output_path = COALESCE(?, output_path), data_json = ?, lease_epoch = ?,
             attempt_count = ?, terminal_at = ?, error = ?, updated_at = ?, version = version + 1
         WHERE job_id = ? AND status = ? AND version = ?`,
      )
      .run(
        status,
        task.description,
        task.toolUseId ?? null,
        task.outputFile ?? null,
        stringifyJson(data),
        leaseEpoch,
        attemptNumber,
        task.endTime,
        error ?? null,
        now,
        task.taskId,
        current.status,
        current.version,
      );
    if (jobUpdate.changes !== 1) {
      throw new RuntimeConflictError(`legacy 任务 ${task.taskId} 前滚 CAS 失败`);
    }
    this.insertLegacyCompletion(task, current, status, attemptId, fingerprint, now);
    this.db
      .prepare(
        `UPDATE runtime_leases
         SET expires_at = MIN(expires_at, ?), version = version + 1
         WHERE resource_key = ?`,
      )
      .run(now, `job:${task.taskId}`);
  }

  private insertLegacyTerminalAttempt(
    task: LegacyTask,
    status: TerminalJobStatus,
    attemptNumber: number,
    leaseEpoch: number,
    fingerprint: string,
    terminalAt: number,
  ): string {
    const error = mapLegacyStatus(task.status).error ?? task.error;
    const attemptId = `legacy:${task.taskId}:${attemptNumber}:${fingerprint.slice(0, 12)}`;
    this.db
      .prepare(
        `INSERT INTO job_attempts (
           attempt_id, job_id, attempt_number, status, owner_id, lease_epoch,
           output_path, output_offset, started_at, updated_at, finished_at,
           error, result_json, version
         ) VALUES (?, ?, ?, ?, 'legacy-task-store', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        attemptId,
        task.taskId,
        attemptNumber,
        status,
        leaseEpoch,
        task.outputFile ?? null,
        task.outputOffset,
        task.startTime,
        terminalAt,
        terminalAt,
        error ?? null,
        stringifyJson(legacyTerminalResult(task, fingerprint)),
      );
    return attemptId;
  }

  private insertLegacyCompletion(
    task: LegacyTask,
    current: JobRecord,
    status: TerminalJobStatus,
    attemptId: string,
    fingerprint: string,
    createdAt: number,
  ): void {
    if (
      !current.ownerSessionId ||
      (current.type !== "local_agent" && task.type !== "local_agent")
    ) {
      return;
    }
    const completionStatus = legacyDelegationStatus(task);
    if (current.completionPolicy === "detached" && completionStatus === "completed") return;

    const explicitCompletionId = nonEmptyString(task.data?.["completionId"]);
    const completionId =
      explicitCompletionId ?? `completion:legacy:${task.taskId}:${fingerprint.slice(0, 16)}`;
    const activityIds = Array.isArray(task.data?.["activityIds"])
      ? task.data["activityIds"].filter((value): value is string => typeof value === "string")
      : [];
    const error = mapLegacyStatus(task.status).error ?? task.error;
    this.insertCompletion({
      completionId,
      jobId: task.taskId,
      attemptId,
      policy: current.completionPolicy,
      status,
      payload: {
        legacyTaskStoreReconciliation: true,
        delegationCompletion: {
          completionId,
          jobId: task.taskId,
          ownerSessionId: current.ownerSessionId,
          completionSeq: safeInteger(task.data?.["completionSeq"]) ?? task.endTime ?? createdAt,
          activityIds,
          completionPolicy: current.completionPolicy,
          status: completionStatus,
          outputSummary:
            typeof task.data?.["outputSummary"] === "string"
              ? task.data["outputSummary"]
              : task.description,
          ...(error ? { error } : {}),
        },
      },
      createdAt,
    });
    const isSynchronousRequiredSuccess =
      current.completionPolicy === "required" && completionStatus === "completed";
    if (
      task.notified ||
      task.data?.["internalCompletion"] === true ||
      isSynchronousRequiredSuccess
    ) {
      this.db
        .prepare("UPDATE completion_outbox SET delivered_at = ? WHERE completion_id = ?")
        .run(createdAt, completionId);
    }
  }

  private migrate(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version INTEGER PRIMARY KEY,
           name TEXT NOT NULL,
           applied_at INTEGER NOT NULL
         )`,
      );
      const migrationRow = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get() as { version: number };
      const current = Number(migrationRow.version);
      if (current > RUNTIME_SCHEMA_VERSION) {
        throw new Error(
          `runtime.sqlite schema ${current} 新于当前支持版本 ${RUNTIME_SCHEMA_VERSION}`,
        );
      }
      if (current < 1) {
        this.db.exec(SCHEMA_V1);
        this.db
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
          .run("runtime_control_plane", this.now());
      }
      if (current < 2) {
        this.db.exec(SCHEMA_V2);
        this.db
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (2, ?, ?)")
          .run("merge_not_needed_status", this.now());
      }
      if (current < 3) {
        this.db.exec(SCHEMA_V3);
        this.db
          .prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (3, ?, ?)")
          .run("cron_job_run_ledger", this.now());
      }
    });
    migrate();
  }

  private assertLease(resourceKey: string, ownerId: string, leaseEpoch: number): void {
    const current = this.requireLease(resourceKey);
    if (
      current.ownerId !== ownerId ||
      current.leaseEpoch !== leaseEpoch ||
      current.expiresAt <= this.now()
    ) {
      throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化或过期`);
    }
  }

  private insertCompletion(record: CompletionOutboxRecord): void {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO completion_outbox (
           completion_id, job_id, attempt_id, policy, status, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.completionId,
        record.jobId,
        record.attemptId ?? null,
        record.policy,
        record.status,
        stringifyJson(record.payload),
        record.createdAt,
      );
    if (result.changes === 0) {
      const existing = this.requireCompletion(record.completionId);
      if (
        existing.jobId !== record.jobId ||
        existing.attemptId !== record.attemptId ||
        existing.status !== record.status ||
        !sameJson(existing.payload, record.payload)
      ) {
        throw new RuntimeConflictError(`Completion ID ${record.completionId} 已被其他终态使用`);
      }
    }
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.getJob(jobId);
    if (!job) throw new Error(`未知任务: ${jobId}`);
    return job;
  }

  private requireAttempt(attemptId: string): JobAttemptRecord {
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`未知 attempt: ${attemptId}`);
    return attempt;
  }

  private requireLease(resourceKey: string): RuntimeLeaseRecord {
    const row = this.db
      .prepare("SELECT * FROM runtime_leases WHERE resource_key = ?")
      .get(resourceKey) as LeaseRow | undefined;
    if (!row) throw new Error(`未知 runtime lease: ${resourceKey}`);
    return mapLease(row);
  }

  private requireCommand(commandId: string): JobCommandRecord {
    const row = this.db
      .prepare("SELECT * FROM job_commands WHERE command_id = ?")
      .get(commandId) as CommandRow | undefined;
    if (!row) throw new Error(`未知命令: ${commandId}`);
    return mapCommand(row);
  }

  private requireCompletion(completionId: string): CompletionOutboxRecord {
    const completion = this.getCompletion(completionId);
    if (!completion) throw new Error(`未知 completion: ${completionId}`);
    return completion;
  }

  private requireMerge(mergeRequestId: string): MergeRequestRecord {
    const row = this.db
      .prepare("SELECT * FROM merge_requests WHERE merge_request_id = ?")
      .get(mergeRequestId) as MergeRow | undefined;
    if (!row) throw new Error(`未知合并请求: ${mergeRequestId}`);
    return mapMerge(row);
  }

  private requireProviderCall(callId: string): ProviderCallRecord {
    const row = this.db.prepare("SELECT * FROM provider_calls WHERE call_id = ?").get(callId) as
      | ProviderCallRow
      | undefined;
    if (!row) throw new Error(`未知 provider call: ${callId}`);
    return mapProviderCall(row);
  }

  private requireBaseline(baselineId: string): UsageBaselineRecord {
    const row = this.db
      .prepare("SELECT * FROM usage_baselines WHERE baseline_id = ?")
      .get(baselineId) as BaselineRow | undefined;
    if (!row) throw new Error(`未知 usage baseline: ${baselineId}`);
    return mapBaseline(row);
  }

  private requireCronJob(cronJobId: string): CronJobRecord {
    const job = this.getCronJob(cronJobId);
    if (!job) throw new Error(`未知 Cron Job: ${cronJobId}`);
    return job;
  }

  private requireCronRun(cronRunId: string): CronRunRecord {
    const run = this.getCronRun(cronRunId);
    if (!run) throw new Error(`未知 Cron Run: ${cronRunId}`);
    return run;
  }

  private insertRuntimeEvent(input: Omit<RuntimeEventRecord, "eventId" | "createdAt"> & {
    eventId?: string;
    createdAt?: number;
  }): RuntimeEventRecord {
    const eventId = input.eventId ?? generateRuntimeId("event");
    const createdAt = input.createdAt ?? this.now();
    this.db
      .prepare(
        `INSERT INTO runtime_events (
           event_id, topic, workspace_path, cron_job_id, cron_run_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.topic,
        input.workspacePath,
        input.cronJobId ?? null,
        input.cronRunId ?? null,
        stringifyJson(input.payload),
        createdAt,
      );
    return {
      eventId,
      topic: input.topic,
      workspacePath: input.workspacePath,
      ...(input.cronJobId ? { cronJobId: input.cronJobId } : {}),
      ...(input.cronRunId ? { cronRunId: input.cronRunId } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      createdAt,
    };
  }
}

const SCHEMA_V1 = `
  CREATE TABLE runtime_leases (
    resource_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0)
  );

  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(JOB_STATUSES)})),
    execution_class TEXT NOT NULL CHECK (execution_class IN (${sqlValues(JOB_EXECUTION_CLASSES)})),
    completion_policy TEXT NOT NULL CHECK (completion_policy IN (${sqlValues(JOB_COMPLETION_POLICIES)})),
    description TEXT NOT NULL,
    owner_session_id TEXT,
    child_session_id TEXT,
    tool_use_id TEXT,
    output_path TEXT,
    data_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    terminal_at INTEGER,
    error TEXT
  );
  CREATE INDEX jobs_status_created_idx ON jobs(status, created_at);
  CREATE INDEX jobs_session_created_idx ON jobs(owner_session_id, created_at);

  CREATE TABLE job_attempts (
    attempt_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    status TEXT NOT NULL CHECK (status IN (${sqlValues(JOB_STATUSES)})),
    owner_id TEXT NOT NULL,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
    output_path TEXT,
    output_offset INTEGER NOT NULL CHECK (output_offset >= 0),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    result_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    UNIQUE(job_id, attempt_number)
  );
  CREATE INDEX job_attempts_job_idx ON job_attempts(job_id, attempt_number);

  CREATE TABLE job_commands (
    command_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('cancel', 'message')),
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX job_commands_pending_idx ON job_commands(job_id, delivered_at, created_at);

  CREATE TABLE completion_outbox (
    completion_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE CASCADE,
    policy TEXT NOT NULL CHECK (policy IN (${sqlValues(JOB_COMPLETION_POLICIES)})),
    status TEXT NOT NULL CHECK (status IN ('succeeded','partial','failed','timed_out','cancelled','interrupted')),
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE(attempt_id)
  );
  CREATE INDEX completion_outbox_pending_idx ON completion_outbox(delivered_at, created_at);

  CREATE TABLE merge_requests (
    merge_request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    source_branch TEXT NOT NULL,
    source_worktree TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    target_worktree TEXT NOT NULL,
    source_head TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(MERGE_REQUEST_STATUSES)})),
    error TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX merge_requests_job_idx ON merge_requests(job_id, created_at);

  CREATE TABLE provider_calls (
    call_id TEXT PRIMARY KEY,
    session_id TEXT,
    conversation_id TEXT,
    goal_id TEXT,
    job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    purpose TEXT NOT NULL CHECK (purpose IN (${sqlValues(PROVIDER_CALL_PURPOSES)})),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    route TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(PROVIDER_CALL_STATUSES)})),
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost REAL NOT NULL CHECK (cost >= 0),
    reported_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX provider_calls_session_idx ON provider_calls(session_id, created_at);
  CREATE INDEX provider_calls_goal_idx ON provider_calls(goal_id, created_at);
  CREATE INDEX provider_calls_job_idx ON provider_calls(job_id, created_at);

  CREATE TABLE usage_baselines (
    baseline_id TEXT PRIMARY KEY,
    session_id TEXT,
    goal_id TEXT,
    input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
    cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
    cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
    cost REAL NOT NULL CHECK (cost >= 0),
    imported_at INTEGER NOT NULL,
    source_json TEXT
  );
`;

const SCHEMA_V2 = `
  ALTER TABLE merge_requests RENAME TO merge_requests_v1;
  CREATE TABLE merge_requests (
    merge_request_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
    source_branch TEXT NOT NULL,
    source_worktree TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    target_worktree TEXT NOT NULL,
    source_head TEXT,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(MERGE_REQUEST_STATUSES)})),
    error TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO merge_requests (
    merge_request_id, job_id, attempt_id, source_branch, source_worktree,
    target_branch, target_worktree, source_head, status, error, version, created_at, updated_at
  )
  SELECT
    merge_request_id, job_id, attempt_id, source_branch, source_worktree,
    target_branch, target_worktree, source_head, status, error, version, created_at, updated_at
  FROM merge_requests_v1;
  DROP TABLE merge_requests_v1;
  CREATE INDEX merge_requests_job_idx ON merge_requests(job_id, created_at);
`;

const SCHEMA_V3 = `
  CREATE TABLE cron_jobs (
    cron_job_id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    schedule TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    policy_snapshot_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX cron_jobs_workspace_enabled_idx ON cron_jobs(workspace_path, enabled, created_at);

  CREATE TABLE cron_runs (
    cron_run_id TEXT PRIMARY KEY,
    cron_job_id TEXT NOT NULL REFERENCES cron_jobs(cron_job_id) ON DELETE CASCADE,
    workspace_path TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${sqlValues(CRON_RUN_STATUSES)})),
    owner_id TEXT,
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    reason TEXT,
    result_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    UNIQUE(cron_job_id, scheduled_for)
  );
  CREATE INDEX cron_runs_job_scheduled_idx ON cron_runs(cron_job_id, scheduled_for DESC);
  CREATE INDEX cron_runs_workspace_status_idx ON cron_runs(workspace_path, status, scheduled_for);

  CREATE TABLE runtime_events (
    event_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    cron_job_id TEXT REFERENCES cron_jobs(cron_job_id) ON DELETE SET NULL,
    cron_run_id TEXT REFERENCES cron_runs(cron_run_id) ON DELETE SET NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX runtime_events_workspace_cursor_idx ON runtime_events(workspace_path, created_at, event_id);
`;

function mapJob(row: JobRow): JobRecord {
  return compact({
    jobId: row.job_id,
    type: row.type,
    status: row.status as JobStatus,
    executionClass: row.execution_class as JobExecutionClass,
    completionPolicy: row.completion_policy as JobCompletionPolicy,
    description: row.description,
    ownerSessionId: nullToUndefined(row.owner_session_id),
    childSessionId: nullToUndefined(row.child_session_id),
    toolUseId: nullToUndefined(row.tool_use_id),
    outputPath: nullToUndefined(row.output_path),
    data: parseJsonRecord(row.data_json),
    version: row.version,
    leaseEpoch: row.lease_epoch,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: nullToUndefined(row.terminal_at),
    error: nullToUndefined(row.error),
  });
}

function mapAttempt(row: AttemptRow): JobAttemptRecord {
  return compact({
    attemptId: row.attempt_id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    status: row.status as JobStatus,
    ownerId: row.owner_id,
    leaseEpoch: row.lease_epoch,
    outputPath: nullToUndefined(row.output_path),
    outputOffset: row.output_offset,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: nullToUndefined(row.finished_at),
    error: nullToUndefined(row.error),
    result: parseJsonRecord(row.result_json),
    version: row.version,
  });
}

function mapLease(row: LeaseRow): RuntimeLeaseRecord {
  return {
    resourceKey: row.resource_key,
    ownerId: row.owner_id,
    leaseEpoch: row.lease_epoch,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    version: row.version,
  };
}

function mapCommand(row: CommandRow): JobCommandRecord {
  return compact({
    commandId: row.command_id,
    jobId: row.job_id,
    kind: row.kind as JobCommandKind,
    payload: parseJsonRecord(row.payload_json),
    createdAt: row.created_at,
    deliveredAt: nullToUndefined(row.delivered_at),
  });
}

function mapCompletion(row: CompletionRow): CompletionOutboxRecord {
  return compact({
    completionId: row.completion_id,
    jobId: row.job_id,
    attemptId: nullToUndefined(row.attempt_id),
    policy: row.policy as JobCompletionPolicy,
    status: row.status as TerminalJobStatus,
    payload: parseJsonRecord(row.payload_json),
    createdAt: row.created_at,
    deliveredAt: nullToUndefined(row.delivered_at),
  });
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

function mapMerge(row: MergeRow): MergeRequestRecord {
  return compact({
    mergeRequestId: row.merge_request_id,
    jobId: row.job_id,
    attemptId: nullToUndefined(row.attempt_id),
    sourceBranch: row.source_branch,
    sourceWorktree: row.source_worktree,
    targetBranch: row.target_branch,
    targetWorktree: row.target_worktree,
    sourceHead: nullToUndefined(row.source_head),
    status: row.status as MergeRequestStatus,
    error: nullToUndefined(row.error),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapProviderCall(row: ProviderCallRow): ProviderCallRecord {
  return compact({
    callId: row.call_id,
    sessionId: nullToUndefined(row.session_id),
    conversationId: nullToUndefined(row.conversation_id),
    goalId: nullToUndefined(row.goal_id),
    jobId: nullToUndefined(row.job_id),
    attemptId: nullToUndefined(row.attempt_id),
    purpose: row.purpose as ProviderCallRecord["purpose"],
    provider: row.provider,
    model: row.model,
    route: nullToUndefined(row.route),
    status: row.status as ProviderCallRecord["status"],
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cost: row.cost,
    reported: parseJsonRecord(row.reported_json),
    createdAt: row.created_at,
  });
}

function mapBaseline(row: BaselineRow): UsageBaselineRecord {
  return compact({
    baselineId: row.baseline_id,
    sessionId: nullToUndefined(row.session_id),
    goalId: nullToUndefined(row.goal_id),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cost: row.cost,
    importedAt: row.imported_at,
    source: parseJsonRecord(row.source_json),
  });
}

function mapCronJob(row: CronJobRow): CronJobRecord {
  return {
    cronJobId: row.cron_job_id,
    workspacePath: row.workspace_path,
    schedule: row.schedule,
    timeZone: row.time_zone,
    prompt: row.prompt,
    enabled: row.enabled === 1,
    policySnapshot: parseYoloPolicySnapshot(row.policy_snapshot_json),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCronRun(row: CronRunRow): CronRunRecord {
  return compact({
    cronRunId: row.cron_run_id,
    cronJobId: row.cron_job_id,
    workspacePath: row.workspace_path,
    scheduledFor: row.scheduled_for,
    status: row.status as CronRunStatus,
    ownerId: nullToUndefined(row.owner_id),
    leaseEpoch: row.lease_epoch,
    createdAt: row.created_at,
    startedAt: nullToUndefined(row.started_at),
    finishedAt: nullToUndefined(row.finished_at),
    reason: nullToUndefined(row.reason),
    result: parseJsonRecord(row.result_json),
    version: row.version,
  });
}

function mapRuntimeEvent(row: RuntimeEventRow): RuntimeEventRecord {
  return compact({
    eventId: row.event_id,
    topic: row.topic,
    workspacePath: row.workspace_path,
    cronJobId: nullToUndefined(row.cron_job_id),
    cronRunId: nullToUndefined(row.cron_run_id),
    payload: parseJsonRecord(row.payload_json),
    createdAt: row.created_at,
  });
}

function parseYoloPolicySnapshot(value: string): YoloPolicySnapshot {
  const parsed = JSON.parse(value) as unknown;
  assertYoloPolicySnapshot(parsed);
  return parsed;
}

function assertYoloPolicySnapshot(value: unknown): asserts value is YoloPolicySnapshot {
  if (!isRecord(value)) throw new Error("Cron Job 的 policySnapshot 必须是对象");
  if (
    value["mode"] !== "yolo" ||
    value["backgroundEnabled"] !== true ||
    value["trustedWorkspace"] !== true ||
    (value["networkPolicy"] !== "disabled" && value["networkPolicy"] !== "allowlist") ||
    !Array.isArray(value["allowedTools"]) ||
    !value["allowedTools"].every((tool) => typeof tool === "string") ||
    typeof value["hardlineVersion"] !== "string" ||
    typeof value["hookVersion"] !== "string" ||
    typeof value["createdAt"] !== "number"
  ) {
    throw new Error("Cron Job 仅支持可信工作区的 yolo background policySnapshot");
  }
  if (
    value["networkPolicy"] === "disabled" &&
    value["allowedNetworkHosts"] !== undefined
  ) {
    throw new Error("networkPolicy=disabled 时不得声明 allowedNetworkHosts");
  }
  if (
    value["networkPolicy"] === "allowlist" &&
    (!Array.isArray(value["allowedNetworkHosts"]) ||
      !value["allowedNetworkHosts"].every((host) => typeof host === "string"))
  ) {
    throw new Error("networkPolicy=allowlist 时必须提供 allowedNetworkHosts");
  }
}

function stringifyJson(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error("runtime.sqlite 中的 JSON 字段不是对象");
  return parsed;
}

function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function sqlValues(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
}

interface LegacyTaskStoreFile {
  version: 1;
  tasks: LegacyTask[];
}

interface LegacyTask {
  taskId: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "killed";
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  outputFile?: string;
  outputOffset: number;
  notified: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

type LegacyReconciliationDecision = "reconcile" | "skip";

function legacyReconciliationDecision(
  task: LegacyTask,
  current: JobRecord,
): LegacyReconciliationDecision {
  if (!isLegacyTerminalStatus(task.status) || isTerminalJobStatus(current.status)) return "skip";

  const fingerprint = legacyTaskFingerprint(task);
  const priorImport = recordValue(current.data?.["legacyTaskStoreImport"]);
  if (priorImport?.["fingerprint"] === fingerprint) return "skip";
  if (task.endTime === undefined) {
    throw new RuntimeConflictError(
      `legacy 任务 ${task.taskId} 的终态缺少 endTime，拒绝覆盖 runtime ${current.status}`,
    );
  }

  const legacyVersion = positiveInteger(task.data?.["runtimeVersion"]);
  const timeComparison = Math.sign(task.endTime - current.updatedAt);
  const versionComparison =
    legacyVersion === undefined ? undefined : Math.sign(legacyVersion - current.version);

  if (
    versionComparison !== undefined &&
    versionComparison !== 0 &&
    timeComparison !== 0 &&
    versionComparison !== timeComparison
  ) {
    throw new RuntimeConflictError(
      `legacy 任务 ${task.taskId} 的版本与时间证据冲突，拒绝覆盖 runtime`,
    );
  }
  if (versionComparison !== undefined && versionComparison < 0) return "skip";
  if (timeComparison < 0) return "skip";
  if (timeComparison === 0 && (versionComparison === undefined || versionComparison === 0)) {
    throw new RuntimeConflictError(`legacy 任务 ${task.taskId} 与 runtime 无法判定新旧，拒绝覆盖`);
  }
  return "reconcile";
}

function legacyTaskFingerprint(task: LegacyTask): string {
  return createHash("sha256").update(JSON.stringify(task)).digest("hex");
}

function legacyImportMarker(
  task: LegacyTask,
  fingerprint: string,
  runtimeVersionBefore: number,
  reconciledAt: number,
): Record<string, unknown> {
  return {
    version: 1,
    fingerprint,
    legacyStatus: task.status,
    ...(task.endTime !== undefined ? { legacyEndTime: task.endTime } : {}),
    runtimeVersionBefore,
    reconciledAt,
  };
}

function legacyTerminalResult(task: LegacyTask, fingerprint: string): Record<string, unknown> {
  return {
    legacyStatus: task.status,
    legacyTaskStoreFingerprint: fingerprint,
    ...(task.data ?? {}),
  };
}

function isLegacyTerminalStatus(
  status: LegacyTask["status"],
): status is Extract<LegacyTask["status"], "completed" | "failed" | "killed"> {
  return status === "completed" || status === "failed" || status === "killed";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function legacyDelegationStatus(
  task: LegacyTask,
): "completed" | "partial" | "error" | "timed_out" | "cancelled" {
  const aggregate = task.data?.["aggregateStatus"];
  if (
    aggregate === "completed" ||
    aggregate === "partial" ||
    aggregate === "error" ||
    aggregate === "timed_out" ||
    aggregate === "cancelled"
  ) {
    return aggregate;
  }
  if (task.status === "completed") return "completed";
  if (task.status === "killed") return "cancelled";
  return "error";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function assertLegacyTaskStore(value: unknown): asserts value is LegacyTaskStoreFile {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["tasks"])) {
    throw new Error("legacy TaskStore 根格式无效");
  }
  const seen = new Set<string>();
  for (const candidate of value["tasks"]) {
    if (!isLegacyTask(candidate)) throw new Error("legacy TaskStore 包含格式无效的任务");
    if (seen.has(candidate.taskId))
      throw new Error(`legacy TaskStore 包含重复任务 ${candidate.taskId}`);
    seen.add(candidate.taskId);
  }
}

function isLegacyTask(value: unknown): value is LegacyTask {
  if (!isRecord(value)) return false;
  return (
    typeof value["taskId"] === "string" &&
    typeof value["type"] === "string" &&
    ["pending", "running", "completed", "failed", "killed"].includes(String(value["status"])) &&
    typeof value["description"] === "string" &&
    typeof value["startTime"] === "number" &&
    Number.isFinite(value["startTime"]) &&
    typeof value["outputOffset"] === "number" &&
    Number.isSafeInteger(value["outputOffset"]) &&
    value["outputOffset"] >= 0 &&
    typeof value["notified"] === "boolean" &&
    (value["toolUseId"] === undefined || typeof value["toolUseId"] === "string") &&
    (value["endTime"] === undefined ||
      (typeof value["endTime"] === "number" && Number.isFinite(value["endTime"]))) &&
    (value["outputFile"] === undefined || typeof value["outputFile"] === "string") &&
    (value["error"] === undefined || typeof value["error"] === "string") &&
    (value["data"] === undefined || isRecord(value["data"]))
  );
}

function mapLegacyStatus(status: LegacyTask["status"]): { status: JobStatus; error?: string } {
  switch (status) {
    case "pending":
    case "running":
      return { status: "interrupted", error: "imported from legacy TaskStore after host restart" };
    case "completed":
      return { status: "succeeded" };
    case "failed":
      return { status: "failed" };
    case "killed":
      return { status: "cancelled" };
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
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

function usageWhere(
  filter: UsageLedgerFilter | Omit<UsageLedgerFilter, "jobId">,
  includeJob: boolean,
): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.sessionId !== undefined) {
    clauses.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.goalId !== undefined) {
    clauses.push("goal_id = ?");
    params.push(filter.goalId);
  }
  if (includeJob && "jobId" in filter && filter.jobId !== undefined) {
    clauses.push("job_id = ?");
    params.push(filter.jobId);
  }
  return { where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

function sumUsage(
  records: readonly (ProviderCallRecord | UsageBaselineRecord)[],
): UsageLedgerTotals {
  return records.reduce<UsageLedgerTotals>(
    (total, record) => ({
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      cacheReadTokens: total.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: total.cacheWriteTokens + record.cacheWriteTokens,
      cost: total.cost + record.cost,
    }),
    emptyUsage(),
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

export function generateRuntimeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
