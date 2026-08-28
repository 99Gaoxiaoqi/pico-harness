import { createHash } from "node:crypto";

import type { RuntimeEvent } from "../storage/runtime-event.js";
import type { AgentGraphActivationClaimRecord } from "../storage/sqlite/agent-graph-store-types.js";

export type AgentGraphActivationRuntimeStatus =
  | "not_started"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentGraphActivationRuntimeProjection {
  readonly claimId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly invocationId: string;
  readonly status: AgentGraphActivationRuntimeStatus;
  readonly startedEventId?: string;
  readonly terminalEventId?: string;
  readonly outputEventIds: readonly string[];
}

/** Host liveness may refine a nonterminal ledger projection, but never override a durable terminal. */
export type AgentGraphRunLaunchState =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "running" }>
  | Readonly<{ status: "succeeded" }>
  | Readonly<{ status: "failed" | "cancelled" | "interrupted"; error?: string }>;

export interface ProjectAgentGraphRuntimeActivationInput {
  readonly claim: AgentGraphActivationClaimRecord;
  readonly events: readonly RuntimeEvent[];
  readonly launchState?: AgentGraphRunLaunchState;
}

export class AgentGraphRuntimeIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGraphRuntimeIntegrityError";
  }
}

/** Canonical Graph activation read model shared by Supervisor, tools and Desktop. */
export function projectAgentGraphRuntimeActivation(
  input: ProjectAgentGraphRuntimeActivationInput,
): AgentGraphActivationRuntimeProjection {
  const projection = projectDurableActivation(input.claim, input.events);
  if (isTerminalStatus(projection.status) || projection.status === "not_started") {
    return projection;
  }
  const launch = input.launchState ?? { status: "unknown" as const };
  if (
    launch.status === "failed" ||
    launch.status === "cancelled" ||
    launch.status === "interrupted"
  ) {
    return { ...projection, status: launch.status };
  }
  if (launch.status === "succeeded") {
    return { ...projection, status: "interrupted" };
  }
  if (launch.status === "unknown" && hasNonAttachableRuntimeFacts(input.claim, input.events)) {
    return { ...projection, status: "interrupted" };
  }
  return projection;
}

function projectDurableActivation(
  claim: AgentGraphActivationClaimRecord,
  events: readonly RuntimeEvent[],
): AgentGraphActivationRuntimeProjection {
  if (events.length === 0) return emptyProjection(claim);
  for (const event of events) assertEventBelongsToClaim(event, claim);
  const starts = events.filter((event) => event.kind === "run.started");
  if (starts.length !== 1) {
    throw new AgentGraphRuntimeIntegrityError(
      `Exact RuntimeRun ${claim.targetRunId} must contain exactly one run.started event`,
    );
  }
  const started = starts[0]!;
  if (started.eventId !== claim.runStartedEventId || started.turnId !== claim.targetTurnId) {
    throw new AgentGraphRuntimeIntegrityError(
      `Exact RuntimeRun ${claim.targetRunId} start identity does not match its Claim`,
    );
  }
  const terminals = events.filter((event) => event.kind === "run.terminal");
  if (terminals.length > 1) {
    throw new AgentGraphRuntimeIntegrityError(
      `Exact RuntimeRun ${claim.targetRunId} has conflicting terminal facts`,
    );
  }
  const terminal = terminals[0];
  const unsettledApprovals = new Set<string>();
  for (const event of events) {
    if (event.kind === "approval.requested") unsettledApprovals.add(event.data.approvalId);
    if (event.kind === "approval.settled") unsettledApprovals.delete(event.data.approvalId);
  }
  return {
    claimId: claim.claimId,
    sessionId: claim.targetSessionId,
    turnId: claim.targetTurnId,
    runId: claim.targetRunId,
    invocationId: claim.targetInvocationId,
    status: terminal
      ? terminal.data.status === "completed"
        ? "completed"
        : terminal.data.status
      : unsettledApprovals.size > 0
        ? "waiting_permission"
        : "running",
    startedEventId: started.eventId,
    ...(terminal ? { terminalEventId: terminal.eventId } : {}),
    outputEventIds: [],
  };
}

function hasNonAttachableRuntimeFacts(
  claim: AgentGraphActivationClaimRecord,
  events: readonly RuntimeEvent[],
): boolean {
  const inputEventId = `user-message:agent-graph-input:${createHash("sha256")
    .update(claim.claimId)
    .digest("hex")}`;
  return events.some((event) => {
    if (event.kind === "run.started" || event.kind === "run.terminal") return false;
    if (event.eventId !== inputEventId) return true;
    if (event.kind !== "message.committed" || event.data.message.role !== "user") {
      throw new AgentGraphRuntimeIntegrityError(
        `Graph input event ${inputEventId} is bound to an incompatible Runtime fact`,
      );
    }
    return false;
  });
}

function emptyProjection(
  claim: AgentGraphActivationClaimRecord,
): AgentGraphActivationRuntimeProjection {
  return {
    claimId: claim.claimId,
    sessionId: claim.targetSessionId,
    turnId: claim.targetTurnId,
    runId: claim.targetRunId,
    invocationId: claim.targetInvocationId,
    status: "not_started",
    outputEventIds: [],
  };
}

function isTerminalStatus(status: AgentGraphActivationRuntimeStatus): boolean {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

function assertEventBelongsToClaim(
  event: RuntimeEvent,
  claim: AgentGraphActivationClaimRecord,
): void {
  if (
    event.sessionId !== claim.targetSessionId ||
    event.runId !== claim.targetRunId ||
    event.invocationId !== claim.targetInvocationId
  ) {
    throw new AgentGraphRuntimeIntegrityError(
      `Runtime event ${event.eventId} identity does not match Claim ${claim.claimId}`,
    );
  }
}
