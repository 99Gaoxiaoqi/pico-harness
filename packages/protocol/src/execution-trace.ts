import type { ForegroundProcessFacts, GoalEvidenceTrace, MemoryRecallTrace } from "@pico/core";

export interface RuntimeMemoryRecallDetail {
  readonly trace: MemoryRecallTrace;
  readonly items: readonly {
    readonly itemId: string;
    readonly state: "unchanged" | "changed" | "archived" | "deleted" | "unknown";
    readonly linkAvailable: boolean;
  }[];
  readonly sources: readonly {
    readonly eventId: string;
    readonly sessionId: string;
    readonly available: boolean;
  }[];
  readonly requests: readonly {
    readonly attemptId: string;
    readonly providerCallId: string;
    readonly evidenceLevel: "prepared" | "response_observed" | "assembly_unrecorded";
    readonly blockPresent?: boolean;
    readonly referenceCount: number;
    readonly referencePresentCount: number;
  }[];
}
export interface RuntimeGoalEvaluationDetail {
  readonly settlement?: "settled" | "unsettled";
  readonly goalId: string;
  readonly condition: string;
  readonly reason: string;
  readonly met?: boolean;
  readonly evaluatorFailed?: boolean;
  readonly evidenceTrace?: GoalEvidenceTrace;
}
export interface RuntimeCompactionDetail {
  readonly format: string;
  readonly taskAnchor: boolean;
  readonly evidenceStatus: "verified" | "unknown" | "unavailable";
  readonly evidenceIds: readonly string[];
}

export interface RuntimeExecutionAttempt {
  readonly attemptId: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: "prepared" | "observed" | "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly latencyMs?: number;
  readonly timeToFirstTokenMs?: number;
  readonly httpStatus?: number;
  readonly finishReason?: string;
  readonly usageBasis: "reported" | "partial" | "missing";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly error?: string;
  readonly errorClass?: string;
  readonly errorCategory?: string;
  readonly transportCode?: string;
  readonly retryable?: boolean;
  readonly diagnosticId?: string;
  readonly costCNY?: number;
  readonly costStatus?: "estimated" | "included" | "unknown";
  readonly costUnknownReason?: string;
}

/** Read-only causal projection of the existing event ledger; never a second trace store. */
export interface RuntimeExecutionStep {
  readonly id: string;
  readonly eventId: string;
  readonly turnId: string;
  readonly kind:
    | "model"
    | "tool"
    | "permission"
    | "compaction"
    | "error"
    | "memory"
    | "goal_evaluation";
  readonly memory?: RuntimeMemoryRecallDetail;
  readonly memoryRecallCoverage?: "recorded" | "unrecorded";
  readonly goalEvaluation?: RuntimeGoalEvaluationDetail;
  readonly compaction?: RuntimeCompactionDetail;
  readonly executionFacts?: ForegroundProcessFacts;
  readonly title: string;
  readonly at: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly durationMs?: number;
  readonly purpose?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly pricingKey?: string;
  readonly retries?: number;
  readonly firstTokenLatencyMs?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly permissionDecision?: "approved" | "rejected";
  readonly attempts?: readonly RuntimeExecutionAttempt[];
  readonly detail?: string;
  readonly input?: string;
  readonly output?: string;
  readonly error?: string;
  readonly truncated?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costCNY?: number;
  readonly costStatus?: "estimated" | "included" | "unknown";
  readonly costUnknownReason?: string;
}
export interface RuntimeExecutionRun {
  readonly runId: string;
  readonly invocationId: string;
  readonly at: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly durationMs?: number;
  readonly reason?: string;
  readonly parentRunId?: string;
  readonly steps: readonly RuntimeExecutionStep[];
}
export interface RuntimeExecutionSummary {
  readonly scope: "session";
  readonly modelCalls: number;
  readonly failedCalls: number;
  readonly meteredCalls: number;
  readonly unpricedCalls: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costCNY?: number;
  readonly latencyMs?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly toolCalls?: number;
  readonly toolDurationMs?: number;
  readonly physicalAttempts?: number;
  readonly retries?: number;
  readonly cacheCoverage?: "complete" | "partial" | "missing";
  readonly provenance?: {
    readonly source: "physical_attempts";
    /** Input/output coverage of settled attempts; cache and cost coverage remain separate. */
    readonly reportedAttempts: number;
    readonly partialAttempts: number;
    readonly missingAttempts: number;
    readonly pendingAttempts: number;
    readonly partialCoverageCalls: number;
    /** Calls with runtime facts but no matching physical request record; excluded from totals. */
    readonly runtimeOnlyCalls: number;
  };
}
export interface RuntimeExecutionPage {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly runs: readonly RuntimeExecutionRun[];
  readonly summary: RuntimeExecutionSummary;
  readonly coverage: {
    readonly oversizedRunIds: readonly string[];
    readonly missingModelCallRunIds: readonly string[];
    readonly incompleteRunIds: readonly string[];
    /** Historical and uninstrumented calls never imply physical coverage. */
    readonly modelAttempts: "missing" | "physical" | "partial";
  };
  readonly nextCursor?: string;
}
