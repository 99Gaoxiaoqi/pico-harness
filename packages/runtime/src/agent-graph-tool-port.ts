import type { CommitAgentGraphWorkInput } from "./agent-graph-work-request.js";
import type { AgentSwarmStatusResult } from "./agent-swarm-status.js";
import type { CommitAgentGraphUpdateInput } from "@pico/core/agent-graph-update-contracts";
import type {
  AgentGraphSupervisorView,
  CommitAgentGraphUpdateResult,
  ReadAgentGraphProjectionInput,
  RegisterAgentGraphYieldInput,
  RegisterAgentGraphYieldResult,
} from "@pico/core/agent-graph-supervisor-contracts";

/** Thin application boundary: tools never own Graph storage, reconciliation, or Runtime execution. */
export interface AgentGraphSupervisorToolPort {
  readSwarmStatus?(input: ReadAgentGraphProjectionInput): Promise<AgentSwarmStatusResult>;
  commitWork?(input: CommitAgentGraphWorkInput): Promise<CommitAgentGraphUpdateResult>;
  commitUpdate(input: CommitAgentGraphUpdateInput): Promise<CommitAgentGraphUpdateResult>;
  readProjection(input: ReadAgentGraphProjectionInput): Promise<AgentGraphSupervisorView>;
  registerYield(input: RegisterAgentGraphYieldInput): Promise<RegisterAgentGraphYieldResult>;
  cancelYield(permitId: string, rootSessionId: string): Promise<void> | void;
}
