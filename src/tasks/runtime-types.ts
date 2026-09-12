import type { BackgroundAutonomousPolicySnapshotData } from "../safety/background-autonomous-policy-schema.js";

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
  "memory_review",
  "prewarm",
] as const;
export type ProviderCallPurpose = (typeof PROVIDER_CALL_PURPOSES)[number];

export const DAEMON_RUN_STATUSES = [
  "running",
  "pause_requested",
  "paused",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type DaemonRunStatus = (typeof DAEMON_RUN_STATUSES)[number];

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
export type AutonomousPolicySnapshot = BackgroundAutonomousPolicySnapshotData;

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
  /** Desktop-facing label. */
  name: string;
  schedule: string;
  timeZone: string;
  prompt: string;
  enabled: boolean;
  policySnapshot: AutonomousPolicySnapshot;
  /** 非秘密的系统凭证库引用。 */
  credentialRef: CredentialRef;
  /** 创建时固定的 providerID/modelID。 */
  modelRouteId: string;
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

interface RuntimeLedgerEventRecordBase {
  eventId: string;
  topic: string;
  workspacePath: string;
  createdAt: number;
}

export type RuntimeNotificationLedgerJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeNotificationLedgerJsonValue[]
  | { readonly [key: string]: RuntimeNotificationLedgerJsonValue };

/** Exact payload stored for rows that participate in the public Runtime notification replay. */
export interface RuntimeNotificationLedgerEnvelope extends Readonly<Record<string, unknown>> {
  readonly scope: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly runId?: string;
    readonly jobId?: string;
  };
  readonly resourceVersion: number;
  readonly payload: RuntimeNotificationLedgerJsonValue;
}

export interface RuntimeNotificationEventRecord extends RuntimeLedgerEventRecordBase {
  readonly ledgerKind: "runtime_notification";
  readonly cronJobId?: never;
  readonly cronRunId?: never;
  readonly payload: RuntimeNotificationLedgerEnvelope;
}

export const CRON_AUDIT_EVENT_TOPICS = [
  "cron.job.created",
  "cron.job.updated",
  "cron.job.enabled",
  "cron.job.disabled",
  "cron.job.deleted",
  "cron.run.queued",
  "cron.run.running",
  "cron.run.succeeded",
  "cron.run.failed",
  "cron.run.cancelled",
  "cron.run.blocked",
  "cron.run.skipped",
] as const;

export type CronAuditEventTopic = (typeof CRON_AUDIT_EVENT_TOPICS)[number];

export interface CronAuditEventRecord extends RuntimeLedgerEventRecordBase {
  readonly ledgerKind: "cron_audit";
  readonly topic: CronAuditEventTopic;
  readonly cronJobId: string;
  readonly cronRunId?: string;
  readonly payload?: Record<string, unknown>;
}

export type RuntimeEventRecord = RuntimeNotificationEventRecord | CronAuditEventRecord;

export function isCronAuditEventTopic(topic: string): topic is CronAuditEventTopic {
  return (CRON_AUDIT_EVENT_TOPICS as readonly string[]).includes(topic);
}

