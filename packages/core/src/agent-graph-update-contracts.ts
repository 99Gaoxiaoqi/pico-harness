import type {
  AgentGraphActivationIntent,
  AgentGraphOperationSource,
  AgentGraphOperator,
  AgentGraphScheduleCommand,
} from "./agent-graph-contracts.js";

/** A requested add carries an unresolved profile id; Runtime freezes the snapshot before persistence. */
export interface AgentGraphRequestedAddCommand {
  readonly kind: "add";
  readonly operator: Omit<AgentGraphOperator, "profileSnapshot"> & {
    readonly profileId: string;
    readonly requireConfiguredPreset?: boolean;
    readonly legacyCapabilityId?: boolean;
  };
  readonly intent: AgentGraphActivationIntent;
}

export type AgentGraphRequestedScheduleCommand =
  | AgentGraphRequestedAddCommand
  | Exclude<AgentGraphScheduleCommand, { readonly kind: "add" }>;

/** Stable request handed from a Graph tool to the application service. */
export interface CommitAgentGraphUpdateInput {
  readonly supervision?: AgentGraphActivationIntent["supervision"];
  readonly graphId: string;
  readonly epoch: number;
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly source: AgentGraphOperationSource;
  readonly rootModelRouteId: string;
  readonly commands: readonly AgentGraphRequestedScheduleCommand[];
}
