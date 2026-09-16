import type { RuntimeAgentOutputPayload, RuntimeAgentOutputStatus } from "./runtime-event.js";

export type AgentOutputStatus = RuntimeAgentOutputStatus;
export type AgentOutputEventPayload = RuntimeAgentOutputPayload;

/** Host-derived identity for one exact Graph operator activation. */
export interface GraphOperatorActivationContext {
  readonly kind: "graph_operator_activation";
  readonly graphId: string;
  readonly operatorId: string;
  readonly operatorGeneration: number;
  readonly activationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface CommitAgentOutputInput {
  readonly activation: GraphOperatorActivationContext;
  readonly toolCallId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly eventPayload: AgentOutputEventPayload;
}

export interface CommitAgentOutputReceipt {
  readonly eventId: string;
  readonly recordId?: string;
  readonly replayed: boolean;
}

/** Persistence/runtime adapter supplied by the Graph host. */
export interface AgentOutputCommitPort {
  commitAgentOutput(input: CommitAgentOutputInput): Promise<CommitAgentOutputReceipt>;
}

/** A host-bound capability: no model-controlled repository, branch, path or argv. */
export type GraphManagedGitRequest =
  | { readonly operation: "status" | "diff" }
  | { readonly operation: "commit"; readonly expected_head: string; readonly message: string };

export interface GraphManagedGitResult {
  readonly branch: string;
  readonly head: string;
  readonly output: string;
}

export interface GraphManagedGitPort {
  execute(request: GraphManagedGitRequest, signal?: AbortSignal): Promise<GraphManagedGitResult>;
}
