import { randomUUID } from "node:crypto";
import type { ProviderPhysicalAttempt, Usage } from "@pico/core";

/** Scoped to one SDK invocation; each fetch (including policy downgrades) starts a fact. */
export class PhysicalAttemptTracker {
  private ordinal = 0;
  private active:
    | {
        attemptId: string;
        attempt: number;
        startedAt: string;
        clock: number;
        httpStatus?: number;
        timeToFirstTokenMs?: number;
      }
    | undefined;

  constructor(
    private readonly provider: string,
    private readonly model: string,
    private readonly signal: AbortSignal,
    private readonly record?: (attempt: ProviderPhysicalAttempt) => void,
  ) {}

  async dispatch(send: () => Promise<Response>): Promise<Response> {
    this.signal.throwIfAborted();
    this.active = {
      attemptId: `attempt_${randomUUID()}`,
      attempt: this.ordinal++,
      startedAt: new Date().toISOString(),
      clock: performance.now(),
    };
    try {
      const response = await send();
      this.active.httpStatus = response.status;
      if (!response.ok) this.settle("failed", undefined, undefined, `HTTP ${response.status}`);
      return response;
    } catch (error) {
      this.settle(this.signal.aborted ? "cancelled" : "failed", undefined, undefined, "请求未完成");
      throw error;
    }
  }

  observeOutput(): void {
    if (this.active && this.active.timeToFirstTokenMs === undefined)
      this.active.timeToFirstTokenMs = Math.max(
        0,
        Math.round(performance.now() - this.active.clock),
      );
  }

  settle(
    status: ProviderPhysicalAttempt["status"],
    usage?: Usage,
    finishReason?: string,
    error?: string,
  ): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const reported = usage?.reportedFields;
    const usageBasis = !usage
      ? "missing"
      : !reported || (reported.includes("prompt") && reported.includes("completion"))
        ? "reported"
        : reported.length > 0
          ? "partial"
          : "missing";
    // Telemetry must never turn an already accepted provider response into a retry.
    try {
      this.record?.({
        attemptId: active.attemptId,
        attempt: active.attempt,
        provider: this.provider,
        model: this.model,
        startedAt: active.startedAt,
        completedAt: new Date().toISOString(),
        status:
          status === "failed" && active.timeToFirstTokenMs !== undefined ? "interrupted" : status,
        latencyMs: Math.max(0, Math.round(performance.now() - active.clock)),
        ...(active.httpStatus !== undefined ? { httpStatus: active.httpStatus } : {}),
        ...(active.timeToFirstTokenMs !== undefined
          ? { timeToFirstTokenMs: active.timeToFirstTokenMs }
          : {}),
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason: finishReason.slice(0, 80) } : {}),
        ...(error ? { error } : {}),
        usageBasis,
      });
    } catch {
      // The observer owns any diagnostics. Never include raw responses or credentials.
    }
  }
}
