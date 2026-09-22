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
  readonly meteredCalls: number;
  readonly unpricedCalls: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costCNY?: number;
  readonly latencyMs?: number;
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
    /** Current ledger counts logical calls, not physical provider attempts. */
    readonly modelAttempts: "logical_only";
  };
  readonly nextCursor?: string;
}
