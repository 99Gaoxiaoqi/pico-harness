import type { PlanProjection } from "../plan/contract.js";

export type PlanResponseAction = "execute" | "continue_editing" | "reject_exit";

export interface PlanControlResponse {
  readonly accepted: boolean;
  readonly projection: PlanProjection;
  readonly run?: Readonly<Record<string, unknown>>;
}

/**
 * Narrow trusted-host boundary for durable Plan review operations.
 * Implementations own CAS validation, event persistence and any follow-up Run.
 */
export interface PlanControlPort {
  respond(input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly planId: string;
    readonly action: PlanResponseAction;
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
    readonly operationId: string;
    readonly feedback?: string;
  }): PlanControlResponse | Promise<PlanControlResponse>;
}
