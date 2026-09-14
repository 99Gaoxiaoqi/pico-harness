import type {
  AgentGraph,
  AgentGraphActivationClaim,
  AgentGraphActivationIntent,
  AgentGraphOperator,
  AgentGraphOperatorProvision,
  AgentGraphRecordRef,
  AgentGraphStopCommand,
} from "./agent-graph-contracts.js";
import type { AgentGraphOperatorProfileSummary } from "./agent-graph-profile-contracts.js";
import type { AgentGraphRuntimeStatus } from "./agent-graph-runtime-contracts.js";

/** Runtime-owned identity for the exact root Supervisor activation. */
export interface AgentGraphRootToolContext {
  readonly supervision?: AgentGraphActivationIntent["supervision"];
  readonly kind: "graph_root_supervisor";
  readonly graphId: string;
  readonly epoch: number;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly rootModelRouteId?: string;
}

export interface AgentGraphSupervisorOperator extends Omit<AgentGraphOperator, "profileSnapshot"> {
  readonly profile: {
    readonly profileId: string;
    readonly revision: string;
  };
}

export interface AgentGraphSupervisorProvision extends Omit<
  AgentGraphOperatorProvision,
  "profileSnapshot"
> {
  readonly profile: {
    readonly profileId: string;
    readonly revision: string;
  };
}

/** Stable, authority-free Graph control-plane projection. */
export interface AgentGraphSupervisorProjection {
  readonly graph: AgentGraph;
  readonly operators: readonly AgentGraphSupervisorOperator[];
  readonly intents: readonly AgentGraphActivationIntent[];
  readonly stops: readonly AgentGraphStopCommand[];
  readonly provisions: readonly AgentGraphSupervisorProvision[];
  readonly claims: readonly AgentGraphActivationClaim[];
  readonly records: readonly AgentGraphRecordRef[];
}

/** Runtime truth resolved on demand; never persisted in the Graph control tables. */
export interface AgentGraphSupervisorClaimRuntime {
  readonly outputStatus?: "success" | "failure";
  readonly failureReason?: string;
  readonly claimId: string;
  readonly status: AgentGraphRuntimeStatus;
  readonly terminalEventId?: string;
  readonly outputEventIds: readonly string[];
}

export interface AgentGraphSupervisorResult {
  readonly recordId: string;
  readonly status: "success" | "failure";
  readonly provenance: {
    readonly graphId: string;
    readonly operatorId: string;
    readonly operatorGeneration: number;
    readonly claimId: string;
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly invocationId: string;
    readonly eventId: string;
  };
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly resources: readonly {
    readonly resourceId: string;
    readonly kind: "artifact" | "evidence";
    readonly ref: string;
    readonly digest: string;
    readonly bytes: number;
    readonly mediaType?: string;
    readonly title?: string;
  }[];
}

export interface AgentGraphSupervisorIntentReadiness {
  readonly intentId: string;
  readonly status: "resolved" | "in_flight" | "failed" | "unknown";
  readonly resolvedRecordIds: readonly string[];
  readonly inFlightRecordIds: readonly string[];
  readonly failedRecordIds: readonly string[];
  readonly unknownRecordIds: readonly string[];
}

export interface AgentGraphSupervisorView extends AgentGraphSupervisorProjection {
  readonly availableOperatorProfiles: readonly AgentGraphOperatorProfileSummary[];
  readonly intentReadiness: readonly AgentGraphSupervisorIntentReadiness[];
  readonly runtimeClaims: readonly AgentGraphSupervisorClaimRuntime[];
  readonly results: {
    readonly records: readonly AgentGraphSupervisorResult[];
    readonly totalBytes: number;
    readonly truncated: boolean;
  };
}

export interface CommitAgentGraphUpdateResult {
  readonly revision: number;
  readonly replayed: boolean;
  readonly projection: AgentGraphSupervisorProjection;
}

export interface ReadAgentGraphProjectionInput {
  readonly graphId: string;
  readonly epoch: number;
  readonly rootSessionId: string;
  readonly recordIds?: readonly string[];
}

export interface RegisterAgentGraphYieldInput {
  readonly graphId: string;
  readonly epoch: number;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly toolCallId: string;
}

export interface RegisterAgentGraphYieldResult {
  readonly permitId: string;
  readonly replayed?: boolean;
  readonly snapshot: AgentGraphSupervisorProjection;
}
