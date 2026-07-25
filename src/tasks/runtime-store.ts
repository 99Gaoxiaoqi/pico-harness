import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { parseAnyCredentialRef, type CredentialRef } from "../provider/credential-vault.js";
import { parseBackgroundYoloPolicySnapshot } from "../safety/background-yolo-policy-schema.js";
import {
  commitFileTransactionSync,
  mkdirPrivateSync,
  readJsonFileSync,
  readJsonLinesSync,
  recoverFileTransactionSync,
  withFileLockSync,
} from "../storage/local-file-storage.js";
import { LeaseConflictError } from "../storage/owner-lease.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import {
  DAEMON_RUN_STATUSES,
  type CompletionOutboxRecord,
  type CronJobRecord,
  type CronRunRecord,
  type CronRunStatus,
  type DaemonRunRecord,
  type JobAttemptRecord,
  type JobCommandKind,
  type JobCommandRecord,
  type JobCompletionPolicy,
  type JobExecutionClass,
  type JobListFilter,
  type JobRecord,
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

const DEFAULT_LEASE_TTL_MS = 30_000;
const STATE_SCHEMA_VERSION = 1 as const;
const LEDGER_SCHEMA_VERSION = 1 as const;
const DAEMON_RUN_RECOVERY_EVENT_PREFIX = "daemon-run-recovery:";
const STATE_FILE = "control/state.json";
const DAEMON_EVENTS_FILE = "control/daemon-events.jsonl";
const USAGE_LEDGER_FILE = "control/usage-ledger.jsonl";
const COMMIT_FILE = "commit.json";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const lockSleepArray = new Int32Array(new SharedArrayBuffer(4));

export class RuntimeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConflictError";
  }
}

export interface RuntimeStoreOptions {
  workDir: string;
  storageRoot?: string;
  /** @deprecated Use storageRoot. Treated as a local storage root, never as SQLite. */
  databasePath?: string;
  picoHome?: string;
  now?: () => number;
}

export interface DaemonIdempotentCommandResult<Result extends Record<string, unknown>> {
  result: Result;
  replayed: boolean;
  resourceId?: string;
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

export interface LegacyTaskMigrationResult {
  status: "absent" | "migrated" | "already_migrated";
  imported: number;
  skipped: number;
  interrupted: number;
  archivePath?: string;
}

export interface CreateCronJobInput {
  cronJobId: string;
  workspacePath: string;
  name?: string;
  schedule: string;
  timeZone: string;
  prompt: string;
  policySnapshot: YoloPolicySnapshot;
  credentialRef?: CredentialRef;
  modelRouteId?: string;
  enabled?: boolean;
}

export interface UpdateCronJobInput {
  cronJobId: string;
  expectedVersion: number;
  name?: string;
  schedule?: string;
  prompt?: string;
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

interface DaemonCommandState {
  commandType: string;
  idempotencyKey: string;
  requestHash: string;
  requestJson: string;
  status: "pending" | "completed";
  result?: Record<string, unknown>;
  resourceId?: string;
  createdAt: number;
  updatedAt: number;
}

interface RuntimeControlState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  revision: number;
  lastTransactionId?: string;
  nextRuntimeEventSequence: number;
  jobs: Record<string, JobRecord>;
  attempts: Record<string, JobAttemptRecord>;
  leases: Record<string, RuntimeLeaseRecord>;
  cronJobs: Record<string, CronJobRecord>;
  cronRuns: Record<string, CronRunRecord>;
  daemonCommands: Record<string, DaemonCommandState>;
  daemonRuns: Record<string, DaemonRunRecord>;
  jobCommands: Record<string, JobCommandRecord>;
  completions: Record<string, CompletionOutboxRecord>;
  mergeRequests: Record<string, MergeRequestRecord>;
}

interface RuntimeEventEnvelope {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  type: "runtime-event";
  txId: string;
  sequence: number;
  event: RuntimeEventRecord;
}

type UsageLedgerEnvelope =
  | {
      schemaVersion: typeof LEDGER_SCHEMA_VERSION;
      type: "provider-call";
      txId: string;
      record: ProviderCallRecord;
    }
  | {
      schemaVersion: typeof LEDGER_SCHEMA_VERSION;
      type: "usage-baseline";
      txId: string;
      record: UsageBaselineRecord;
    };

interface RuntimeTransaction {
  state: RuntimeControlState;
  events: Array<Omit<RuntimeEventEnvelope, "txId">>;
  usage: BufferedUsageLedgerEnvelope[];
}

type BufferedUsageLedgerEnvelope =
  | Omit<Extract<UsageLedgerEnvelope, { type: "provider-call" }>, "txId">
  | Omit<Extract<UsageLedgerEnvelope, { type: "usage-baseline" }>, "txId">;

const activeTransactions = new Map<string, RuntimeTransaction>();

/** Local JSON/JSONL control plane for recoverable tasks and daemon replay. */
export class RuntimeStore {
  readonly storageRoot: string;
  /** @deprecated Compatibility alias during the file-store cutover. */
  readonly databasePath: string;
  private readonly now: () => number;

  constructor(options: RuntimeStoreOptions) {
    this.storageRoot = resolve(
      options.storageRoot ??
        options.databasePath ??
        resolvePicoPaths(options.workDir, { picoHome: options.picoHome }).workspace.runtime,
    );
    this.databasePath = this.storageRoot;
    this.now = options.now ?? Date.now;
    mkdirPrivateSync(this.storageRoot);
    mkdirPrivateSync(join(this.storageRoot, "control"));
    this.write(() => undefined);
  }

  close(): void {}

  acquireLease(
    resourceKey: string,
    ownerId: string,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    if (ttlMs <= 0 || !Number.isFinite(ttlMs)) throw new Error("lease ttlMs 必须为正数");
    return this.write((tx) => {
      const now = this.now();
      const current = tx.state.leases[resourceKey];
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
      tx.state.leases[resourceKey] = next;
      return clone(next);
    });
  }

