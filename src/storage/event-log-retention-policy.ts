const GIB = 1024 * 1024 * 1024;

export const DEFAULT_EVENT_LOG_RETENTION_POLICY = Object.freeze({
  hardLimitBytes: 2 * GIB,
  lowWatermarkBytes: Math.floor(1.5 * GIB),
});

export interface EventLogRetentionPolicy {
  readonly hardLimitBytes: number;
  readonly lowWatermarkBytes: number;
}

export interface EventLogRetentionCandidate {
  readonly sessionId: string;
  readonly logicalBytes: number;
  readonly archivedAt: number | null;
  readonly activityAt: string;
  readonly pinned: boolean;
  readonly hasActiveRun: boolean;
  readonly hasUnfinishedOperation: boolean;
}

export type EventLogClosureWriteIntent =
  | "tool_outcome_t2"
  | "approval_settlement"
  | "recovery"
  | "run_terminal"
  | "archive"
  | "delete";

export type EventLogWriteIntent = "new_work" | EventLogClosureWriteIntent;

export const EVENT_LOG_CLOSURE_WRITE_INTENTS = Object.freeze([
  "tool_outcome_t2",
  "approval_settlement",
  "recovery",
  "run_terminal",
  "archive",
  "delete",
] as const satisfies readonly EventLogClosureWriteIntent[]);

export interface EventLogRetentionPlanInput {
  readonly currentLogicalBytes: number;
  readonly currentSessionId: string | null;
  readonly sessions: readonly EventLogRetentionCandidate[];
  readonly policy?: EventLogRetentionPolicy;
}

export type EventLogRetentionStatus = "within_limit" | "retention_required" | "quota_blocked";

export interface EventLogRetentionPlan {
  readonly status: EventLogRetentionStatus;
  readonly sessionIdsToDelete: readonly string[];
  readonly estimatedLogicalBytesReclaimed: number;
  readonly projectedLogicalBytes: number;
  readonly canStartNewWork: boolean;
  readonly canWriteClosure: true;
}

/**
 * Builds a deterministic deletion plan without touching storage. A caller must
 * re-check the protected-state predicates in its deletion transaction before
 * applying the returned session ids.
 */
export function planEventLogRetention(input: EventLogRetentionPlanInput): EventLogRetentionPlan {
  const policy = input.policy ?? DEFAULT_EVENT_LOG_RETENTION_POLICY;
  validatePolicy(policy);
  requireNonNegativeSafeInteger(input.currentLogicalBytes, "currentLogicalBytes");
  if (input.currentSessionId !== null) requireNonBlank(input.currentSessionId, "currentSessionId");
  const seenSessionIds = new Set<string>();
  for (const session of input.sessions) {
    validateCandidate(session);
    if (seenSessionIds.has(session.sessionId)) {
      throw new TypeError(`Duplicate retention candidate sessionId: ${session.sessionId}`);
    }
    seenSessionIds.add(session.sessionId);
  }

  const canStartNewWork = input.currentLogicalBytes < policy.hardLimitBytes;
  if (canStartNewWork) {
    return {
      status: "within_limit",
      sessionIdsToDelete: [],
      estimatedLogicalBytesReclaimed: 0,
      projectedLogicalBytes: input.currentLogicalBytes,
      canStartNewWork: true,
      canWriteClosure: true,
    };
  }

  const candidates = input.sessions
    .filter(
      (session) =>
        session.archivedAt !== null &&
        !session.pinned &&
        !session.hasActiveRun &&
        !session.hasUnfinishedOperation &&
        session.sessionId !== input.currentSessionId,
    )
    .toSorted(compareRetentionCandidates);

  const sessionIdsToDelete: string[] = [];
  let estimatedLogicalBytesReclaimed = 0;
  let projectedLogicalBytes = input.currentLogicalBytes;
  for (const session of candidates) {
    if (projectedLogicalBytes <= policy.lowWatermarkBytes) break;
    sessionIdsToDelete.push(session.sessionId);
    estimatedLogicalBytesReclaimed = safeAdd(
      estimatedLogicalBytesReclaimed,
      session.logicalBytes,
      "estimatedLogicalBytesReclaimed",
    );
    projectedLogicalBytes = Math.max(0, input.currentLogicalBytes - estimatedLogicalBytesReclaimed);
  }

  return {
    status:
      projectedLogicalBytes <= policy.lowWatermarkBytes ? "retention_required" : "quota_blocked",
    sessionIdsToDelete,
    estimatedLogicalBytesReclaimed,
    projectedLogicalBytes,
    canStartNewWork: false,
    canWriteClosure: true,
  };
}

export function allowsEventLogWrite(
  currentLogicalBytes: number,
  intent: EventLogWriteIntent,
  policy: EventLogRetentionPolicy = DEFAULT_EVENT_LOG_RETENTION_POLICY,
): boolean {
  validatePolicy(policy);
  requireNonNegativeSafeInteger(currentLogicalBytes, "currentLogicalBytes");
  return intent !== "new_work" || currentLogicalBytes < policy.hardLimitBytes;
}

function compareRetentionCandidates(
  left: EventLogRetentionCandidate,
  right: EventLogRetentionCandidate,
): number {
  const archivedOrder = compareNumbers(left.archivedAt as number, right.archivedAt as number);
  if (archivedOrder !== 0) return archivedOrder;
  const activityOrder = compareStrings(left.activityAt, right.activityAt);
  if (activityOrder !== 0) return activityOrder;
  return compareStrings(left.sessionId, right.sessionId);
}

function compareNumbers(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validatePolicy(policy: EventLogRetentionPolicy): void {
  requirePositiveSafeInteger(policy.hardLimitBytes, "policy.hardLimitBytes");
  requirePositiveSafeInteger(policy.lowWatermarkBytes, "policy.lowWatermarkBytes");
  if (policy.lowWatermarkBytes >= policy.hardLimitBytes) {
    throw new RangeError("policy.lowWatermarkBytes must be lower than policy.hardLimitBytes");
  }
}

function validateCandidate(candidate: EventLogRetentionCandidate): void {
  requireNonBlank(candidate.sessionId, "session.sessionId");
  requireNonBlank(candidate.activityAt, `session[${candidate.sessionId}].activityAt`);
  requireNonNegativeSafeInteger(
    candidate.logicalBytes,
    `session[${candidate.sessionId}].logicalBytes`,
  );
  if (candidate.archivedAt !== null) {
    requireNonNegativeSafeInteger(
      candidate.archivedAt,
      `session[${candidate.sessionId}].archivedAt`,
    );
  }
}

function requireNonBlank(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} must be a non-empty string`);
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function requireNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function safeAdd(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new RangeError(`${field} exceeds safe integer range`);
  return sum;
}
