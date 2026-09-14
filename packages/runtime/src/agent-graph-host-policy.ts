import type {
  AgentGraphProfileSnapshot,
  AgentGraphWorkspacePolicy,
} from "@pico/core/agent-graph-contracts";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
} from "@pico/core/agent-graph-store-contracts";
import type { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";

import { assertValidAgentGraphOperatorProfileSnapshot } from "./agent-graph-operator-profile-catalog.js";

export function rootWakeIdFromClaim(claimId: string): string {
  if (!claimId.startsWith("root-wake:")) throw new Error(`Unknown Graph exact claim: ${claimId}`);
  const wakeId = claimId.slice("root-wake:".length);
  if (!wakeId) throw new Error("Graph root wake claim is empty");
  return wakeId;
}

export function requireValidProvisionProfile(
  store: SqliteAgentGraphControlStore,
  claim: AgentGraphActivationClaimRecord,
): AgentGraphOperatorProvisionRecord & { readonly profileSnapshot: AgentGraphProfileSnapshot } {
  const provision = store
    .listOperatorProvisions(claim.graphId)
    .find(
      (candidate) =>
        candidate.operatorId === claim.operatorId &&
        candidate.generation === claim.operatorGeneration,
    );
  if (!provision) throw new Error(`Graph activation ${claim.claimId} has no provision`);
  assertValidAgentGraphOperatorProfileSnapshot(provision.profileSnapshot);
  return provision as AgentGraphOperatorProvisionRecord & {
    readonly profileSnapshot: AgentGraphProfileSnapshot;
  };
}

export function provisionWorkspacePolicy(
  provision: AgentGraphOperatorProvisionRecord,
): AgentGraphWorkspacePolicy {
  const binding = provision.workspaceBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Graph provision ${provision.provisionId} has an invalid workspace binding`);
  }
  const kind = (binding as Record<string, unknown>)["kind"];
  if (kind === "shared") return { kind };
  if (kind === "isolated-worktree") {
    const baseRef = (binding as Record<string, unknown>)["baseRef"];
    if (baseRef !== undefined && typeof baseRef !== "string") {
      throw new Error(`Graph provision ${provision.provisionId} has an invalid workspace baseRef`);
    }
    return { kind, ...(baseRef === undefined ? {} : { baseRef }) };
  }
  throw new Error(`Graph provision ${provision.provisionId} has an unknown workspace binding`);
}