  heartbeatLease(
    resourceKey: string,
    ownerId: string,
    leaseEpoch: number,
    ttlMs = DEFAULT_LEASE_TTL_MS,
  ): RuntimeLeaseRecord {
    return this.write((tx) => {
      const current = tx.state.leases[resourceKey];
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
      tx.state.leases[resourceKey] = next;
      return clone(next);
    });
  }

  releaseLease(resourceKey: string, ownerId: string, leaseEpoch: number): void {
    this.write((tx) => {
      const current = tx.state.leases[resourceKey];
      if (!current || current.ownerId !== ownerId || current.leaseEpoch !== leaseEpoch) {
        throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化`);
      }
      tx.state.leases[resourceKey] = {
        ...current,
        expiresAt: this.now(),
        version: current.version + 1,
      };
    });
  }

  createJob(input: CreateJobInput): JobRecord {
    return this.write((tx) => {
      if (tx.state.jobs[input.jobId]) throw new RuntimeConflictError(`任务 ${input.jobId} 已存在`);
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
      tx.state.jobs[input.jobId] = job;
      return clone(job);
    });
  }

  startJob(input: StartJobInput): { job: JobRecord; attempt: JobAttemptRecord } {
    return this.write((tx) => {
      const current = this.requireJob(input.jobId, tx);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(`任务 ${input.jobId} 当前为 ${current.status}，不能启动`);
      }
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(
          `任务 ${input.jobId} 版本已从 ${input.expectedVersion} 变化`,
        );
      }
      if (tx.state.attempts[input.attemptId]) {
        throw new RuntimeConflictError(`attempt ${input.attemptId} 已存在`);
      }
      this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attemptNumber = current.attemptCount + 1;
      const attempt: JobAttemptRecord = compact({
        attemptId: input.attemptId,
        jobId: input.jobId,
        attemptNumber,
        status: "running" as const,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        outputPath: input.outputPath ?? current.outputPath,
        outputOffset: 0,
        startedAt: now,
        updatedAt: now,
        version: 1,
      });
      const job: JobRecord = compact({
        ...current,
        status: "running" as const,
        outputPath: input.outputPath ?? current.outputPath,
        leaseEpoch: input.leaseEpoch,
        attemptCount: attemptNumber,
        updatedAt: now,
        version: current.version + 1,
      });
      tx.state.attempts[input.attemptId] = attempt;
      tx.state.jobs[input.jobId] = job;
      return clone({ job, attempt });
    });
  }

  finishJob(input: FinishJobInput): FinishJobResult {
    return this.write((tx) => {
      const currentJob = this.requireJob(input.jobId, tx);
      const currentAttempt = this.requireAttempt(input.attemptId, tx);
      const existingCompletion = tx.state.completions[input.completionId];
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
          existingCompletion.deliveredAt = this.now();
        }
        return clone({
          job: currentJob,
          attempt: currentAttempt,
          completion: this.requireCompletion(input.completionId, tx),
        });
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
      this.assertLease(tx, `job:${input.jobId}`, input.ownerId, input.leaseEpoch);
      const now = this.now();
      const attempt = compact<JobAttemptRecord>({
        ...currentAttempt,
        status: input.status,
        outputOffset: input.outputOffset ?? currentAttempt.outputOffset,
        error: input.error,
        result: input.result,
        finishedAt: now,
        updatedAt: now,
        version: currentAttempt.version + 1,
      });
      const job = compact<JobRecord>({
        ...currentJob,
        status: input.status,
        terminalAt: now,
        updatedAt: now,
        error: input.error,
        version: currentJob.version + 1,
      });
      tx.state.attempts[input.attemptId] = attempt;
      tx.state.jobs[input.jobId] = job;
      this.insertCompletion(tx, {
        completionId: input.completionId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        policy: currentJob.completionPolicy,
        status: input.status,
        payload: input.completionPayload,
        createdAt: now,
      });
      if (input.completionAlreadyDelivered) {
        tx.state.completions[input.completionId]!.deliveredAt = now;
      }
      return clone({
        job,
        attempt,
        completion: this.requireCompletion(input.completionId, tx),
      });
    });
  }

  cancelQueuedJob(input: CancelQueuedJobInput): {
    job: JobRecord;
    completion: CompletionOutboxRecord;
  } {
    return this.write((tx) => {
      const current = this.requireJob(input.jobId, tx);
      const existing = tx.state.completions[input.completionId];
      if (current.status === "cancelled" && existing?.jobId === input.jobId) {
        return clone({ job: current, completion: existing });
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
      tx.state.jobs[input.jobId] = job;
      this.insertCompletion(
        tx,
        compact<CompletionOutboxRecord>({
          completionId: input.completionId,
          jobId: input.jobId,
          policy: current.completionPolicy,
          status: "cancelled" as const,
          payload: input.reason ? { reason: input.reason } : undefined,
          createdAt: now,
        }),
      );
      return clone({ job, completion: tx.state.completions[input.completionId]! });
    });
  }

  retryJob(jobId: string, expectedVersion: number): JobRecord {
    return this.write((tx) => {
      const current = this.requireJob(jobId, tx);
      if (!isTerminalJobStatus(current.status) || current.version !== expectedVersion) {
        throw new RuntimeConflictError(`任务 ${jobId} 已非可重试的终态版本`);
      }
      const job = withoutKeys(
        {
          ...current,
          status: "queued" as const,
          updatedAt: this.now(),
          version: current.version + 1,
        },
        "terminalAt",
        "error",
      );
      tx.state.jobs[jobId] = job;
      return clone(job);
    });
  }

  interruptExpiredJobs(reason = "owner_lost"): JobRecord[] {
    return this.write((tx) => {
      const now = this.now();
      const interrupted: JobRecord[] = [];
      for (const current of Object.values(tx.state.jobs)) {
        const lease = tx.state.leases[`job:${current.jobId}`];
        if (current.status !== "running" || (lease && lease.expiresAt > now)) continue;
        const attempt = Object.values(tx.state.attempts)
          .filter((value) => value.jobId === current.jobId && value.status === "running")
          .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
        if (!attempt) continue;
        const nextAttempt: JobAttemptRecord = {
          ...attempt,
          status: "interrupted",
          error: reason,
          finishedAt: now,
          updatedAt: now,
          version: attempt.version + 1,
        };
        const job: JobRecord = {
          ...current,
          status: "interrupted",
          error: reason,
          terminalAt: now,
          updatedAt: now,
          version: current.version + 1,
        };
        tx.state.attempts[attempt.attemptId] = nextAttempt;
        tx.state.jobs[current.jobId] = job;
        const completionId = `completion:${attempt.attemptId}`;
        this.insertCompletion(tx, {
          completionId,
          jobId: current.jobId,
          attemptId: attempt.attemptId,
          policy: job.completionPolicy,
          status: "interrupted",
          payload: interruptedCompletionPayload(job, completionId, reason, now),
          createdAt: now,
        });
        interrupted.push(clone(job));
      }
      return interrupted;
    });
  }

  getJob(jobId: string): JobRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.jobs[jobId]));
  }

  getAttempt(attemptId: string): JobAttemptRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.attempts[attemptId]));
  }

  listAttempts(jobId: string): JobAttemptRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.attempts)
          .filter((attempt) => attempt.jobId === jobId)
          .sort((left, right) => left.attemptNumber - right.attemptNumber),
      ),
    );
  }

  listJobs(filter: JobListFilter = {}): JobRecord[] {
    return this.read((tx) => {
      const limit = Math.max(1, Math.min(filter.limit ?? 1_000, 10_000));
      return clone(
        Object.values(tx.state.jobs)
          .filter(
            (job) =>
              (!filter.statuses?.length || filter.statuses.includes(job.status)) &&
              (filter.ownerSessionId === undefined ||
                job.ownerSessionId === filter.ownerSessionId) &&
              (filter.completionPolicy === undefined ||
                job.completionPolicy === filter.completionPolicy),
          )
          .sort(compareCreatedAndId("jobId"))
          .slice(0, limit),
      );
    });
  }

  createCronJob(input: CreateCronJobInput): CronJobRecord {
    return this.write((tx) => {
      if (tx.state.cronJobs[input.cronJobId]) {
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
      tx.state.cronJobs[input.cronJobId] = job;
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.created",
        workspacePath: input.workspacePath,
        cronJobId: input.cronJobId,
        payload: { enabled: job.enabled, schedule: input.schedule, timeZone: input.timeZone },
      });
      return clone(job);
    });
  }

  updateCronJob(input: UpdateCronJobInput): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(input.cronJobId, tx);
      if (current.version !== input.expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${input.cronJobId} 的版本已变化`);
      }
      const name = input.name === undefined ? current.name : normalizeCronJobName(input.name);
      const schedule = input.schedule ?? current.schedule;
      const prompt =
        input.prompt === undefined ? current.prompt : normalizeCronPrompt(input.prompt);
      const job = {
        ...current,
        name,
        schedule,
        prompt,
        updatedAt: this.now(),
        version: current.version + 1,
      };
      tx.state.cronJobs[input.cronJobId] = job;
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.updated",
        workspacePath: current.workspacePath,
        cronJobId: input.cronJobId,
        payload: { name, schedule },
      });
      return clone(job);
    });
  }

  getCronJob(cronJobId: string): CronJobRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.cronJobs[cronJobId]));
  }

  listCronJobs(input: { workspacePath?: string; enabled?: boolean } = {}): CronJobRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.cronJobs)
          .filter(
            (job) =>
              (input.workspacePath === undefined || job.workspacePath === input.workspacePath) &&
              (input.enabled === undefined || job.enabled === input.enabled),
          )
          .sort(compareCreatedAndId("cronJobId")),
      ),
    );
  }

  setCronJobEnabled(cronJobId: string, expectedVersion: number, enabled: boolean): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(cronJobId, tx);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const job = { ...current, enabled, updatedAt: this.now(), version: current.version + 1 };
      tx.state.cronJobs[cronJobId] = job;
      this.insertRuntimeEvent(tx, {
        topic: enabled ? "cron.job.enabled" : "cron.job.disabled",
        workspacePath: current.workspacePath,
        cronJobId,
      });
      return clone(job);
    });
  }

  deleteCronJob(cronJobId: string, expectedVersion: number): CronJobRecord {
    return this.write((tx) => {
      const current = this.requireCronJob(cronJobId, tx);
      if (current.enabled)
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 必须先禁用才能删除`);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`Cron Job ${cronJobId} 的版本已变化`);
      }
      const running = Object.values(tx.state.cronRuns).find(
        (run) => run.cronJobId === cronJobId && run.status === "running",
      );
      if (running) {
        throw new RuntimeConflictError(
          `Cron Job ${cronJobId} 仍有运行中的 Run ${running.cronRunId}`,
        );
      }
      delete tx.state.cronJobs[cronJobId];
      for (const [id, run] of Object.entries(tx.state.cronRuns)) {
        if (run.cronJobId === cronJobId) delete tx.state.cronRuns[id];
      }
      this.insertRuntimeEvent(tx, {
        topic: "cron.job.deleted",
        workspacePath: current.workspacePath,
        payload: { cronJobId },
      });
      return clone(current);
    });
  }

  createCronRun(input: CreateCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const job = this.requireCronJob(input.cronJobId, tx);
      const existing = Object.values(tx.state.cronRuns).find(
        (run) => run.cronJobId === input.cronJobId && run.scheduledFor === input.scheduledFor,
      );
      if (existing) return clone(existing);
      if (tx.state.cronRuns[input.cronRunId]) {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 已存在`);
      }
      let status = input.status;
      let reason = input.reason;
      if (
        status === "queued" &&
        Object.values(tx.state.cronRuns).some(
          (run) =>
            run.workspacePath === job.workspacePath &&
            (run.status === "queued" || run.status === "running"),
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
      tx.state.cronRuns[input.cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${status}`,
        workspacePath: job.workspacePath,
        cronJobId: job.cronJobId,
        cronRunId: input.cronRunId,
        payload: { scheduledFor: input.scheduledFor, ...(reason ? { reason } : {}) },
      });
      return clone(run);
    });
  }

  getCronRun(cronRunId: string): CronRunRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.cronRuns[cronRunId]));
  }

  listCronRuns(
    input: { cronJobId?: string; workspacePath?: string; limit?: number } = {},
  ): CronRunRecord[] {
    return this.read((tx) => {
      const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
      return clone(
        Object.values(tx.state.cronRuns)
          .filter(
            (run) =>
              (input.cronJobId === undefined || run.cronJobId === input.cronJobId) &&
              (input.workspacePath === undefined || run.workspacePath === input.workspacePath),
          )
          .sort(
            (left, right) =>
              right.scheduledFor - left.scheduledFor ||
              right.cronRunId.localeCompare(left.cronRunId),
          )
          .slice(0, limit),
      );
    });
  }

  listActiveCronRuns(workspacePath: string): CronRunRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.cronRuns)
          .filter(
            (run) =>
              run.workspacePath === workspacePath &&
              (run.status === "queued" || run.status === "running"),
          )
          .sort(
            (left, right) =>
              right.scheduledFor - left.scheduledFor ||
              right.cronRunId.localeCompare(left.cronRunId),
          ),
      ),
    );
  }

  recoverInterruptedCronRuns(reason = "daemon_interrupted_after_lease_expiry"): CronRunRecord[] {
    return this.write((tx) => {
      const now = this.now();
      const recovered: CronRunRecord[] = [];
      for (const current of Object.values(tx.state.cronRuns)) {
        const lease = tx.state.leases[`cron-run:${current.cronRunId}`];
        if (current.status !== "running" || (lease && lease.expiresAt > now)) continue;
        const run: CronRunRecord = {
          ...current,
          status: "failed",
          finishedAt: now,
          reason,
          version: current.version + 1,
        };
        tx.state.cronRuns[current.cronRunId] = run;
        if (lease && lease.expiresAt <= now) {
          tx.state.leases[lease.resourceKey] = {
            ...lease,
            expiresAt: now,
            version: lease.version + 1,
          };
        }
        this.insertRuntimeEvent(tx, {
          topic: "cron.run.failed",
          workspacePath: current.workspacePath,
          cronJobId: current.cronJobId,
          cronRunId: current.cronRunId,
          payload: { reason, recovered: true },
        });
        recovered.push(clone(run));
      }
      return recovered;
    });
  }

  claimCronRun(input: ClaimCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(input.cronRunId, tx);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(
          `Cron Run ${input.cronRunId} 当前为 ${current.status}，不能启动`,
        );
      }
      this.assertLease(tx, `cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const run: CronRunRecord = {
        ...current,
        status: "running",
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        startedAt: this.now(),
        version: current.version + 1,
      };
      tx.state.cronRuns[input.cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: "cron.run.running",
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: current.cronRunId,
      });
      return clone(run);
    });
  }

  finishCronRun(input: FinishCronRunInput): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(input.cronRunId, tx);
      if (
        current.status !== "running" ||
        current.ownerId !== input.ownerId ||
        current.leaseEpoch !== input.leaseEpoch ||
        current.version !== input.expectedVersion
      ) {
        throw new RuntimeConflictError(`Cron Run ${input.cronRunId} 的 owner/version/lease 已变化`);
      }
      this.assertLease(tx, `cron-run:${input.cronRunId}`, input.ownerId, input.leaseEpoch);
      const run = compact<CronRunRecord>({
        ...current,
        status: input.status,
        finishedAt: this.now(),
        reason: input.reason,
        result: input.result,
        version: current.version + 1,
      });
      tx.state.cronRuns[input.cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${input.status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId: current.cronRunId,
        payload: input.reason ? { reason: input.reason } : {},
      });
      return clone(run);
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
    return this.read((tx) => {
      const events = this.runtimeEvents(tx);
      let start = 0;
      if (input.afterEventId !== undefined) {
        const index = events.findIndex(
          ({ event }) =>
            event.eventId === input.afterEventId &&
            (input.workspacePath === undefined || event.workspacePath === input.workspacePath),
        );
        if (index < 0) return [];
        start = index + 1;
      }
      let end = events.length;
      if (input.throughEventId !== undefined) {
        const index = events.findIndex(
          ({ event }) =>
            event.eventId === input.throughEventId &&
            (input.workspacePath === undefined || event.workspacePath === input.workspacePath),
        );
        if (index < 0) return [];
        end = index + 1;
      }
      const limit = Math.max(1, Math.min(input.limit ?? 100, 10_000));
      return clone(
        events
          .slice(start, end)
          .filter(
            ({ event }) =>
              input.workspacePath === undefined || event.workspacePath === input.workspacePath,
          )
          .slice(0, limit)
          .map(({ event }) => event),
      );
    });
  }

  hasRuntimeEvent(eventId: string, workspacePath?: string): boolean {
    return this.read((tx) =>
      this.runtimeEvents(tx).some(
        ({ event }) =>
          event.eventId === eventId &&
          (workspacePath === undefined || event.workspacePath === workspacePath),
      ),
    );
  }

  getRuntimeEventHighWatermark(workspacePath?: string): RuntimeEventRecord | undefined {
    return this.read((tx) => {
      const found = this.runtimeEvents(tx)
        .filter(({ event }) => workspacePath === undefined || event.workspacePath === workspacePath)
        .at(-1)?.event;
      return optionalClone(found);
    });
  }

  listDaemonRunRecoveryEvents(workspacePath: string): RuntimeEventRecord[] {
    return this.read((tx) =>
      clone(
        this.runtimeEvents(tx)
          .map(({ event }) => event)
          .filter(
            (event) =>
              event.workspacePath === workspacePath &&
              event.eventId.startsWith(DAEMON_RUN_RECOVERY_EVENT_PREFIX),
          ),
      ),
    );
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
      if (projection) this.persistDaemonRun(tx, projection.daemonRun);
      return clone(this.insertRuntimeEvent(tx, input));
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
    return this.write((tx) => {
      const key = daemonCommandKey(commandType, idempotencyKey);
      const existing = tx.state.daemonCommands[key];
      if (existing) {
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
          result: clone(existing.result) as Result,
          replayed: true,
          resourceId: existing.resourceId,
        });
      }
      const now = this.now();
      tx.state.daemonCommands[key] = {
        commandType,
        idempotencyKey,
        requestHash,
        requestJson,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
      const executed = execute();
      tx.state.daemonCommands[key] = compact({
        ...tx.state.daemonCommands[key]!,
        status: "completed" as const,
        result: clone(executed.result),
        resourceId: executed.resourceId,
        updatedAt: this.now(),
      });
      return compact({ result: executed.result, replayed: false, resourceId: executed.resourceId });
    });
  }

  upsertDaemonRun(input: DaemonRunRecord): DaemonRunRecord {
    return this.write((tx) => clone(this.persistDaemonRun(tx, input)));
  }

  getDaemonRun(workspacePath: string, runId: string): DaemonRunRecord | undefined {
    return this.read((tx) => {
      const run = tx.state.daemonRuns[runId];
      return run?.workspacePath === workspacePath ? clone(run) : undefined;
    });
  }

  listDaemonRuns(input: { workspacePath: string; sessionId?: string }): DaemonRunRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.daemonRuns)
          .filter(
            (run) =>
              run.workspacePath === input.workspacePath &&
              (input.sessionId === undefined || run.sessionId === input.sessionId),
          )
          .sort(
            (left, right) =>
              left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
          ),
      ),
    );
  }

  recoverInterruptedDaemonRuns(
    workspacePath: string,
    reason = "daemon restarted before the Run reached a terminal state",
  ): DaemonRunRecord[] {
    return this.write((tx) => {
      const active = new Set(DAEMON_RUN_STATUSES.slice(0, 4));
      const now = this.now();
      const recovered: DaemonRunRecord[] = [];
      for (const current of Object.values(tx.state.daemonRuns)) {
        if (current.workspacePath !== workspacePath || !active.has(current.status)) continue;
        const run: DaemonRunRecord = {
          ...current,
          status: "failed",
          error: reason,
          updatedAt: now,
          finishedAt: now,
          version: current.version + 1,
        };
        tx.state.daemonRuns[run.runId] = run;
        recovered.push(clone(run));
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
    return this.write((tx) => {
      this.requireJob(input.jobId, tx);
      const existing = tx.state.jobCommands[input.commandId];
      if (existing) {
        if (
          existing.jobId !== input.jobId ||
          existing.kind !== input.kind ||
          !sameJson(existing.payload, input.payload)
        ) {
          throw new RuntimeConflictError(`命令 ID ${input.commandId} 已被其他命令使用`);
        }
        return { record: clone(existing), inserted: false };
      }
      const record: JobCommandRecord = compact({ ...input, createdAt: this.now() });
      tx.state.jobCommands[input.commandId] = record;
      return { record: clone(record), inserted: true };
    });
  }

  listPendingCommands(jobId: string): JobCommandRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.jobCommands)
          .filter((record) => record.jobId === jobId && record.deliveredAt === undefined)
          .sort(compareCreatedAndId("commandId")),
      ),
    );
  }

  markCommandDelivered(commandId: string): JobCommandRecord {
    return this.write((tx) => {
      const current = this.requireCommand(commandId, tx);
      if (current.deliveredAt === undefined) current.deliveredAt = this.now();
      return clone(current);
    });
  }

  getCompletion(completionId: string): CompletionOutboxRecord | undefined {
    return this.read((tx) => optionalClone(tx.state.completions[completionId]));
  }

  listPendingCompletions(
    input: number | { limit?: number; ownerSessionId?: string } = 100,
  ): CompletionOutboxRecord[] {
    const options = typeof input === "number" ? { limit: input } : input;
    return this.read((tx) => {
      const limit = Math.max(1, Math.min(options.limit ?? 100, 10_000));
      return clone(
        Object.values(tx.state.completions)
          .filter((record) => {
            if (record.deliveredAt !== undefined) return false;
            if (options.ownerSessionId === undefined) return true;
            return tx.state.jobs[record.jobId]?.ownerSessionId === options.ownerSessionId;
          })
          .sort(compareCreatedAndId("completionId"))
          .slice(0, limit),
      );
    });
  }

  markCompletionDelivered(completionId: string): CompletionOutboxRecord {
    return this.write((tx) => {
      const current = this.requireCompletion(completionId, tx);
      if (current.deliveredAt === undefined) current.deliveredAt = this.now();
      return clone(current);
    });
  }

  createMergeRequest(
    input: Omit<MergeRequestRecord, "version" | "createdAt" | "updatedAt">,
  ): MergeRequestRecord {
    return this.write((tx) => {
      if (tx.state.mergeRequests[input.mergeRequestId]) {
        throw new RuntimeConflictError(`合并请求 ${input.mergeRequestId} 已存在`);
      }
      const now = this.now();
      const record: MergeRequestRecord = compact({
        ...input,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      tx.state.mergeRequests[input.mergeRequestId] = record;
      return clone(record);
    });
  }

  updateMergeRequest(
    mergeRequestId: string,
    expectedVersion: number,
    status: MergeRequestStatus,
    error?: string,
  ): MergeRequestRecord {
    return this.write((tx) => {
      const current = this.requireMerge(mergeRequestId, tx);
      if (current.version !== expectedVersion) {
        throw new RuntimeConflictError(`合并请求 ${mergeRequestId} 的版本 CAS 失败`);
      }
      const record = compact<MergeRequestRecord>({
        ...current,
        status,
        error,
        updatedAt: this.now(),
        version: current.version + 1,
      });
      tx.state.mergeRequests[mergeRequestId] = record;
      return clone(record);
    });
  }

  listMergeRequests(jobId?: string): MergeRequestRecord[] {
    return this.read((tx) =>
      clone(
        Object.values(tx.state.mergeRequests)
          .filter((record) => jobId === undefined || record.jobId === jobId)
          .sort(compareCreatedAndId("mergeRequestId")),
      ),
    );
  }

  recordProviderCall(record: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number }): {
    record: ProviderCallRecord;
    inserted: boolean;
  } {
    return this.write((tx) => {
      if (record.jobId && record.attemptId) {
        const attempt = this.requireAttempt(record.attemptId, tx);
        if (attempt.jobId !== record.jobId) {
          throw new RuntimeConflictError(
            `Provider call ${record.callId} 的 attempt ${record.attemptId} 不属于 job ${record.jobId}`,
          );
        }
      }
      const existing = this.usageRecords(tx).providerCalls.get(record.callId);
      if (existing) {
        if (!sameProviderCall(existing, record)) {
          throw new RuntimeConflictError(`Provider call ID ${record.callId} 已被其他调用使用`);
        }
        return { record: clone(existing), inserted: false };
      }
      const stored: ProviderCallRecord = compact({
        ...record,
        createdAt: record.createdAt ?? this.now(),
      });
      tx.usage.push({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "provider-call",
        record: stored,
      });
      return { record: clone(stored), inserted: true };
    });
  }

  putUsageBaseline(record: UsageBaselineRecord): {
    record: UsageBaselineRecord;
    inserted: boolean;
  } {
    return this.write((tx) => {
      const existing = this.usageRecords(tx).baselines.get(record.baselineId);
      if (existing) return { record: clone(existing), inserted: false };
      tx.usage.push({
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "usage-baseline",
        record: clone(record),
      });
      return { record: clone(record), inserted: true };
    });
  }

  listProviderCalls(filter: UsageLedgerFilter = {}): ProviderCallRecord[] {
    return this.read((tx) =>
      clone(
        [...this.usageRecords(tx).providerCalls.values()]
          .filter((record) => matchesUsageFilter(record, filter))
          .sort(compareCreatedAndId("callId")),
      ),
    );
  }

  listUsageBaselines(filter: Omit<UsageLedgerFilter, "jobId"> = {}): UsageBaselineRecord[] {
    return this.read((tx) =>
      clone(
        [...this.usageRecords(tx).baselines.values()]
          .filter((record) => matchesUsageFilter(record, filter))
          .sort(
            (left, right) =>
              left.importedAt - right.importedAt || left.baselineId.localeCompare(right.baselineId),
          ),
      ),
    );
  }

  getUsageSummary(filter: UsageLedgerFilter = {}): UsageLedgerSummary {
    const providerCalls = this.listProviderCalls(filter);
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

  /** The JSON task ledger is deliberately not imported during the clean file-store cutover. */
  async migrateLegacyTaskStore(_filePath: string): Promise<LegacyTaskMigrationResult> {
    return { status: "absent", imported: 0, skipped: 0, interrupted: 0 };
  }

  private closeQueuedCronRun(
    cronRunId: string,
    status: "blocked" | "skipped",
    reason: string,
  ): CronRunRecord {
    return this.write((tx) => {
      const current = this.requireCronRun(cronRunId, tx);
      if (current.status === status) return clone(current);
      if (current.status !== "queued") {
        throw new RuntimeConflictError(
          `Cron Run ${cronRunId} 已进入 ${current.status}，不能${
            status === "blocked" ? "阻断" : "跳过"
          }`,
        );
      }
      const run: CronRunRecord = {
        ...current,
        status,
        reason,
        finishedAt: this.now(),
        version: current.version + 1,
      };
      tx.state.cronRuns[cronRunId] = run;
      this.insertRuntimeEvent(tx, {
        topic: `cron.run.${status}`,
        workspacePath: current.workspacePath,
        cronJobId: current.cronJobId,
        cronRunId,
        payload: { reason },
      });
      return clone(run);
    });
  }

  private assertLease(
    tx: RuntimeTransaction,
    resourceKey: string,
    ownerId: string,
    leaseEpoch: number,
  ): void {
    const current = tx.state.leases[resourceKey];
    if (
      !current ||
      current.ownerId !== ownerId ||
      current.leaseEpoch !== leaseEpoch ||
      current.expiresAt <= this.now()
    ) {
      throw new RuntimeConflictError(`资源 ${resourceKey} 的 lease 所有权已变化或过期`);
    }
  }

  private insertCompletion(tx: RuntimeTransaction, record: CompletionOutboxRecord): void {
    const existing = tx.state.completions[record.completionId];
    if (existing) {
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
    tx.state.completions[record.completionId] = clone(record);
  }

  private persistDaemonRun(tx: RuntimeTransaction, input: DaemonRunRecord): DaemonRunRecord {
    const existing = tx.state.daemonRuns[input.runId];
    if (existing && existing.workspacePath !== input.workspacePath) {
      throw new RuntimeConflictError(`Run ID ${input.runId} 已属于其他工作区`);
    }
    if (!existing || input.version >= existing.version) {
      tx.state.daemonRuns[input.runId] = clone(input);
    }
    return tx.state.daemonRuns[input.runId]!;
  }

  private insertRuntimeEvent(
    tx: RuntimeTransaction,
    input: Omit<RuntimeEventRecord, "eventId" | "createdAt"> & {
      eventId?: string;
      createdAt?: number;
    },
  ): RuntimeEventRecord {
    const eventId = input.eventId ?? generateRuntimeId("event");
    if (this.runtimeEvents(tx).some(({ event }) => event.eventId === eventId)) {
      throw new RuntimeConflictError(`Runtime event ID ${eventId} 已存在`);
    }
    const event: RuntimeEventRecord = compact({
      ...input,
      eventId,
      createdAt: input.createdAt ?? this.now(),
    });
    tx.events.push({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "runtime-event",
      sequence: tx.state.nextRuntimeEventSequence++,
      event,
    });
    return event;
  }

  private runtimeEvents(tx: RuntimeTransaction): Array<Omit<RuntimeEventEnvelope, "txId">> {
    const persisted = decodeRuntimeEvents(
      readJsonLinesSync(join(this.storageRoot, DAEMON_EVENTS_FILE), true),
    );
    const events = [...persisted, ...tx.events].sort(
      (left, right) => left.sequence - right.sequence,
    );
    if (
      events.length + 1 !== tx.state.nextRuntimeEventSequence ||
      new Set(events.map(({ event }) => event.eventId)).size !== events.length
    ) {
      throw new Error("daemon-events.jsonl 与 Runtime control state 不一致");
    }
    return events;
  }

  private usageRecords(tx: RuntimeTransaction): {
    providerCalls: Map<string, ProviderCallRecord>;
    baselines: Map<string, UsageBaselineRecord>;
  } {
    const records = [
      ...decodeUsageLedger(readJsonLinesSync(join(this.storageRoot, USAGE_LEDGER_FILE), true)),
      ...tx.usage,
    ];
    const providerCalls = new Map<string, ProviderCallRecord>();
    const baselines = new Map<string, UsageBaselineRecord>();
    for (const envelope of records) {
      if (envelope.type === "provider-call") {
        if (providerCalls.has(envelope.record.callId)) {
          throw new Error(`usage-ledger.jsonl 包含重复 callId: ${envelope.record.callId}`);
        }
        providerCalls.set(envelope.record.callId, envelope.record);
      } else {
        if (baselines.has(envelope.record.baselineId)) {
          throw new Error(`usage-ledger.jsonl 包含重复 baselineId: ${envelope.record.baselineId}`);
        }
        baselines.set(envelope.record.baselineId, envelope.record);
      }
    }
    return { providerCalls, baselines };
  }

  private requireJob(jobId: string, tx: RuntimeTransaction): JobRecord {
    const value = tx.state.jobs[jobId];
    if (!value) throw new Error(`未知任务: ${jobId}`);
    return value;
  }

  private requireAttempt(attemptId: string, tx: RuntimeTransaction): JobAttemptRecord {
    const value = tx.state.attempts[attemptId];
    if (!value) throw new Error(`未知 attempt: ${attemptId}`);
    return value;
  }

  private requireCommand(commandId: string, tx: RuntimeTransaction): JobCommandRecord {
    const value = tx.state.jobCommands[commandId];
    if (!value) throw new Error(`未知命令: ${commandId}`);
    return value;
  }

  private requireCompletion(completionId: string, tx: RuntimeTransaction): CompletionOutboxRecord {
    const value = tx.state.completions[completionId];
    if (!value) throw new Error(`未知 completion: ${completionId}`);
    return value;
  }

  private requireMerge(mergeRequestId: string, tx: RuntimeTransaction): MergeRequestRecord {
    const value = tx.state.mergeRequests[mergeRequestId];
    if (!value) throw new Error(`未知合并请求: ${mergeRequestId}`);
    return value;
  }

  private requireCronJob(cronJobId: string, tx: RuntimeTransaction): CronJobRecord {
    const value = tx.state.cronJobs[cronJobId];
    if (!value) throw new Error(`未知 Cron Job: ${cronJobId}`);
    return value;
  }

  private requireCronRun(cronRunId: string, tx: RuntimeTransaction): CronRunRecord {
    const value = tx.state.cronRuns[cronRunId];
    if (!value) throw new Error(`未知 Cron Run: ${cronRunId}`);
    return value;
  }

  private read<Result>(operation: (tx: RuntimeTransaction) => Result): Result {
    const active = activeTransactions.get(this.storageRoot);
    if (active) return operation(active);
    return this.withRuntimeLock(() => {
      recoverFileTransactionSync(this.storageRoot, { commitFileName: COMMIT_FILE });
      return operation({ state: this.loadState(), events: [], usage: [] });
    });
  }

  private write<Result>(operation: (tx: RuntimeTransaction) => Result): Result {
    const active = activeTransactions.get(this.storageRoot);
    if (active) {
      const savepoint = clone(active);
      try {
        return operation(active);
      } catch (error) {
        active.state = savepoint.state;
        active.events = savepoint.events;
        active.usage = savepoint.usage;
        throw error;
      }
    }
    return this.withRuntimeLock(() => {
      recoverFileTransactionSync(this.storageRoot, { commitFileName: COMMIT_FILE });
      const stateExists = existsSync(join(this.storageRoot, STATE_FILE));
      const tx: RuntimeTransaction = { state: this.loadState(), events: [], usage: [] };
      const initialState = clone(tx.state);
      activeTransactions.set(this.storageRoot, tx);
      try {
        const result = operation(tx);
        if (
          stateExists &&
          tx.events.length === 0 &&
          tx.usage.length === 0 &&
          isDeepStrictEqual(tx.state, initialState)
        ) {
          return result;
        }
        const transactionId = randomUUID();
        tx.state.revision += 1;
        tx.state.lastTransactionId = transactionId;
        const appends: Array<{ relativePath: string; content: string }> = [];
        if (tx.events.length) {
          appends.push({
            relativePath: DAEMON_EVENTS_FILE,
            content: tx.events
              .map((event) => JSON.stringify({ ...event, txId: transactionId }))
              .join("\n")
              .concat("\n"),
          });
        }
        if (tx.usage.length) {
          appends.push({
            relativePath: USAGE_LEDGER_FILE,
            content: tx.usage
              .map((record) => JSON.stringify({ ...record, txId: transactionId }))
              .join("\n")
              .concat("\n"),
          });
        }
        commitFileTransactionSync(
          this.storageRoot,
          {
            replacements: [
              { relativePath: STATE_FILE, content: `${JSON.stringify(tx.state, null, 2)}\n` },
            ],
            appends,
          },
          { commitFileName: COMMIT_FILE, transactionId },
        );
        return result;
      } finally {
        activeTransactions.delete(this.storageRoot);
      }
    });
  }

  private withRuntimeLock<Result>(operation: () => Result): Result {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        return withFileLockSync(
          join(this.storageRoot, "lock"),
          `runtime:${process.pid}`,
          operation,
          { timeoutMs: Math.max(0, deadline - Date.now()) },
        );
      } catch (error) {
        // rm of a just-released lock has a tiny interval where the directory exists but owner.json
        // does not. Waiting is safe; taking ownership would not be.
        if (!(error instanceof LeaseConflictError) || Date.now() >= deadline) throw error;
        Atomics.wait(lockSleepArray, 0, 0, LOCK_RETRY_MS);
      }
    }
  }

  private loadState(): RuntimeControlState {
    const path = join(this.storageRoot, STATE_FILE);
    if (!existsSync(path)) return emptyState();
    return decodeState(readJsonFileSync(path), path);
  }
}

