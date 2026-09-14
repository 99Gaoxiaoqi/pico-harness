import type {
  AgentGraphActivationClaimRecord,
  AgentGraphResourceRefRecord,
} from "./agent-graph-store-contracts.js";

export interface RetainAgentGraphOutputResourcesInput {
  readonly claim: AgentGraphActivationClaimRecord;
  readonly evidenceRefs: readonly string[];
  readonly artifactRefs: readonly string[];
}

/** Host-owned resource validation and retention boundary for agent_output. */
export interface AgentGraphResourceAuthorityPort {
  retainOutputResources(
    input: RetainAgentGraphOutputResourcesInput,
  ): Promise<readonly AgentGraphResourceRefRecord[]>;
  listClaimResources(claimId: string): readonly AgentGraphResourceRefRecord[];
}
