import type { SessionOptions } from "../engine/session.js";
import type {
  AgentGraphActivationRuntimeProjection,
  AgentGraphRuntimeAdapter,
  EnsuredAgentGraphOperatorSession,
  ResolvedAgentGraphHandoff,
  StartOrObserveAgentGraphActivationResult,
} from "../runtime/agent-graph-runtime-adapter.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecordRefRecord,
} from "../storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import type {
  AgentGraphActivationClaim,
  AgentGraphOperator,
  AgentGraphOperatorProvision,
  AgentGraphRecordRef,
} from "./core/index.js";
import type {
  AgentGraphRuntimePort,
  AgentGraphRuntimeProjection,
  EnsureAgentGraphOperatorRequest,
  ResolveAgentGraphInputsRequest,
  StartAgentGraphActivationRequest,
  StopAgentGraphActivationRequest,
} from "./runtime-port.js";

export interface AgentGraphRuntimeApplicationPort {
  ensureOperatorProvision(
    input: Parameters<AgentGraphRuntimeAdapter["ensureOperatorProvision"]>[0],
  ): Promise<EnsuredAgentGraphOperatorSession>;
  startOrObserveActivation(
    input: Parameters<AgentGraphRuntimeAdapter["startOrObserveActivation"]>[0],
  ): Promise<StartOrObserveAgentGraphActivationResult>;
  projectActivation(
    claim: AgentGraphActivationClaimRecord,
  ): Promise<AgentGraphActivationRuntimeProjection>;
  stopActivation(
    claim: AgentGraphActivationClaimRecord,
    reason: string,
  ): Promise<"requested" | "already_terminal" | "not_started">;
  resolveInputHandoff(
    records: readonly AgentGraphRecordRefRecord[],
  ): Promise<ResolvedAgentGraphHandoff>;
}

export interface ResolveAgentGraphOperatorWorkspaceInput {
  readonly operator: AgentGraphOperator;
  readonly provision: AgentGraphOperatorProvision;
}

export interface ResolvedAgentGraphOperatorWorkspace {
  readonly workDir: string;
  readonly sessionOptions?: SessionOptions;
}

export interface AgentGraphRuntimePortBridgeOptions {
  readonly store: SqliteAgentGraphControlStore;
  readonly runtime: AgentGraphRuntimeApplicationPort;
  readonly resolveOperatorWorkspace: (
    input: ResolveAgentGraphOperatorWorkspaceInput,
  ) => Promise<ResolvedAgentGraphOperatorWorkspace> | ResolvedAgentGraphOperatorWorkspace;
}

interface HeldOperatorLease {
  readonly lease: EnsuredAgentGraphOperatorSession;
  readonly workspace: ResolvedAgentGraphOperatorWorkspace;
}

/**
 * Converts domain reconciliation requests into the concrete Session/Runtime
 * adapter contract. The held lease is process-local liveness only; provision,
 * Claim and Runtime events remain the restart authority.
 */
export class AgentGraphRuntimePortBridge implements AgentGraphRuntimePort {
  private readonly leases = new Map<string, HeldOperatorLease>();
  private closed = false;

  constructor(private readonly options: AgentGraphRuntimePortBridgeOptions) {}

  async resolveInputFacts(input: ResolveAgentGraphInputsRequest) {
    this.requireOpen();
    return { records: input.knownRecords };
  }

  async ensureOperator(input: EnsureAgentGraphOperatorRequest): Promise<void> {
    this.requireOpen();
    const existing = this.leases.get(input.provision.provisionId);
    if (existing) {
      assertHeldLease(existing, input.provision);
      return;
    }
    const workspace = await this.options.resolveOperatorWorkspace(input);
    requireWorkDir(workspace.workDir);
    const lease = await this.options.runtime.ensureOperatorProvision({
      provision: this.requireStoredProvision(input.provision),
      workDir: workspace.workDir,
      ...(workspace.sessionOptions === undefined
        ? {}
        : { sessionOptions: workspace.sessionOptions }),
    });
    if (this.closed) {
      lease.release();
      throw new Error("Agent Graph runtime bridge is closed");
    }
    const concurrent = this.leases.get(input.provision.provisionId);
    if (concurrent) {
      lease.release();
      assertHeldLease(concurrent, input.provision);
      return;
    }
    this.leases.set(input.provision.provisionId, { lease, workspace });
  }

  async startOrObserveActivation(
    input: StartAgentGraphActivationRequest,
  ): Promise<AgentGraphRuntimeProjection> {
    this.requireOpen();
    const provision = this.requireProvisionForOperator(input.operator);
    const held = this.leases.get(provision.provisionId);
    if (!held) {
      throw new Error(`Graph operator provision ${provision.provisionId} is not pinned`);
    }
    if (held.lease.sessionId !== provision.childSessionId) {
      throw new Error(`Pinned Session does not match Graph provision ${provision.provisionId}`);
    }
    const records = input.inputRecords.map((record) => this.requireStoredRecord(record));
    const handoff = await this.options.runtime.resolveInputHandoff(records);
    const result = await this.options.runtime.startOrObserveActivation({
      claim: this.requireStoredClaim(input.claim),
      provision,
      workDir: held.workspace.workDir,
      prompt: renderActivationPrompt(input.intent.instruction, handoff.prompt),
    });
    return projectionFromRuntime(result.projection, input.claim);
  }

