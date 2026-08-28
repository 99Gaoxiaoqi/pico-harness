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
import { assertValidAgentGraphOperatorProfileSnapshot } from "./operator-profile-catalog.js";
import { AgentGraphNeedsAttentionError } from "./diagnostics.js";

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
  release?(reason: "host-shutdown" | "provision-stopped"): Promise<void> | void;
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
    const resolvedIds = new Set(input.knownRecords.map((record) => record.recordId));
    const failedIntentIds = new Set(input.failedIntentIds);
    const claimsByIntent = new Map(input.claims.map((claim) => [claim.intentId, claim]));
    const producersByRecord = new Map(
      input.producerIntents.map((intent) => [intent.expectedOutputRecordId, intent]),
    );
    const inFlightRecordIds: string[] = [];
    const failedRecordIds: string[] = [];

    for (const reference of input.intent.inputRefs) {
      if (resolvedIds.has(reference.recordId)) continue;
      const producer = producersByRecord.get(reference.recordId);
      if (!producer) continue;
      if (failedIntentIds.has(producer.intentId)) {
        failedRecordIds.push(reference.recordId);
        continue;
      }
      const claim = claimsByIntent.get(producer.intentId);
      if (!claim) {
        inFlightRecordIds.push(reference.recordId);
        continue;
      }
      if (claim.state === "cancelled") {
        failedRecordIds.push(reference.recordId);
        continue;
      }
      const projection = await this.options.runtime.projectActivation(
        this.requireStoredClaim(claim),
      );
      if (
        isTerminalRuntimeProjection(projection.status) &&
        projection.outputEventIds.length === 0
      ) {
        failedRecordIds.push(reference.recordId);
      } else {
        // A terminal output may be committed in the Runtime ledger one fixed-point
        // pass before its formal RecordRef is projected into the control store.
        inFlightRecordIds.push(reference.recordId);
      }
    }
    return { records: input.knownRecords, inFlightRecordIds, failedRecordIds };
  }

  async ensureOperator(input: EnsureAgentGraphOperatorRequest): Promise<void> {
    this.requireOpen();
    try {
      assertValidAgentGraphOperatorProfileSnapshot(input.provision.profileSnapshot);
    } catch (error) {
      throw new AgentGraphNeedsAttentionError(
        "configuration",
        "Graph operator profile snapshot is invalid",
        { cause: error },
      );
    }
    const existing = this.leases.get(input.provision.provisionId);
    if (existing) {
      assertHeldLease(existing, input.provision);
      return;
    }
    const workspace = await this.options.resolveOperatorWorkspace(input);
    requireWorkDir(workspace.workDir);
    let lease: EnsuredAgentGraphOperatorSession;
    try {
      lease = await this.options.runtime.ensureOperatorProvision({
        provision: this.requireStoredProvision(input.provision),
        workDir: workspace.workDir,
        ...(workspace.sessionOptions === undefined
          ? {}
          : { sessionOptions: workspace.sessionOptions }),
      });
    } catch (error) {
      await workspace.release?.("host-shutdown");
      throw error;
    }
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
    assertValidAgentGraphOperatorProfileSnapshot(provision.profileSnapshot);
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

  async resolveRecordHandoff(
    records: readonly AgentGraphRecordRef[],
  ): Promise<ResolvedAgentGraphHandoff> {
    this.requireOpen();
    return this.options.runtime.resolveInputHandoff(
      records.map((record) => this.requireStoredRecord(record)),
    );
  }

  async stopActivation(input: StopAgentGraphActivationRequest): Promise<void> {
    this.requireOpen();
    await this.options.runtime.stopActivation(this.requireStoredClaim(input.claim), input.reason);
  }

  async releaseStoppedProvisions(graphId: string): Promise<void> {
    for (const provision of this.options.store.listOperatorProvisions(graphId)) {
      if (provision.state !== "stopped") continue;
      await this.releaseProvision(provision.provisionId, "provision-stopped");
    }
  }

  async releaseProvision(
    provisionId: string,
    reason: "host-shutdown" | "provision-stopped",
  ): Promise<void> {
    const held = this.leases.get(provisionId);
    if (!held) return;
    this.leases.delete(provisionId);
    held.lease.release();
    await held.workspace.release?.(reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const held = [...this.leases.values()];
    this.leases.clear();
    const failures: unknown[] = [];
    for (const item of held) {
      try {
        item.lease.release();
        await item.workspace.release?.("host-shutdown");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Graph workspace release failed");
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
  const contract = [
    "[Graph Operator activation]",
    "完成该 activation 后必须调用 agent_output，显式提交 success 或 failure。",
    "普通文字回复不是正式输出；agent_output 成功后不要继续执行工具。",
  ].join("\n");
  return [contract, instruction, handoffPrompt].filter((part) => part.length > 0).join("\n\n");
}

function requireWorkDir(workDir: string): void {
  if (!workDir.trim()) throw new Error("Graph operator workDir must not be empty");
}

function isTerminalRuntimeProjection(
  status: AgentGraphActivationRuntimeProjection["status"],
): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
