import type { RuntimeEventBase } from "./runtime-event.js";

/**
 * Minimal stable event envelope consumed by Graph runtime projections.
 * The wider RuntimeEvent union may include feature-specific event branches.
 */
export interface AgentGraphRuntimeEventEnvelope extends RuntimeEventBase {
  readonly kind: string;
  readonly data: object;
}
