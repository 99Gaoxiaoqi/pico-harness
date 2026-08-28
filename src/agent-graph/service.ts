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
  AgentGraph,
  AgentGraphOperationSource,
  AgentGraphScheduleCommand,
  AgentGraphWorkspacePolicy,
} from "./core/contracts.js";
import { isIntentStopped, resolveIntentReadiness } from "./core/index.js";
import type {
  AgentGraphSupervisorProjection,
  AgentGraphSupervisorView,
  AgentGraphSupervisorToolPort,
  CommitAgentGraphUpdateInput,
  CommitAgentGraphUpdateResult,
  ReadAgentGraphProjectionInput,
  RegisterAgentGraphYieldInput,
  RegisterAgentGraphYieldResult,
} from "../tools/agent-graph-tools.js";
import { deterministicFingerprint } from "./core/ids.js";
import type { AgentGraphReconcileError } from "./reconciler.js";
import {
  createBuiltinAgentGraphOperatorProfileCatalog,
  type AgentGraphOperatorProfileCatalog,
} from "./operator-profile-catalog.js";
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
  readonly validateWorkspacePolicy?: (policy: AgentGraphWorkspacePolicy) => void;
  readonly operatorProfileCatalog?: AgentGraphOperatorProfileCatalog;
  readonly now?: () => number;
  readonly retryDelayMs?: AgentGraphSupervisorServiceOptions["retryDelayMs"];
  readonly onError?: AgentGraphSupervisorServiceOptions["onError"];
}

