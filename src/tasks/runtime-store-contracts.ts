import { randomUUID } from "node:crypto";
import type { CredentialRef } from "../provider/credential-vault.js";
import type {
  CompletionOutboxRecord,
  CronRunStatus,
  JobAttemptRecord,
  JobCompletionPolicy,
  JobExecutionClass,
  JobRecord,
  TerminalJobStatus,
  YoloPolicySnapshot,
} from "./runtime-types.js";

/**
 * Runtime 控制面的共享契约(票 09,JSONL 纪元退役)。
 *
 * 输入/输出接口与 RuntimeStoreOptions 在 JSONL 与 SQLite 两代 store 间保持同名
 * 同形;旧实现(src/tasks/runtime-store.ts)删除后,契约落位于此,
 * SqliteRuntimeControlStore 与 cron/job/daemon 消费方从这里导入,签名零漂移。
 */

export interface RuntimeStoreOptions {
  workDir: string;
  /** Canonical Pico workspace state root holding pico.sqlite. */
  storageRoot?: string;
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

export interface StartRecoverableJobSuccessorInput {
  jobId: string;
  sourceAttemptId: string;
  successorAttemptId: string;
  ownerId: string;
  leaseEpoch: number;
  expectedJobVersion: number;
  expectedSourceAttemptVersion: number;
  outputPath?: string;
  reason?: string;
}

export interface StartRecoverableJobSuccessorResult {
  inserted: boolean;
  job: JobRecord;
  sourceAttempt: JobAttemptRecord;
  successorAttempt: JobAttemptRecord;
}

export type RecoverableJobTerminalStatus = Extract<
  TerminalJobStatus,
  "succeeded" | "failed" | "cancelled"
>;

export interface SettleRecoverableJobAfterTaskTerminalInput {
  jobId: string;
  attemptId: string;
  ownerId: string;
  leaseEpoch: number;
  completionId: string;
  status: RecoverableJobTerminalStatus;
  outputOffset?: number;
  error?: string;
  result?: Record<string, unknown>;
  completionPayload?: Record<string, unknown>;
  completionAlreadyDelivered?: boolean;
}

export interface SettleRecoverableJobAfterTaskTerminalResult extends FinishJobResult {
  inserted: boolean;
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

export interface DaemonCommandState {
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

export function generateRuntimeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