function emptyState(): RuntimeControlState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    revision: 0,
    nextRuntimeEventSequence: 1,
    jobs: {},
    attempts: {},
    leases: {},
    cronJobs: {},
    cronRuns: {},
    daemonCommands: {},
    daemonRuns: {},
    jobCommands: {},
    completions: {},
    mergeRequests: {},
  };
}

function decodeState(value: unknown, path: string): RuntimeControlState {
  if (!isRecord(value) || value["schemaVersion"] !== STATE_SCHEMA_VERSION) {
    throw new Error(`Runtime control state schema 不受支持: ${path}`);
  }
  const requiredMaps = [
    "jobs",
    "attempts",
    "leases",
    "cronJobs",
    "cronRuns",
    "daemonCommands",
    "daemonRuns",
    "jobCommands",
    "completions",
    "mergeRequests",
  ] as const;
  if (
    !Number.isSafeInteger(value["revision"]) ||
    !Number.isSafeInteger(value["nextRuntimeEventSequence"]) ||
    requiredMaps.some((key) => !isRecord(value[key]))
  ) {
    throw new Error(`Runtime control state 已损坏: ${path}`);
  }
  return clone(value) as unknown as RuntimeControlState;
}

function decodeRuntimeEvents(values: unknown[]): Array<Omit<RuntimeEventEnvelope, "txId">> {
  let expectedSequence = 1;
  return values.map((value, index) => {
    if (
      !isRecord(value) ||
      value["schemaVersion"] !== LEDGER_SCHEMA_VERSION ||
      value["type"] !== "runtime-event" ||
      typeof value["txId"] !== "string" ||
      value["sequence"] !== expectedSequence ||
      !isRuntimeEventRecord(value["event"])
    ) {
      throw new Error(`daemon-events.jsonl 第 ${index + 1} 条记录已损坏`);
    }
    expectedSequence += 1;
    return {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "runtime-event",
      sequence: value["sequence"] as number,
      event: clone(value["event"]),
    };
  });
}

