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

export const PROVIDER_CALL_PURPOSES = ["main", "subagent", "compaction", "aux", "grace"] as const;
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

export function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}
