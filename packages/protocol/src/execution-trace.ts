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
  readonly costCNY?: number;
  readonly costStatus?: "estimated" | "included" | "unknown";
}

/** Read-only causal projection of the existing event ledger; never a second trace store. */
export interface RuntimeExecutionStep {
  readonly id: string;
  readonly eventId: string;
  readonly turnId: string;
  readonly kind: "model" | "tool" | "permission" | "compaction" | "error";
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
  readonly historicalBaselineCount?: number;
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
    readonly modelAttempts: "logical_only" | "physical" | "mixed";
  };
  readonly nextCursor?: string;
}