export interface AgentGraphApplicationService {
  readonly toolPort: AgentGraphSupervisorToolPort;
  readonly drivePort: AgentGraphDrivePort;
  readonly supervisor: AgentGraphSupervisorService;
  openRootEpoch(rootSessionId: string): AgentGraph;
  /** Host-owned recovery permit used when a scheduled root Run fails before yielding. */
  recoverFailedRootRun(input: RegisterAgentGraphYieldInput): Promise<boolean>;
  /** Seals an admitted epoch only when no schedule revision was ever committed. */
  sealEmptyRootEpoch(rootSessionId: string): boolean;
  /** Stops all work admitted by the root Session and seals its open epoch. */
  retireRootSession(rootSessionId: string, reason: string): Promise<boolean>;
  retryRootWake(wakeId: string): Promise<boolean>;
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
    private readonly now: () => number,
  ) {}

  listOpenGraphIds(): readonly string[] {
    return this.control.listGraphIds({ openOnly: true });
  }

  async driveGraph(
    graphId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<AgentGraphDriveResult> {
    const active = this.store.listGraphDiagnostics(graphId, { unresolvedOnly: true });
    if (!options.force) {
      if (active.some((diagnostic) => diagnostic.state === "needs_attention")) {
        return { quiescent: true, needsAttention: true };
      }
      const retryAt = active
        .flatMap((diagnostic) =>
          diagnostic.state === "retry_scheduled" && diagnostic.nextRetryAt !== undefined
            ? [diagnostic.nextRetryAt]
            : [],
        )
        .sort((left, right) => left - right)[0];
      if (retryAt !== undefined && retryAt > this.now()) {
        return { quiescent: true, retryAt };
      }
    }
    const result = await this.reconciler.reconcile(graphId);
    await this.runtime.releaseStoppedProvisions(graphId);
    if (result.errors.length === 0) {
      this.store.resolveGraphDiagnostics(graphId);
    } else {
      const current = new Map(
        this.store
          .listGraphDiagnostics(graphId)
          .map((diagnostic) => [`${diagnostic.phase}\u0000${diagnostic.subjectId}`, diagnostic]),
      );
      const errors = dedupeReconcileErrors(result.errors);
      const recorded = [];
      for (const error of errors) {
        const key = `${error.phase}\u0000${error.subjectId}`;
        const previous = current.get(key);
        const attemptNumber = (previous?.attemptCount ?? 0) + 1;
        recorded.push(this.store.recordGraphDiagnostic({
          diagnosticId: graphDiagnosticId(graphId, error.phase, error.subjectId),
          graphId,
          phase: error.phase,
          subjectId: error.subjectId,
          classification: error.classification,
          message: error.message,
          observationId: deterministicFingerprint({
            graphId,
            phase: error.phase,
            subjectId: error.subjectId,
            message: error.message,
            previousVersion: previous?.version ?? 0,
          }),
          ...(error.classification === "transient"
            ? { retryDelayMs: graphRetryDelayMs(attemptNumber) }
            : {}),
        }).record);
      }
      const retryAt = recorded
        .flatMap((diagnostic) => diagnostic.nextRetryAt ?? [])
        .sort((left, right) => left - right)[0];
      const unresolved = this.store.listGraphDiagnostics(graphId, { unresolvedOnly: true });
      return {
        quiescent: true,
        wakeCandidates: result.wakeCandidates.map((candidate) => ({
          dedupeKey: candidate.dedupeKey,
          cause: "runtime_terminal" as const,
          payload: candidate.payload,
        })),
        ...(retryAt === undefined ? {} : { retryAt }),
        ...(unresolved.some((diagnostic) => diagnostic.state === "needs_attention")
          ? { needsAttention: true }
          : {}),
      };
    }
    const unresolved = this.store.listGraphDiagnostics(graphId, { unresolvedOnly: true });
    const retryAt = unresolved
      .flatMap((diagnostic) => diagnostic.nextRetryAt ?? [])
      .sort((left, right) => left - right)[0];
    return {
      quiescent: result.errors.length > 0 ? true : result.quiescent,
      wakeCandidates: result.wakeCandidates.map((candidate) => ({
        dedupeKey: candidate.dedupeKey,
        cause: "runtime_terminal" as const,
        payload: candidate.payload,
      })),
      ...(retryAt === undefined ? {} : { retryAt }),
      ...(unresolved.some((diagnostic) => diagnostic.state === "needs_attention")
        ? { needsAttention: true }
        : {}),
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

  cancelYieldInterestIfRegistered(permitId: string): "registered" | "consumed" | "cancelled" {
    const current = this.store.getYieldInterest(permitId);
    if (!current) throw new Error(`Yield permit ${permitId} was not persisted`);
    if (current.state !== "registered") return current.state;
    try {
      return this.store.cancelYieldInterest({
        permitId,
        expectedVersion: current.version,
      }).record.state;
    } catch (error) {
      const raced = this.store.getYieldInterest(permitId);
      if (raced && raced.state !== "registered") return raced.state;
      throw error;
    }
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
    private readonly runtime: AgentGraphRuntimePortBridge,
    private readonly drive: SqliteAgentGraphDriveBridge,
    private readonly supervisor: AgentGraphSupervisorService,
    private readonly operatorProfileCatalog: AgentGraphOperatorProfileCatalog,
    private readonly validateWorkspacePolicy?: (policy: AgentGraphWorkspacePolicy) => void,
    private readonly onAsyncError?: AgentGraphSupervisorServiceOptions["onError"],
  ) {}

  async commitUpdate(input: CommitAgentGraphUpdateInput): Promise<CommitAgentGraphUpdateResult> {
    const commands = this.materializeCommands(input);
    const graph = this.requireBoundGraph(input.graphId, input.source.sessionId, input.epoch);
    if (graph.rootSessionId !== input.source.sessionId) {
      throw new Error(`Graph ${input.graphId} does not belong to update source Session`);
    }
    const committed = this.control.commitScheduleRevision({
      graphId: input.graphId,
      expectedPreviousRevision: input.expectedRevision,
      operationId: input.operationId,
      source: input.source,
      commands,
    });
    // Schedule delivery is asynchronous: update_agent_graph never waits in the
    // tool stack for an Operator/provider execution.
    void this.supervisor
      .notifyGraph(input.graphId)
      .catch((error) => this.onAsyncError?.(error, { graphId: input.graphId }));
    return {
      revision: committed.record.revision,
      replayed: committed.replayed,
      projection: this.readProjectionSync(input.graphId, input.source.sessionId, input.epoch),
    };
  }

  async readProjection(input: ReadAgentGraphProjectionInput): Promise<AgentGraphSupervisorView> {
    this.requireBoundGraph(input.graphId, input.rootSessionId, input.epoch);
    const projection = this.readProjectionSync(input.graphId, input.rootSessionId, input.epoch);
    const state = this.control.getScheduleState(input.graphId);
    const selectedRecords = this.selectViewRecords(
      input.graphId,
      projection.records,
      input.recordIds,
    );
    const [handoff, runtimeClaims, intentReadiness] = await Promise.all([
      this.runtime.resolveRecordHandoff(selectedRecords),
      Promise.all(
        projection.claims.map(async (claim) => {
          const runtime = await this.runtime.observeActivation(claim);
          return {
            claimId: claim.claimId,
            status: runtime.status,
            ...(runtime.terminalEventId === undefined
              ? {}
              : { terminalEventId: runtime.terminalEventId }),
            outputEventIds: runtime.records.map((record) => record.sourceEventId),
          };
        }),
      ),
      Promise.all(
        state.intents.map(async (intent) => {
          const facts = await this.runtime.resolveInputFacts({
            intent,
            knownRecords: projection.records,
            claims: projection.claims,
            producerIntents: state.intents,
            failedIntentIds: state.intents
              .filter((candidate) => isIntentStopped(state, candidate))
              .map((candidate) => candidate.intentId),
          });
          const readiness = resolveIntentReadiness(intent, facts);
          return {
            intentId: intent.intentId,
            status: readiness.status,
            resolvedRecordIds: readiness.resolvedRecords.map((record) => record.recordId),
            inFlightRecordIds: readiness.inFlightRecordIds,
            failedRecordIds: readiness.failedRecordIds,
            unknownRecordIds: readiness.unknownRecordIds,
          };
        }),
      ),
    ]);
    return {
      ...projection,
      availableOperatorProfiles: this.operatorProfileCatalog.listPublicProfiles(),
      intentReadiness,
      runtimeClaims,
      results: {
        records: handoff.records,
        totalBytes: handoff.totalBytes,
        truncated: handoff.truncated,
      },
    };
  }

  async registerYield(input: RegisterAgentGraphYieldInput): Promise<RegisterAgentGraphYieldResult> {
    this.requireBoundGraph(input.graphId, input.rootSessionId, input.epoch);
    // Acquire future progress before allocating the root-Run-unique permit. A
    // rejected preflight must leave the same root Run free to repair its
    // schedule and yield again with a new tool call.
    await this.supervisor.notifyGraph(input.graphId);
    const preflight = await this.drive.readYieldSnapshot(input.graphId);
    if (preflight.phase === "finished" || preflight.executing === 0) {
      throw new Error("Agent Graph 没有可等待的未来进展；请先更新/完成 Graph，不要无期限 yield。");
    }
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
        snapshot: this.readProjectionSync(input.graphId, input.rootSessionId, input.epoch),
      };
    } catch (error) {
      const interest = this.store.getYieldInterest(permitId);
      if (interest?.state === "registered") {
        try {
          this.drive.cancelYieldInterestIfRegistered(permitId);
        } catch {
          // Preserve the original application error; a concurrent terminal may
          // have consumed this permit and durably admitted its Wake.
        }
      }
      this.drive.consumeYieldReplayFlag(permitId);
      throw error;
    }
  }

  cancelYield(permitId: string, rootSessionId: string): void {
    const interest = this.store.getYieldInterest(permitId);
    if (!interest) return;
    if (interest.rootSessionId !== rootSessionId) {
      throw new Error(`Yield permit ${permitId} does not belong to root Session`);
    }
    this.drive.cancelYieldInterestIfRegistered(permitId);
  }

  private readProjectionSync(
    graphId: string,
    rootSessionId: string,
    epoch: number,
  ): AgentGraphSupervisorProjection {
    this.requireBoundGraph(graphId, rootSessionId, epoch);
    const state = this.control.getScheduleState(graphId);
    return {
      graph: state.graph,
      operators: state.operators.map(({ profileSnapshot, ...operator }) => ({
        ...operator,
        profile: {
          profileId: profileSnapshot.profileId,
          revision: profileSnapshot.profileRevision,
        },
      })),
      intents: state.intents,
      stops: state.stops,
      provisions: this.control
        .listOperatorProvisions(graphId)
        .map(({ profileSnapshot, ...provision }) => ({
          ...provision,
          profile: {
            profileId: profileSnapshot.profileId,
            revision: profileSnapshot.profileRevision,
          },
        })),
      claims: this.control.listActivationClaims(graphId),
      records: this.control.listRecordRefs(graphId),
    };
  }

  private materializeCommands(
    input: CommitAgentGraphUpdateInput,
  ): readonly AgentGraphScheduleCommand[] {
    return input.commands.map((command) => {
      if (command.kind !== "add") return command;
      this.validateWorkspacePolicy?.(command.operator.workspacePolicy);
      const { profileId, ...operator } = command.operator;
      return {
        kind: "add" as const,
        operator: {
          ...operator,
          profileSnapshot: this.operatorProfileCatalog.resolve({
            profileId,
            rootModelRouteId: input.rootModelRouteId,
          }),
        },
        intent: command.intent,
      };
    });
  }

  private selectViewRecords(
    graphId: string,
    records: AgentGraphSupervisorProjection["records"],
    requestedRecordIds: readonly string[] | undefined,
  ): AgentGraphSupervisorProjection["records"] {
    if (requestedRecordIds === undefined) return records;
    const current = new Map(records.map((record) => [record.recordId, record]));
    return requestedRecordIds.map((recordId) => {
      const stored = this.store.getRecordRef(recordId);
      if (!stored) throw new Error(`Graph RecordRef does not exist: ${recordId}`);
      if (stored.graphId !== graphId) {
        throw new Error(`Graph RecordRef ${recordId} belongs to another Graph`);
      }
      const record = current.get(recordId);
      if (!record) {
        throw new Error(`Graph RecordRef ${recordId} is missing from its control projection`);
      }
      return record;
    });
  }

  private requireBoundGraph(graphId: string, rootSessionId: string, epoch: number) {
    const graph = this.store.getGraph(graphId);
    if (!graph || graph.rootSessionId !== rootSessionId || graph.epoch !== epoch) {
      throw new Error(
        `Graph ${graphId} does not match root Session ${rootSessionId} epoch ${epoch}`,
      );
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
  const now = options.now ?? Date.now;
  const drive = new SqliteAgentGraphDriveBridge(options.store, control, reconciler, runtime, now);
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
    runtime,
    drive,
    supervisor,
    options.operatorProfileCatalog ?? createBuiltinAgentGraphOperatorProfileCatalog(),
    options.validateWorkspacePolicy,
    options.onError,
  );
  let closed = false;
  return {
    toolPort,
    drivePort: drive,
    supervisor,
    openRootEpoch: (rootSessionId) => {
      const opened = options.store.openRootEpoch(rootSessionId);
      return control.getScheduleState(opened.record.graphId).graph;
    },
    recoverFailedRootRun: async (input) => {
      const graph = options.store.getGraph(input.graphId);
      if (
        !graph ||
        graph.rootSessionId !== input.rootSessionId ||
        graph.phase !== "open" ||
        graph.headRevision === 0
      ) {
        return false;
      }
      const permitId = yieldPermitId(input);
      drive.prepareYield(input, permitId);
      try {
        await supervisor.registerYield({
          permitId,
          graphId: input.graphId,
          rootSessionId: input.rootSessionId,
          rootRunId: input.rootRunId,
        });
        drive.consumeYieldReplayFlag(permitId);
        return true;
      } catch (error) {
        drive.consumeYieldReplayFlag(permitId);
        throw error;
      }
    },
    sealEmptyRootEpoch: (rootSessionId) => {
      const graph = options.store.getOpenRootEpoch(rootSessionId);
      if (!graph || graph.headRevision !== 0) return false;
      control.commitScheduleRevision({
        graphId: graph.graphId,
        expectedPreviousRevision: 0,
        operationId: `host-empty-epoch:${graph.graphId}`,
        source: hostLifecycleSource(rootSessionId, graph.graphId, "empty-epoch"),
        commands: [{ kind: "finish", selectedRecordIds: [] }],
      });
      return true;
    },
    retireRootSession: async (rootSessionId, reason) => {
      const graph = options.store.getOpenRootEpoch(rootSessionId);
      if (!graph) return false;
      const state = control.getScheduleState(graph.graphId);
      const stoppedOperators = new Set(
        state.stops.flatMap((stop) =>
          stop.target.kind === "operator"
            ? [`${stop.target.operatorId}\u0000${stop.target.generation}`]
            : [],
        ),
      );
      const commands: AgentGraphScheduleCommand[] = state.operators
        .filter(
          (operator) =>
            !stoppedOperators.has(`${operator.operatorId}\u0000${operator.generation}`),
        )
        .map((operator) => ({
          kind: "stop" as const,
          target: {
            kind: "operator" as const,
            operatorId: operator.operatorId,
            generation: operator.generation,
          },
          reason,
        }));
      commands.push({ kind: "finish", selectedRecordIds: [] });
      control.commitScheduleRevision({
        graphId: graph.graphId,
        expectedPreviousRevision: state.graph.headRevision,
        operationId: `host-retire-root:${graph.graphId}`,
        source: hostLifecycleSource(rootSessionId, graph.graphId, "retire-root"),
        commands,
      });
      await supervisor.notifyGraph(graph.graphId);
      return true;
    },
    retryRootWake: (wakeId) => supervisor.retryNeedsAttention(wakeId),
    start: () => supervisor.start(),
    close: async () => {
      if (closed) return;
      closed = true;
      await supervisor.close();
      await runtime.close();
    },
  };
}

function graphDiagnosticId(graphId: string, phase: string, subjectId: string): string {
  return `graph_diagnostic_${deterministicFingerprint({ graphId, phase, subjectId }).slice(
    "sha256:".length,
    39,
  )}`;
}

function dedupeReconcileErrors(
  errors: readonly AgentGraphReconcileError[],
): readonly AgentGraphReconcileError[] {
  const deduped = new Map<string, AgentGraphReconcileError>();
  for (const error of errors) deduped.set(`${error.phase}\u0000${error.subjectId}`, error);
  return [...deduped.values()];
}

function graphRetryDelayMs(attemptNumber: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(0, attemptNumber - 1), 6));
}

function hostLifecycleSource(
  rootSessionId: string,
  graphId: string,
  action: string,
): AgentGraphOperationSource {
  return {
    sessionId: rootSessionId,
    turnId: `host-turn:${graphId}`,
    runId: `host-run:${graphId}`,
    toolCallId: `host-${action}:${graphId}`,
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
