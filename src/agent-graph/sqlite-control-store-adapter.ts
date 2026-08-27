import type {
  AgentGraph,
  AgentGraphActivationClaim,
  AgentGraphOperatorProvision,
  AgentGraphRecordKind,
  AgentGraphRecordRef,
  AgentGraphScheduleCommand,
  AgentGraphScheduleRevision,
  AgentGraphScheduleState,
} from "./core/index.js";
import {
  applyScheduleRevision,
  createScheduleRevision,
  createAgentGraphScheduleState,
  scheduleOperationFingerprint,
} from "./core/index.js";
import type {
  AgentGraphControlStore,
  AgentGraphStoreResult,
  ClaimAgentGraphIntentInput,
  CommitAgentGraphRevisionInput,
  EnsureAgentGraphProvisionInput,
  PutAgentGraphRecordInput,
  TransitionAgentGraphClaimInput,
  TransitionAgentGraphProvisionInput,
} from "./control-store.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecordRefRecord,
  AgentGraphScheduleKind,
  AgentGraphScheduleRevisionRecord,
} from "../storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";

interface StoredScheduleEnvelope {
  readonly schemaVersion: 2;
  readonly commands: readonly AgentGraphScheduleCommand[];
}

export class SqliteAgentGraphControlStoreAdapter implements AgentGraphControlStore {
  constructor(private readonly store: SqliteAgentGraphControlStore) {}

  getGraph(graphId: string): AgentGraph | undefined {
    const graph = this.store.getGraph(graphId);
    if (!graph) return undefined;
    return this.getScheduleState(graphId).graph;
  }

  listGraphIds(
    options: {
      readonly rootSessionId?: string;
      readonly openOnly?: boolean;
    } = {},
  ): readonly string[] {
    return this.store
      .listGraphs(options.rootSessionId)
      .filter((graph) => !options.openOnly || graph.phase === "open")
      .map((graph) => graph.graphId);
  }

  getScheduleState(graphId: string): AgentGraphScheduleState {
    const storedGraph = this.store.getGraph(graphId);
    if (!storedGraph) throw new Error(`Graph ${graphId} does not exist`);
    let state = createAgentGraphScheduleState({
      graphId: storedGraph.graphId,
      rootSessionId: storedGraph.rootSessionId,
      epoch: storedGraph.epoch,
      admissionPhase: "open",
      headRevision: 0,
      selectedRecordIds: [],
      createdAt: storedGraph.createdAt,
    });
    for (const storedRevision of this.store.listScheduleRevisions(graphId)) {
      const revision = revisionFromRecord(storedRevision);
      state = applyScheduleRevision(state, revision).state;
    }
    if (
      state.graph.headRevision !== storedGraph.headRevision ||
      (state.graph.admissionPhase === "sealed") !== (storedGraph.phase === "finished")
    ) {
      throw new Error(`Graph ${graphId} schedule projection does not match stored graph head`);
    }
    return state;
  }

  commitScheduleRevision(
    input: CommitAgentGraphRevisionInput,
  ): AgentGraphStoreResult<AgentGraphScheduleRevision> {
    if (input.commands.length === 0) {
      throw new Error("Graph schedule revision must contain at least one command");
    }
    const requestFingerprint = scheduleOperationFingerprint({
      graphId: input.graphId,
      operationId: input.operationId,
      source: input.source,
      commands: input.commands,
    });
    const candidate = createScheduleRevision({
      graphId: input.graphId,
      revision: input.expectedPreviousRevision + 1,
      expectedPreviousRevision: input.expectedPreviousRevision,
      operationId: input.operationId,
      source: input.source,
      commands: input.commands,
      createdAt: 0,
    });
    applyScheduleRevision(this.getScheduleState(input.graphId), candidate);
    const result = this.store.commitScheduleRevision({
      graphId: input.graphId,
      expectedRevision: input.expectedPreviousRevision,
      operationId: input.operationId,
      requestFingerprint,
      kind: aggregateScheduleKind(input.commands),
      command: {
        schemaVersion: 2,
        commands: input.commands,
      } satisfies StoredScheduleEnvelope,
      sourceSessionId: input.source.sessionId,
      sourceTurnId: input.source.turnId,
      sourceRunId: input.source.runId,
      sourceToolCallId: input.source.toolCallId,
    });
    return { record: revisionFromRecord(result.revision), replayed: result.replayed };
  }

