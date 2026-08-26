import {
  AgentGraphSupervisorService,
  type AgentGraphDrivePort,
  type AgentGraphDriveResult,
  type AgentGraphRootWakePort,
  type AgentGraphSupervisorServiceOptions,
  type AgentGraphYieldSnapshot,
  type RegisterAgentGraphYieldInput as SupervisorRegisterYieldInput,
} from "../daemon/agent-graph-supervisor-service.js";
import type { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import type {
  AgentGraphSupervisorProjection,
  AgentGraphSupervisorToolPort,
  CommitAgentGraphUpdateInput,
  CommitAgentGraphUpdateResult,
  ReadAgentGraphProjectionInput,
  RegisterAgentGraphYieldInput,
  RegisterAgentGraphYieldResult,
} from "../tools/agent-graph-tools.js";
import { deterministicFingerprint } from "./core/ids.js";
import { AgentGraphReconciler } from "./reconciler.js";
import {
  AgentGraphRuntimePortBridge,
  type AgentGraphRuntimeApplicationPort,
  type ResolveAgentGraphOperatorWorkspaceInput,
  type ResolvedAgentGraphOperatorWorkspace,
} from "./runtime-adapter-bridge.js";
import { SqliteAgentGraphControlStoreAdapter } from "./sqlite-control-store-adapter.js";

export interface CreateAgentGraphApplicationServiceOptions {
  readonly store: SqliteAgentGraphControlStore;
  readonly runtime: AgentGraphRuntimeApplicationPort;
  readonly rootWakePort: AgentGraphRootWakePort;
  readonly resolveOperatorWorkspace: (
    input: ResolveAgentGraphOperatorWorkspaceInput,
  ) => Promise<ResolvedAgentGraphOperatorWorkspace> | ResolvedAgentGraphOperatorWorkspace;
  readonly now?: () => number;
  readonly retryDelayMs?: AgentGraphSupervisorServiceOptions["retryDelayMs"];
  readonly onError?: AgentGraphSupervisorServiceOptions["onError"];
}

export interface AgentGraphApplicationService {
  readonly toolPort: AgentGraphSupervisorToolPort;
  readonly drivePort: AgentGraphDrivePort;
  readonly supervisor: AgentGraphSupervisorService;
  start(): Promise<void>;
  close(): Promise<void>;
}

interface PreparedYieldRegistration extends RegisterAgentGraphYieldInput {
  replayed?: boolean;
}

class SqliteAgentGraphDriveBridge implements AgentGraphDrivePort {
  private readonly preparedYields = new Map<string, PreparedYieldRegistration>();

  constructor(
    private readonly store: SqliteAgentGraphControlStore,
    private readonly control: SqliteAgentGraphControlStoreAdapter,
    private readonly reconciler: AgentGraphReconciler,
    private readonly runtime: AgentGraphRuntimePortBridge,
  ) {}

  listOpenGraphIds(): readonly string[] {
    return this.control.listGraphIds({ openOnly: true });
  }

  async driveGraph(graphId: string): Promise<AgentGraphDriveResult> {
    const result = await this.reconciler.reconcile(graphId);
    this.runtime.releaseStoppedProvisions(graphId);
    return {
      quiescent: result.quiescent,
      wakeCandidates: result.wakeCandidates.map((candidate) => ({
        dedupeKey: candidate.dedupeKey,
        cause: "runtime_terminal" as const,
        payload: candidate.payload,
      })),
    };
  }

  prepareYield(input: RegisterAgentGraphYieldInput, permitId: string): void {
    const current = this.preparedYields.get(permitId);
    if (current && !sameYieldRegistration(current, input)) {
      throw new Error(`Yield permit ${permitId} is already bound to another root activation`);
    }
    this.preparedYields.set(permitId, { ...input });
  }

  consumeYieldReplayFlag(permitId: string): boolean | undefined {
    const prepared = this.preparedYields.get(permitId);
    this.preparedYields.delete(permitId);
    return prepared?.replayed;
  }

  registerYieldInterest(input: SupervisorRegisterYieldInput): void {
    const prepared = this.preparedYields.get(input.permitId);
    if (
      !prepared ||
      prepared.graphId !== input.graphId ||
      prepared.rootSessionId !== input.rootSessionId ||
      prepared.rootRunId !== input.rootRunId
    ) {
      throw new Error(`Yield permit ${input.permitId} has no matching root tool context`);
    }
    const result = this.store.registerYieldInterest({
      permitId: input.permitId,
      graphId: prepared.graphId,
      rootSessionId: prepared.rootSessionId,
      rootTurnId: prepared.rootTurnId,
      rootRunId: prepared.rootRunId,
      toolCallId: prepared.toolCallId,
    });
    prepared.replayed = result.replayed;
  }

  async readYieldSnapshot(graphId: string): Promise<AgentGraphYieldSnapshot> {
    const state = this.control.getScheduleState(graphId);
    const claims = this.control.listActivationClaims(graphId);
    const records = this.control.listRecordRefs(graphId);
    const claimsByIntent = new Map(claims.map((claim) => [claim.intentId, claim]));
    let pending = state.intents.filter((intent) => !claimsByIntent.has(intent.intentId)).length;
    let executing = 0;
    for (const claim of claims) {
      if (claim.state === "cancelled") continue;
      const projection = await this.runtime.observeActivation(claim);
      if (projection.status === "not-started") pending += 1;
      if (projection.status === "running" || projection.status === "waiting-permission") {
        executing += 1;
      }
    }
    return {
      graphId,
      headRevision: state.graph.headRevision,
      phase: state.graph.admissionPhase === "open" ? "open" : "finished",
      pending,
      executing,
      availableRecordIds: records.map((record) => record.recordId),
    };
  }
}

class AgentGraphToolApplicationService implements AgentGraphSupervisorToolPort {
  constructor(
    private readonly store: SqliteAgentGraphControlStore,
    private readonly control: SqliteAgentGraphControlStoreAdapter,
    private readonly drive: SqliteAgentGraphDriveBridge,
    private readonly supervisor: AgentGraphSupervisorService,
    private readonly onAsyncError?: AgentGraphSupervisorServiceOptions["onError"],
  ) {}

  async commitUpdate(input: CommitAgentGraphUpdateInput): Promise<CommitAgentGraphUpdateResult> {
    this.ensureEpochOneGraph(input.graphId, input.source.sessionId);
    const graph = this.requireRootGraph(input.graphId, input.source.sessionId);
    if (graph.rootSessionId !== input.source.sessionId) {
      throw new Error(`Graph ${input.graphId} does not belong to update source Session`);
    }
    const committed = this.control.commitScheduleRevision({
      graphId: input.graphId,
      expectedPreviousRevision: input.expectedRevision,
      operationId: input.operationId,
      source: input.source,
      commands: input.commands,
    });
    // Schedule delivery is asynchronous: update_agent_graph never waits in the
    // tool stack for an Operator/provider execution.
    void this.supervisor
      .notifyGraph(input.graphId)
      .catch((error) => this.onAsyncError?.(error, { graphId: input.graphId }));
    return {
      revision: committed.record.revision,
      replayed: committed.replayed,
      projection: this.readProjectionSync(input.graphId, input.source.sessionId),
    };
  }

  async readProjection(
    input: ReadAgentGraphProjectionInput,
  ): Promise<AgentGraphSupervisorProjection> {
    this.ensureEpochOneGraph(input.graphId, input.rootSessionId);
    return this.readProjectionSync(input.graphId, input.rootSessionId);
  }

  async registerYield(input: RegisterAgentGraphYieldInput): Promise<RegisterAgentGraphYieldResult> {
    this.ensureEpochOneGraph(input.graphId, input.rootSessionId);
    this.requireRootGraph(input.graphId, input.rootSessionId);
    const permitId = yieldPermitId(input);
    this.drive.prepareYield(input, permitId);
    try {
      // Supervisor owns the register-before-reconcile-before-snapshot order.
      await this.supervisor.registerYield({
        permitId,
        graphId: input.graphId,
        rootSessionId: input.rootSessionId,
        rootRunId: input.rootRunId,
      });
      const replayed = this.drive.consumeYieldReplayFlag(permitId);
      return {
        permitId,
        ...(replayed === undefined ? {} : { replayed }),
        snapshot: this.readProjectionSync(input.graphId, input.rootSessionId),
      };
    } catch (error) {
      this.drive.consumeYieldReplayFlag(permitId);
      throw error;
    }
  }

  private readProjectionSync(
    graphId: string,
    rootSessionId: string,
  ): AgentGraphSupervisorProjection {
    this.requireRootGraph(graphId, rootSessionId);
    const state = this.control.getScheduleState(graphId);
    return {
      graph: state.graph,
      operators: state.operators,
      intents: state.intents,
      stops: state.stops,
      provisions: this.control.listOperatorProvisions(graphId),
      claims: this.control.listActivationClaims(graphId),
      records: this.control.listRecordRefs(graphId),
    };
  }

  private ensureEpochOneGraph(graphId: string, rootSessionId: string): void {
    const existing = this.store.getGraph(graphId);
    if (existing) {
      if (existing.rootSessionId !== rootSessionId || existing.epoch !== 1) {
        throw new Error(`Graph ${graphId} is not the epoch=1 Graph for root Session`);
      }
      return;
    }
    this.store.createGraph({ graphId, rootSessionId, epoch: 1 });
  }

  private requireRootGraph(graphId: string, rootSessionId: string) {
    const graph = this.store.getGraph(graphId);
    if (!graph || graph.rootSessionId !== rootSessionId || graph.epoch !== 1) {
      throw new Error(`Graph ${graphId} does not belong to root Session ${rootSessionId}`);
    }
    return graph;
  }
}

export function createAgentGraphApplicationService(
  options: CreateAgentGraphApplicationServiceOptions,
): AgentGraphApplicationService {
  const control = new SqliteAgentGraphControlStoreAdapter(options.store);
  const runtime = new AgentGraphRuntimePortBridge({
    store: options.store,
    runtime: options.runtime,
    resolveOperatorWorkspace: options.resolveOperatorWorkspace,
  });
  const reconciler = new AgentGraphReconciler({
    store: control,
    runtime,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const drive = new SqliteAgentGraphDriveBridge(options.store, control, reconciler, runtime);
  const supervisor = new AgentGraphSupervisorService({
    store: options.store,
    drivePort: drive,
    rootWakePort: options.rootWakePort,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const toolPort = new AgentGraphToolApplicationService(
    options.store,
    control,
    drive,
    supervisor,
    options.onError,
  );
  let closed = false;
  return {
    toolPort,
    drivePort: drive,
    supervisor,
    start: () => supervisor.start(),
    close: async () => {
      if (closed) return;
      closed = true;
      await supervisor.close();
      runtime.close();
    },
  };
}

function yieldPermitId(input: RegisterAgentGraphYieldInput): string {
  return `yield_permit_${deterministicFingerprint(input).slice("sha256:".length, 39)}`;
}

function sameYieldRegistration(
  left: RegisterAgentGraphYieldInput,
  right: RegisterAgentGraphYieldInput,
): boolean {
  return (
    left.graphId === right.graphId &&
    left.rootSessionId === right.rootSessionId &&
    left.rootTurnId === right.rootTurnId &&
    left.rootRunId === right.rootRunId &&
    left.toolCallId === right.toolCallId
  );
}
