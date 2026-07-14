import type { BackgroundYoloPolicySnapshotData } from "../safety/background-yolo-policy-schema.js";

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "partial",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
] as const satisfies readonly JobStatus[];

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

export const JOB_EXECUTION_CLASSES = ["host_bound", "recoverable"] as const;
export type JobExecutionClass = (typeof JOB_EXECUTION_CLASSES)[number];

export const JOB_COMPLETION_POLICIES = ["required", "optional", "detached"] as const;
export type JobCompletionPolicy = (typeof JOB_COMPLETION_POLICIES)[number];

export const JOB_COMMAND_KINDS = ["cancel", "message"] as const;
export type JobCommandKind = (typeof JOB_COMMAND_KINDS)[number];

export const PROVIDER_CALL_PURPOSES = [
  "main",
  "subagent",
  "compaction",
  "aux",
  "grace",
  "hook",
] as const;
export type ProviderCallPurpose = (typeof PROVIDER_CALL_PURPOSES)[number];

export const PROVIDER_CALL_STATUSES = ["succeeded", "failed", "cancelled"] as const;
export type ProviderCallStatus = (typeof PROVIDER_CALL_STATUSES)[number];

export const MERGE_REQUEST_STATUSES = [
  "queued",
  "running",
  "merged",
  "not_needed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type MergeRequestStatus = (typeof MERGE_REQUEST_STATUSES)[number];

export interface RuntimeLeaseRecord {
  resourceKey: string;
  ownerId: string;
  leaseEpoch: number;
  heartbeatAt: number;
  expiresAt: number;
  version: number;
}

export interface JobRecord {
  jobId: string;
  type: string;
  status: JobStatus;
  executionClass: JobExecutionClass;
  completionPolicy: JobCompletionPolicy;
  description: string;
  ownerSessionId?: string;
  childSessionId?: string;
  toolUseId?: string;
  outputPath?: string;
  data?: Record<string, unknown>;
  version: number;
  leaseEpoch: number;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
  error?: string;
}

export interface JobAttemptRecord {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  status: JobStatus;
  ownerId: string;
  leaseEpoch: number;
  outputPath?: string;
  outputOffset: number;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
  version: number;
}

export interface JobCommandRecord {
  commandId: string;
  jobId: string;
  kind: JobCommandKind;
  payload?: Record<string, unknown>;
  createdAt: number;
  deliveredAt?: number;
}

export interface CompletionOutboxRecord {
  completionId: string;
  jobId: string;
  attemptId?: string;
  policy: JobCompletionPolicy;
  status: TerminalJobStatus;
  payload?: Record<string, unknown>;
  createdAt: number;
  deliveredAt?: number;
}

export interface MergeRequestRecord {
  mergeRequestId: string;
  jobId: string;
  attemptId?: string;
  sourceBranch: string;
  sourceWorktree: string;
  targetBranch: string;
  targetWorktree: string;
  sourceHead?: string;
  status: MergeRequestStatus;
  error?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderCallRecord {
  callId: string;
  sessionId?: string;
  conversationId?: string;
  goalId?: string;
  jobId?: string;
  attemptId?: string;
  purpose: ProviderCallPurpose;
  provider: string;
  model: string;
  route?: string;
  status: ProviderCallStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  reported?: Record<string, unknown>;
  createdAt: number;
}

export interface UsageBaselineRecord {
  baselineId: string;
  sessionId?: string;
  goalId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  importedAt: number;
  source?: Record<string, unknown>;
}

export interface UsageLedgerFilter {
  sessionId?: string;
  goalId?: string;
  jobId?: string;
}

export interface UsageLedgerTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface UsageLedgerSummary {
  providerCallCount: number;
  baselineCount: number;
  providerCalls: UsageLedgerTotals;
  baselines: UsageLedgerTotals;
  /** baseline + baseline 导入后逐调用明细；调用方无需再叠加 Session 累计值。 */
  total: UsageLedgerTotals;
}

export interface JobListFilter {
  statuses?: readonly JobStatus[];
  ownerSessionId?: string;
  completionPolicy?: JobCompletionPolicy;
  limit?: number;
}

export interface JobWithAttempts {
  job: JobRecord;
  attempts: JobAttemptRecord[];
}

/**
 * 后台 Job 在创建时冻结的安全边界。它是审计事实，不是可变的全局配置引用。
 * daemon 可在每次启动 Run 前额外用当前策略重新校验此快照。
 */
export type YoloPolicySnapshot = BackgroundYoloPolicySnapshotData;

export const CRON_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
  "skipped",
] as const;
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

export const TERMINAL_CRON_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
  "skipped",
] as const satisfies readonly CronRunStatus[];
export type TerminalCronRunStatus = (typeof TERMINAL_CRON_RUN_STATUSES)[number];

export interface CronJobRecord {
  cronJobId: string;
  workspacePath: string;
  schedule: string;
  timeZone: string;
  prompt: string;
  enabled: boolean;
  policySnapshot: YoloPolicySnapshot;
  /** 非秘密的系统凭证库引用；旧 Job 迁移后可能为空并由 daemon fail-closed。 */
  credentialRef?: CredentialRef;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface CronRunRecord {
  cronRunId: string;
  cronJobId: string;
  workspacePath: string;
  scheduledFor: number;
  status: CronRunStatus;
  ownerId?: string;
  leaseEpoch: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  reason?: string;
  result?: Record<string, unknown>;
  version: number;
}

export interface RuntimeEventRecord {
  eventId: string;
  topic: string;
  workspacePath: string;
  cronJobId?: string;
  cronRunId?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface CronRunWithJob {
  job: CronJobRecord;
  run: CronRunRecord;
}

export function isTerminalCronRunStatus(status: CronRunStatus): status is TerminalCronRunStatus {
  return (TERMINAL_CRON_RUN_STATUSES as readonly CronRunStatus[]).includes(status);
}

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}
import type { CredentialRef } from "../provider/credential-vault.js";