  async observeActivation(claim: AgentGraphActivationClaim): Promise<AgentGraphRuntimeProjection> {
    this.requireOpen();
    return projectionFromRuntime(
      await this.options.runtime.projectActivation(this.requireStoredClaim(claim)),
      claim,
    );
  }

  async stopActivation(input: StopAgentGraphActivationRequest): Promise<void> {
    this.requireOpen();
    await this.options.runtime.stopActivation(this.requireStoredClaim(input.claim), input.reason);
  }

  releaseStoppedProvisions(graphId: string): void {
    for (const provision of this.options.store.listOperatorProvisions(graphId)) {
      if (provision.state !== "stopped") continue;
      this.releaseProvision(provision.provisionId);
    }
  }

  releaseProvision(provisionId: string): void {
    const held = this.leases.get(provisionId);
    if (!held) return;
    this.leases.delete(provisionId);
    held.lease.release();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const held of this.leases.values()) held.lease.release();
    this.leases.clear();
  }

  private requireStoredRecord(record: AgentGraphRecordRef): AgentGraphRecordRefRecord {
    const stored = this.options.store.getRecordRef(record.recordId);
    if (
      !stored ||
      stored.graphId !== record.graphId ||
      stored.claimId !== record.activationClaimId ||
      stored.sourceEventId !== record.sourceEventId
    ) {
      throw new Error(`Graph record ${record.recordId} does not match its SQLite authority`);
    }
    return stored;
  }

  private requireStoredProvision(
    provision: AgentGraphOperatorProvision,
  ): AgentGraphOperatorProvisionRecord {
    const stored = this.options.store
      .listOperatorProvisions(provision.graphId)
      .find((candidate) => candidate.provisionId === provision.provisionId);
    if (
      !stored ||
      stored.operatorId !== provision.operatorId ||
      stored.generation !== provision.operatorGeneration ||
      stored.childSessionId !== provision.childSessionId ||
      stored.state !== provision.state ||
      stored.version !== provision.version
    ) {
      throw new Error(
        `Graph provision ${provision.provisionId} does not match its SQLite authority`,
      );
    }
    return stored;
  }

  private requireProvisionForOperator(
    operator: AgentGraphOperator,
  ): AgentGraphOperatorProvisionRecord {
    const stored = this.options.store
      .listOperatorProvisions(operator.graphId)
      .find(
        (candidate) =>
          candidate.operatorId === operator.operatorId &&
          candidate.generation === operator.generation,
      );
    if (!stored || stored.state !== "provisioned") {
      throw new Error(
        `Graph operator ${operator.operatorId}@${operator.generation} has no provisioned Session`,
      );
    }
    return stored;
  }

  private requireStoredClaim(claim: AgentGraphActivationClaim): AgentGraphActivationClaimRecord {
    const stored = this.options.store.getActivationClaim(claim.claimId);
    if (
      !stored ||
      stored.graphId !== claim.graphId ||
      stored.targetSessionId !== claim.targetSessionId ||
      stored.targetTurnId !== claim.targetTurnId ||
      stored.targetRunId !== claim.targetRunId ||
      stored.targetInvocationId !== claim.targetInvocationId ||
      stored.runStartedEventId !== claim.runStartedEventId ||
      stored.state !== claim.state
    ) {
      throw new Error(`Graph claim ${claim.claimId} does not match its SQLite authority`);
    }
    return stored;
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("Agent Graph runtime bridge is closed");
  }
}

function projectionFromRuntime(
  projection: AgentGraphActivationRuntimeProjection,
  claim: AgentGraphActivationClaim,
): AgentGraphRuntimeProjection {
  assertProjectionIdentity(projection, claim);
  return {
    status:
      projection.status === "not_started"
        ? "not-started"
        : projection.status === "waiting_permission"
          ? "waiting-permission"
          : projection.status,
    ...(projection.terminalEventId === undefined
      ? {}
      : { terminalEventId: projection.terminalEventId }),
    records: projection.outputEventIds.map((sourceEventId) => ({
      kind: "agent-output" as const,
      sourceSessionId: claim.targetSessionId,
      sourceTurnId: claim.targetTurnId,
      sourceRunId: claim.targetRunId,
      sourceEventId,
      committed: true,
      partial: false,
    })),
  };
}

function assertProjectionIdentity(
  projection: AgentGraphActivationRuntimeProjection,
  claim: AgentGraphActivationClaim,
): void {
  if (
    projection.claimId !== claim.claimId ||
    projection.sessionId !== claim.targetSessionId ||
    projection.turnId !== claim.targetTurnId ||
    projection.runId !== claim.targetRunId ||
    projection.invocationId !== claim.targetInvocationId
  ) {
    throw new Error(`Runtime projection does not match Graph claim ${claim.claimId}`);
  }
}

function assertHeldLease(held: HeldOperatorLease, provision: AgentGraphOperatorProvision): void {
  if (held.lease.sessionId !== provision.childSessionId) {
    throw new Error(`Pinned Session does not match Graph provision ${provision.provisionId}`);
  }
}

function renderActivationPrompt(instruction: string, handoffPrompt: string): string {
  return handoffPrompt ? `${instruction}\n\n${handoffPrompt}` : instruction;
}

function requireWorkDir(workDir: string): void {
  if (!workDir.trim()) throw new Error("Graph operator workDir must not be empty");
}
