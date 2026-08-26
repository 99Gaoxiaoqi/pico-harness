import type {
  AgentGraph,
  AgentGraphActivationClaim,
  AgentGraphOperatorProvision,
  AgentGraphRecordRef,
  AgentGraphScheduleCommand,
  AgentGraphScheduleRevision,
  AgentGraphScheduleState,
  AgentGraphOperationSource,
} from "./core/index.js";

export interface AgentGraphStoreResult<T> {
  readonly record: T;
  readonly replayed: boolean;
}

export interface CommitAgentGraphRevisionInput {
  readonly graphId: string;
  readonly expectedPreviousRevision: number;
  readonly operationId: string;
  readonly source: AgentGraphOperationSource;
  readonly commands: readonly AgentGraphScheduleCommand[];
}

export interface EnsureAgentGraphProvisionInput {
  readonly provision: AgentGraphOperatorProvision;
  readonly scheduleRevision: number;
  readonly provisionFingerprint: string;
}

export interface ClaimAgentGraphIntentInput {
  readonly claim: AgentGraphActivationClaim;
  readonly expectedGraphRevision: number;
}

export interface TransitionAgentGraphClaimInput {
  readonly claimId: string;
  readonly from: AgentGraphActivationClaim["state"];
  readonly to: Extract<AgentGraphActivationClaim["state"], "executing" | "cancelled">;
  readonly cancellationReason?: string;
}

export interface PutAgentGraphRecordInput {
  readonly record: AgentGraphRecordRef;
  readonly recordFingerprint: string;
}

/**
 * Domain-facing scheduling authority. Runtime execution facts deliberately do
 * not live here; they are observed through AgentGraphRuntimePort.
 */
export interface AgentGraphControlStore {
  getGraph(graphId: string): AgentGraph | undefined;
  listGraphIds(options?: {
    readonly rootSessionId?: string;
    readonly openOnly?: boolean;
  }): readonly string[];
  getScheduleState(graphId: string): AgentGraphScheduleState;
  commitScheduleRevision(
    input: CommitAgentGraphRevisionInput,
  ): AgentGraphStoreResult<AgentGraphScheduleRevision>;

  listOperatorProvisions(graphId: string): readonly AgentGraphOperatorProvision[];
  ensureOperatorProvision(
    input: EnsureAgentGraphProvisionInput,
  ): AgentGraphStoreResult<AgentGraphOperatorProvision>;

  listActivationClaims(graphId: string): readonly AgentGraphActivationClaim[];
  claimActivation(
    input: ClaimAgentGraphIntentInput,
  ): AgentGraphStoreResult<AgentGraphActivationClaim>;
  transitionActivationClaim(
    input: TransitionAgentGraphClaimInput,
  ): AgentGraphStoreResult<AgentGraphActivationClaim>;

  listRecordRefs(graphId: string): readonly AgentGraphRecordRef[];
  putRecordRef(input: PutAgentGraphRecordInput): AgentGraphStoreResult<AgentGraphRecordRef>;
}