function decodeUsageLedger(values: unknown[]): BufferedUsageLedgerEnvelope[] {
  return values.map((value, index) => {
    if (
      !isRecord(value) ||
      value["schemaVersion"] !== LEDGER_SCHEMA_VERSION ||
      typeof value["txId"] !== "string"
    ) {
      throw new Error(`usage-ledger.jsonl 第 ${index + 1} 条记录已损坏`);
    }
    if (value["type"] === "provider-call" && isProviderCall(value["record"])) {
      return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "provider-call",
        record: clone(value["record"]),
      };
    }
    if (value["type"] === "usage-baseline" && isUsageBaseline(value["record"])) {
      return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "usage-baseline",
        record: clone(value["record"]),
      };
    }
    throw new Error(`usage-ledger.jsonl 第 ${index + 1} 条记录类型无效`);
  });
}

function isRuntimeEventRecord(value: unknown): value is RuntimeEventRecord {
  return (
    isRecord(value) &&
    typeof value["eventId"] === "string" &&
    typeof value["topic"] === "string" &&
    typeof value["workspacePath"] === "string" &&
    typeof value["createdAt"] === "number"
  );
}

function isProviderCall(value: unknown): value is ProviderCallRecord {
  return (
    isRecord(value) &&
    typeof value["callId"] === "string" &&
    typeof value["purpose"] === "string" &&
    typeof value["provider"] === "string" &&
    typeof value["model"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["createdAt"] === "number"
  );
}

function isUsageBaseline(value: unknown): value is UsageBaselineRecord {
  return (
    isRecord(value) &&
    typeof value["baselineId"] === "string" &&
    typeof value["importedAt"] === "number"
  );
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

function matchesUsageFilter(
  record: ProviderCallRecord | UsageBaselineRecord,
  filter: UsageLedgerFilter | Omit<UsageLedgerFilter, "jobId">,
): boolean {
  return (
    (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
    (filter.goalId === undefined || record.goalId === filter.goalId) &&
    (!("jobId" in filter) ||
      filter.jobId === undefined ||
      ("jobId" in record && record.jobId === filter.jobId))
  );
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

function compareCreatedAndId<
  Id extends string,
  RecordType extends { createdAt: number } & Record<Id, string>,
>(id: Id): (left: RecordType, right: RecordType) => number {
  return (left, right) => left.createdAt - right.createdAt || left[id].localeCompare(right[id]);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, current]) => current !== undefined),
  ) as T;
}

function withoutKeys<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  for (const key of keys) delete value[key];
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function optionalClone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function generateRuntimeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