  listOperatorProvisions(graphId: string): readonly AgentGraphOperatorProvision[] {
    return this.store.listOperatorProvisions(graphId).map(provisionFromRecord);
  }

  ensureOperatorProvision(
    input: EnsureAgentGraphProvisionInput,
  ): AgentGraphStoreResult<AgentGraphOperatorProvision> {
    const { provision } = input;
    const result = this.store.ensureOperatorProvision({
      provisionId: provision.provisionId,
      graphId: provision.graphId,
      operatorId: provision.operatorId,
      generation: provision.operatorGeneration,
      scheduleRevision: input.scheduleRevision,
      provisionFingerprint: input.provisionFingerprint,
      childSessionId: provision.childSessionId,
      profileSnapshot: provision.profileSnapshot,
      workspaceBinding: provision.workspaceBinding,
    });
    return { record: provisionFromRecord(result.record), replayed: result.replayed };
  }

  transitionOperatorProvision(
    input: TransitionAgentGraphProvisionInput,
  ): AgentGraphStoreResult<AgentGraphOperatorProvision> {
    const result = this.store.transitionOperatorProvision(input);
    return { record: provisionFromRecord(result.record), replayed: result.replayed };
  }

  listActivationClaims(graphId: string): readonly AgentGraphActivationClaim[] {
    return this.store.listActivationClaims(graphId).map(claimFromRecord);
  }

  claimActivation(
    input: ClaimAgentGraphIntentInput,
  ): AgentGraphStoreResult<AgentGraphActivationClaim> {
    const { claim } = input;
    const result = this.store.claimActivation({
      claimId: claim.claimId,
      graphId: claim.graphId,
      intentId: claim.intentId,
      operatorId: claim.operatorId,
      operatorGeneration: claim.operatorGeneration,
      expectedGraphRevision: input.expectedGraphRevision,
      intentFingerprint: claim.intentFingerprint,
      readinessFingerprint: claim.readinessFingerprint,
      targetSessionId: claim.targetSessionId,
      targetTurnId: claim.targetTurnId,
      targetRunId: claim.targetRunId,
      targetInvocationId: claim.targetInvocationId,
      runStartedEventId: claim.runStartedEventId,
    });
    return { record: claimFromRecord(result.record), replayed: result.replayed };
  }

  transitionActivationClaim(
    input: TransitionAgentGraphClaimInput,
  ): AgentGraphStoreResult<AgentGraphActivationClaim> {
    const current = this.store.getActivationClaim(input.claimId);
    if (!current) throw new Error(`Graph activation claim ${input.claimId} does not exist`);
    const result = this.store.transitionActivationClaim({
      ...input,
      expectedVersion: current.version,
    });
    return { record: claimFromRecord(result.record), replayed: result.replayed };
  }

  listRecordRefs(graphId: string): readonly AgentGraphRecordRef[] {
    return this.store.listRecordRefs(graphId).map(recordRefFromRecord);
  }

  putRecordRef(input: PutAgentGraphRecordInput): AgentGraphStoreResult<AgentGraphRecordRef> {
    const { record } = input;
    const result = this.store.putRecordRef({
      recordId: record.recordId,
      graphId: record.graphId,
      claimId: record.activationClaimId,
      operatorId: record.operatorId,
      operatorGeneration: record.operatorGeneration,
      recordFingerprint: input.recordFingerprint,
      sourceSessionId: record.sourceSessionId,
      sourceTurnId: record.sourceTurnId,
      sourceRunId: record.sourceRunId,
      sourceEventId: record.sourceEventId,
      kind: recordKindToStore(record.kind),
    });
    return { record: recordRefFromRecord(result.record), replayed: result.replayed };
  }
}

