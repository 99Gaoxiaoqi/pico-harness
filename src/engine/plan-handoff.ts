import type { PlanProjection } from "../plan/contract.js";

/** Durable plan proposal returned by a completed planning run. */
export interface PlanHandoff {
  readonly kind: "plan_handoff";
  readonly sessionId: string;
  readonly runId: string;
  readonly planId: string;
  readonly revision: number;
  readonly expectedSessionSequence: number;
  readonly projection: PlanProjection;
}

/**
 * Run-scoped, neutral handoff latch shared by the submit tool, engine and Runtime.
 * A successful submit may mark exactly one handoff; only the engine consumes it.
 */
export class PlanHandoffController {
  private pending: PlanHandoff | undefined;
  private consumed: PlanHandoff | undefined;

  mark(handoff: PlanHandoff): void {
    if (this.pending || this.consumed) {
      throw new Error("This planning run already submitted a plan handoff");
    }
    this.pending = structuredClone(handoff);
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }

  consume(): PlanHandoff | undefined {
    if (!this.pending) return undefined;
    this.consumed = this.pending;
    this.pending = undefined;
    return structuredClone(this.consumed);
  }

  result(): PlanHandoff | undefined {
    return this.consumed ? structuredClone(this.consumed) : undefined;
  }

  refreshProjection(projection: PlanProjection): PlanHandoff | undefined {
    if (!this.consumed) return undefined;
    this.consumed = {
      ...this.consumed,
      expectedSessionSequence: projection.sessionSequence,
      projection: structuredClone(projection),
    };
    return structuredClone(this.consumed);
  }
}
