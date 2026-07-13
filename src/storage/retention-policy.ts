export const STORAGE_RETENTION_POLICY_VERSION = 1 as const;

export interface SessionRetentionPolicy {
  readonly maxAgeDays?: number;
  readonly maxCount?: number;
  readonly preservePinned: boolean;
}

export interface TaskRetentionPolicy {
  readonly terminalMaxAgeDays: number;
  readonly maxTerminalRecords?: number;
}

export interface ArtifactRetentionPolicy {
  readonly ttlHours: number;
  readonly maxTotalBytes: number;
  readonly preservePinned: boolean;
}

export interface BlobRetentionPolicy {
  /** CAS 只有在无引用且超过该宽限期后才能被 sweep。 */
  readonly gracePeriodHours: number;
}

/**
 * 持久层的声明式保留策略。它不会启动 daemon/定时器，调用方必须
 * 显式执行相应的 cleanup/GC。
 */
export interface StorageRetentionPolicy {
  readonly schemaVersion: typeof STORAGE_RETENTION_POLICY_VERSION;
  readonly session: SessionRetentionPolicy;
  readonly task: TaskRetentionPolicy;
  readonly artifact: ArtifactRetentionPolicy;
  readonly blob: BlobRetentionPolicy;
}

export const DEFAULT_STORAGE_RETENTION_POLICY = {
  schemaVersion: STORAGE_RETENTION_POLICY_VERSION,
  session: { preservePinned: true },
  task: { terminalMaxAgeDays: 30 },
  artifact: {
    ttlHours: 168,
    maxTotalBytes: 200 * 1024 * 1024,
    preservePinned: true,
  },
  blob: { gracePeriodHours: 24 },
} satisfies StorageRetentionPolicy;

export function assertStorageRetentionPolicy(value: StorageRetentionPolicy): void {
  if (value.schemaVersion !== STORAGE_RETENTION_POLICY_VERSION) {
    throw new Error(`Unsupported retention policy version: ${String(value.schemaVersion)}`);
  }
  assertOptionalPositiveInteger(value.session.maxAgeDays, "session.maxAgeDays");
  assertOptionalPositiveInteger(value.session.maxCount, "session.maxCount");
  assertPositiveInteger(value.task.terminalMaxAgeDays, "task.terminalMaxAgeDays");
  assertOptionalPositiveInteger(value.task.maxTerminalRecords, "task.maxTerminalRecords");
  assertPositiveNumber(value.artifact.ttlHours, "artifact.ttlHours");
  assertPositiveInteger(value.artifact.maxTotalBytes, "artifact.maxTotalBytes");
  assertNonNegativeNumber(value.blob.gracePeriodHours, "blob.gracePeriodHours");
}

function assertOptionalPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined) assertPositiveInteger(value, label);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function assertPositiveNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function assertNonNegativeNumber(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
}