function revisionFromRecord(record: AgentGraphScheduleRevisionRecord): AgentGraphScheduleRevision {
  const envelope = parseScheduleEnvelope(record.command);
  return {
    graphId: record.graphId,
    revision: record.revision,
    expectedPreviousRevision: record.revision - 1,
    operationId: record.operationId,
    fingerprint: record.requestFingerprint,
    source: {
      sessionId: record.sourceSessionId,
      turnId: record.sourceTurnId,
      runId: record.sourceRunId,
      toolCallId: record.sourceToolCallId,
    },
    commands: envelope.commands,
    createdAt: record.createdAt,
  };
}

function parseScheduleEnvelope(value: unknown): StoredScheduleEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Graph schedule command must be an object envelope");
  }
  const candidate = value as Partial<StoredScheduleEnvelope>;
  if (candidate.schemaVersion !== 2 || !Array.isArray(candidate.commands)) {
    throw new Error("Stored Graph schedule command envelope is invalid");
  }
  return {
    schemaVersion: candidate.schemaVersion,
    commands: candidate.commands,
  };
}

function aggregateScheduleKind(
  commands: readonly AgentGraphScheduleCommand[],
): AgentGraphScheduleKind {
  if (commands.some((command) => command.kind === "finish")) return "finish";
  if (commands.every((command) => command.kind === "stop")) return "stop";
  if (commands.length > 1) return "batch";
  if (commands.some((command) => command.kind === "add" || command.kind === "activate")) {
    return "add";
  }
  return "stop";
}

function provisionFromRecord(
  record: AgentGraphOperatorProvisionRecord,
): AgentGraphOperatorProvision {
  return {
    provisionId: record.provisionId,
    graphId: record.graphId,
    operatorId: record.operatorId,
    operatorGeneration: record.generation,
    childSessionId: record.childSessionId,
    state: record.state,
    version: record.version,
    profileSnapshot: record.profileSnapshot as AgentGraphOperatorProvision["profileSnapshot"],
    workspaceBinding: record.workspaceBinding as AgentGraphOperatorProvision["workspaceBinding"],
    createdAt: record.createdAt,
    ...(record.provisionedAt === undefined ? {} : { provisionedAt: record.provisionedAt }),
    ...(record.stoppedAt === undefined ? {} : { stoppedAt: record.stoppedAt }),
  };
}

function claimFromRecord(record: AgentGraphActivationClaimRecord): AgentGraphActivationClaim {
  return {
    claimId: record.claimId,
    graphId: record.graphId,
    intentId: record.intentId,
    operatorId: record.operatorId,
    operatorGeneration: record.operatorGeneration,
    scheduleRevision: record.scheduleRevision,
    intentFingerprint: record.intentFingerprint,
    readinessFingerprint: record.readinessFingerprint,
    state: record.state,
    targetSessionId: record.targetSessionId,
    targetTurnId: record.targetTurnId,
    targetRunId: record.targetRunId,
    targetInvocationId: record.targetInvocationId,
    runStartedEventId: record.runStartedEventId,
    claimedAt: record.claimedAt,
    ...(record.executingAt === undefined ? {} : { executingAt: record.executingAt }),
    ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt }),
    ...(record.cancellationReason === undefined
      ? {}
      : { cancellationReason: record.cancellationReason }),
  };
}

function recordRefFromRecord(record: AgentGraphRecordRefRecord): AgentGraphRecordRef {
  return {
    recordId: record.recordId,
    graphId: record.graphId,
    operatorId: record.operatorId,
    operatorGeneration: record.operatorGeneration,
    activationClaimId: record.claimId,
    sourceSessionId: record.sourceSessionId,
    sourceTurnId: record.sourceTurnId,
    sourceRunId: record.sourceRunId,
    sourceEventId: record.sourceEventId,
    kind: recordKindFromStore(record.kind),
  };
}

function recordKindToStore(kind: AgentGraphRecordKind): AgentGraphRecordRefRecord["kind"] {
  return kind === "agent-output" ? "agent_output" : kind;
}

function recordKindFromStore(kind: AgentGraphRecordRefRecord["kind"]): AgentGraphRecordKind {
  return kind === "agent_output" ? "agent-output" : kind;
}