export function isCronAuditEventRecord(value: unknown): value is CronAuditEventRecord {
  if (
    !isRecord(value) ||
    value["ledgerKind"] !== "cron_audit" ||
    !isCronAuditEventTopic(String(value["topic"])) ||
    !nonEmptyString(value["eventId"]) ||
    !nonEmptyString(value["workspacePath"]) ||
    !nonEmptyString(value["cronJobId"]) ||
    !Number.isFinite(value["createdAt"])
  ) {
    return false;
  }
  const topic = value["topic"] as CronAuditEventTopic;
  const cronRunId = value["cronRunId"];
  if (topic.startsWith("cron.job.")) {
    if (cronRunId !== undefined) return false;
  } else if (!nonEmptyString(cronRunId)) {
    return false;
  }
  const payload = value["payload"];
  switch (topic) {
    case "cron.job.created":
      return (
        isRecord(payload) &&
        hasExactKeys(payload, ["enabled", "schedule", "timeZone"]) &&
        typeof payload["enabled"] === "boolean" &&
        nonEmptyString(payload["schedule"]) &&
        nonEmptyString(payload["timeZone"])
      );
    case "cron.job.updated":
      return (
        isRecord(payload) &&
        hasExactKeys(payload, ["name", "schedule"]) &&
        nonEmptyString(payload["name"]) &&
        nonEmptyString(payload["schedule"])
      );
    case "cron.job.enabled":
    case "cron.job.disabled":
    case "cron.run.running":
      return payload === undefined;
    case "cron.job.deleted":
      return (
        isRecord(payload) &&
        hasExactKeys(payload, ["cronJobId"]) &&
        payload["cronJobId"] === value["cronJobId"]
      );
    case "cron.run.queued":
      return isCronRunAuditPayload(payload, { scheduledFor: "required" });
    case "cron.run.succeeded":
    case "cron.run.cancelled":
      return isCronRunAuditPayload(payload, { scheduledFor: "forbidden" });
    case "cron.run.failed":
      return isCronRunAuditPayload(payload, {
        scheduledFor: "forbidden",
        recoveredAllowed: true,
      });
    case "cron.run.blocked":
    case "cron.run.skipped":
      return isCronRunAuditPayload(payload, { scheduledFor: "optional" });
  }
}

export function isRuntimeNotificationLedgerEnvelope(
  value: unknown,
  workspacePath: string,
): value is RuntimeNotificationLedgerEnvelope {
  if (!isRecord(value) || !hasExactKeys(value, ["scope", "resourceVersion", "payload"])) {
    return false;
  }
  const scope = value["scope"];
  if (
    !isRecord(scope) ||
    !hasOnlyKeys(scope, ["workspacePath", "sessionId", "runId", "jobId"]) ||
    typeof scope["workspacePath"] !== "string" ||
    scope["workspacePath"].trim().length === 0 ||
    scope["workspacePath"] !== workspacePath ||
    !nonEmptyOptionalString(scope, "sessionId") ||
    !nonEmptyOptionalString(scope, "runId") ||
    !nonEmptyOptionalString(scope, "jobId")
  ) {
    return false;
  }
  const resourceVersion = value["resourceVersion"];
  return (
    Number.isSafeInteger(resourceVersion) &&
    (resourceVersion as number) >= 0 &&
    isRuntimeNotificationLedgerJsonValue(value["payload"])
  );
}

/** Durable daemon projection used when the in-process workspace runtime is unavailable. */
export interface DaemonRunRecord {
  runId: string;
  workspacePath: string;
  sessionId?: string;
  checkpointId?: string;
  description: string;
  status: DaemonRunStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
  version: number;
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

function isRuntimeNotificationLedgerJsonValue(
  value: unknown,
): value is RuntimeNotificationLedgerJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isRuntimeNotificationLedgerJsonValue);
  return isRecord(value) && Object.values(value).every(isRuntimeNotificationLedgerJsonValue);
}

function isCronRunAuditPayload(
  value: unknown,
  options: {
    readonly scheduledFor: "required" | "optional" | "forbidden";
    readonly recoveredAllowed?: boolean;
  },
): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["scheduledFor", "reason", "recovered"])) {
    return false;
  }
  const scheduledFor = value["scheduledFor"];
  if (options.scheduledFor === "required" && !Number.isFinite(scheduledFor)) return false;
  if (options.scheduledFor === "forbidden" && scheduledFor !== undefined) return false;
  if (
    options.scheduledFor === "optional" &&
    scheduledFor !== undefined &&
    !Number.isFinite(scheduledFor)
  ) {
    return false;
  }
  if (!nonEmptyOptionalString(value, "reason")) return false;
  const recovered = value["recovered"];
  return recovered === undefined || (options.recoveredAllowed === true && recovered === true);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyOptionalString(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  return field === undefined || (typeof field === "string" && field.trim().length > 0);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import type { CredentialRef } from "../provider/credential-vault.js";
