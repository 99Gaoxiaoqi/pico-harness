import { randomUUID } from "node:crypto";
import type {
  LLMProviderRequestOptions,
  ProviderAttemptLifecycleSnapshot,
  ProviderPhysicalAttempt,
  Usage,
} from "@pico/core";
import { logger } from "../logger.js";

type ActiveAttempt = {
  attemptId: string;
  attempt: number;
  startedAt: string;
  clock: number;
  revision: number;
  httpStatus?: number;
  timeToFirstTokenMs?: number;
  terminal?: ProviderPhysicalAttempt;
};

/** A dispatch admission is durable preparation, never proof the server received the request. */
export class PhysicalAttemptTracker {
  private ordinal = 0;
  private active: ActiveAttempt | undefined;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  admissionError: Error | undefined;

  constructor(
    private readonly provider: string,
    private readonly model: string,
    private readonly signal: AbortSignal,
    private readonly record?: (attempt: ProviderPhysicalAttempt) => void,
    private readonly lifecycle?: Pick<
      LLMProviderRequestOptions,
      "onProviderAttemptStart" | "onProviderAttemptUpdate"
    >,
  ) {}

  async dispatch(send: () => Promise<Response>): Promise<Response> {
    this.signal.throwIfAborted();
    const active: ActiveAttempt = {
      attemptId: `attempt_${randomUUID()}`,
      attempt: this.ordinal++,
      startedAt: new Date().toISOString(),
      clock: performance.now(),
      revision: 0,
    };
    // Admission errors must escape before fetch. No observer exception is mistaken for an
    // upstream failure after a response has already been accepted.
    try {
      await this.lifecycle?.onProviderAttemptStart?.(this.snapshot(active, "prepared"));
    } catch {
      this.admissionError = new Error("本地请求计量准备记录写入失败，未发送模型请求");
      this.admissionError.name = "ProviderAccountingAdmissionError";
      throw this.admissionError;
    }
    this.active = active;
    try {
      this.signal.throwIfAborted();
      const response = await send();
      active.httpStatus = response.status;
      if (!active.terminal) this.update(active, this.snapshot(active, "observed"));
      if (!response.ok) this.settle("failed", undefined, undefined, `HTTP ${response.status}`);
      return response;
    } catch (error) {
      this.settle(this.signal.aborted ? "cancelled" : "failed", undefined, undefined, "请求未完成");
      throw error;
    }
  }

  observeOutput(): void {
    if (this.active && !this.active.terminal && this.active.timeToFirstTokenMs === undefined)
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
    if (!active || this.closed) return;
    const previous = active.terminal;
    // Only a cancelled request can receive a later usage snapshot; never reopen its state
    // or replace stronger final evidence with an intermediate/empty counter.
    if (
      previous &&
      (previous.status !== "cancelled" ||
        !usage ||
        (previous.usageBasis === "reported" && usageBasis(usage) !== "reported") ||
        JSON.stringify(previous.usage) === JSON.stringify(usage))
    )
      return;
    const fact: ProviderPhysicalAttempt = {
      attemptId: active.attemptId,
      attempt: active.attempt,
      provider: this.provider,
      model: this.model,
      startedAt: active.startedAt,
      completedAt: previous?.completedAt ?? new Date().toISOString(),
      status:
        previous?.status ??
        (status === "failed" && active.timeToFirstTokenMs !== undefined ? "interrupted" : status),
      latencyMs: previous?.latencyMs ?? Math.max(0, Math.round(performance.now() - active.clock)),
      ...(active.httpStatus !== undefined ? { httpStatus: active.httpStatus } : {}),
      ...(active.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: active.timeToFirstTokenMs }
        : {}),
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason: finishReason.slice(0, 80) } : {}),
      ...(error ? { error } : {}),
      usageBasis: usageBasis(usage),
    };
    active.terminal = fact;
    // The Runtime event uses attemptId; the durable lifecycle has a
    // distinct identity contract and must never receive that extra field.
    const { attemptId, ...snapshot } = fact;
    this.update(active, {
      ...snapshot,
      physicalAttemptId: attemptId,
      revision: active.revision,
    });
    // Runtime events are append-only. Revisions belong only to the physical authority.
    if (!previous) {
      try {
        this.record?.(fact);
      } catch {
        /* observer owns diagnostics */
      }
    }
  }

  async flush(): Promise<void> {
    await this.writes;
  }
  close(): void {
    this.closed = true;
  }

  private snapshot(
    active: ActiveAttempt,
    status: "prepared" | "observed",
  ): ProviderAttemptLifecycleSnapshot {
    return {
      physicalAttemptId: active.attemptId,
      revision: active.revision,
      attempt: active.attempt,
      provider: this.provider,
      model: this.model,
      startedAt: active.startedAt,
      status,
      usageBasis: "missing",
      ...(active.httpStatus !== undefined ? { httpStatus: active.httpStatus } : {}),
    };
  }

  private update(active: ActiveAttempt, snapshot: ProviderAttemptLifecycleSnapshot): void {
    const fact = { ...snapshot, revision: ++active.revision };
    this.writes = this.writes.then(async () => {
      // Same revision on retry: storage can safely acknowledge a previously committed fact.
      for (let retry = 0; retry < 2; retry++) {
        try {
          await this.lifecycle?.onProviderAttemptUpdate?.(fact);
          return;
        } catch {
          if (retry === 1)
            logger.warn(
              { physicalAttemptId: fact.physicalAttemptId, revision: fact.revision },
              "物理请求计量写入失败；保留准备记录以恢复缺口",
            );
        }
      }
    });
  }
}

function usageBasis(usage?: Usage): ProviderPhysicalAttempt["usageBasis"] {
  const reported = usage?.reportedFields;
  return !usage
    ? "missing"
    : !reported || (reported.includes("prompt") && reported.includes("completion"))
      ? "reported"
      : reported.length > 0
        ? "partial"
        : "missing";
}
