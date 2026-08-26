import type {
  AgentGraphActivationClaim,
  AgentGraphActivationIntent,
  AgentGraphOperator,
  AgentGraphOperatorProvision,
  AgentGraphReadinessFacts,
  AgentGraphRecordKind,
  AgentGraphRecordRef,
} from "./core/index.js";

export type AgentGraphRuntimeStatus =
  | "not-started"
  | "running"
  | "waiting-permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentGraphRuntimeRecordCandidate {
  readonly kind: AgentGraphRecordKind;
  readonly sourceSessionId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly sourceEventId: string;
  readonly committed: boolean;
  readonly partial: boolean;
}

export interface AgentGraphRuntimeProjection {
  readonly status: AgentGraphRuntimeStatus;
  readonly terminalEventId?: string;
  readonly records: readonly AgentGraphRuntimeRecordCandidate[];
}

export interface ResolveAgentGraphInputsRequest {
  readonly intent: AgentGraphActivationIntent;
  readonly knownRecords: readonly AgentGraphRecordRef[];
  readonly claims: readonly AgentGraphActivationClaim[];
}

export interface EnsureAgentGraphOperatorRequest {
  readonly operator: AgentGraphOperator;
  readonly provision: AgentGraphOperatorProvision;
}

export interface StartAgentGraphActivationRequest {
  readonly operator: AgentGraphOperator;
  readonly intent: AgentGraphActivationIntent;
  readonly claim: AgentGraphActivationClaim;
  readonly inputRecords: readonly AgentGraphRecordRef[];
}

export interface StopAgentGraphActivationRequest {
  readonly claim: AgentGraphActivationClaim;
  readonly reason: string;
}

/** Runtime bridge. Implementations must treat the exact IDs in a Claim as immutable. */
export interface AgentGraphRuntimePort {
  resolveInputFacts(input: ResolveAgentGraphInputsRequest): Promise<AgentGraphReadinessFacts>;
  ensureOperator(input: EnsureAgentGraphOperatorRequest): Promise<void>;
  startOrObserveActivation(
    input: StartAgentGraphActivationRequest,
  ): Promise<AgentGraphRuntimeProjection>;
  observeActivation(claim: AgentGraphActivationClaim): Promise<AgentGraphRuntimeProjection>;
  stopActivation(input: StopAgentGraphActivationRequest): Promise<void>;
}

export interface AgentGraphProvisionIdentity {
  readonly provisionId: string;
  readonly childSessionId: string;
}

export interface AgentGraphActivationIdentity {
  readonly claimId: string;
  readonly targetTurnId: string;
  readonly targetRunId: string;
  readonly targetInvocationId: string;
  readonly runStartedEventId: string;
}

export interface AgentGraphIdentityFactory {
  provision(operator: AgentGraphOperator): AgentGraphProvisionIdentity;
  activation(intent: AgentGraphActivationIntent): AgentGraphActivationIdentity;
}
