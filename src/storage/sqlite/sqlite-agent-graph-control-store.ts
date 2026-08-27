import { resolve } from "node:path";
import { agentOutputRecordIdFor, graphIdFor } from "../../agent-graph/core/ids.js";
import type { OperationalDatabaseLease } from "./sqlite-database.js";
import { prepareCurrentWorkspaceSqliteStorageSync } from "./workspace-scopes.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphClaimState,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecord,
  AgentGraphRecordRefRecord,
  AgentGraphResourceRefRecord,
  AgentGraphScheduleRevisionRecord,
  AgentGraphSupervisorWakeAttemptRecord,
  AgentGraphSupervisorWakeRecord,
  AgentGraphYieldInterestRecord,
  CancelAgentGraphYieldInterestInput,
  ClaimAgentGraphActivationInput,
  ClaimAgentGraphSupervisorWakeInput,
  ClaimAgentGraphSupervisorWakeResult,
  CommitAgentGraphScheduleInput,
  CommitAgentGraphScheduleResult,
  CreateAgentGraphInput,
  EnqueueAgentGraphSupervisorWakeInput,
  EnqueueAgentGraphSupervisorWakeForYieldResult,
  EnsureAgentGraphOperatorProvisionInput,
  IdempotentStoreResult,
  PutAgentGraphRecordRefInput,
  PutAgentGraphResourceRefInput,
  RegisterAgentGraphYieldInterestInput,
  RecoverableAgentGraphSupervisorWakeRecord,
  SettleAgentGraphSupervisorWakeInput,
  SettleAgentGraphSupervisorWakeResult,
  TransitionAgentGraphClaimInput,
  TransitionAgentGraphProvisionInput,
} from "./agent-graph-store-types.js";

export * from "./agent-graph-store-types.js";

export class AgentGraphStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGraphStoreConflictError";
  }
}

export interface SqliteAgentGraphControlStoreOptions {
  /** Canonical workspace storage root holding pico.sqlite. */
  readonly storageRoot: string;
  readonly now?: () => number;
}

/**
 * Graph scheduling authority backed by the workspace operational database.
 *
 * Every competing mutation executes through the shared database owner's write
 * transaction, which is BEGIN IMMEDIATE. Cross-process callers therefore
 * re-read graph revision/state only after acquiring SQLite's writer lock.
 */
export class SqliteAgentGraphControlStore {
  readonly storageRoot: string;
  private readonly lease: OperationalDatabaseLease;
  private readonly now: () => number;
  private open = true;

  constructor(options: SqliteAgentGraphControlStoreOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("AgentGraph store storageRoot must not be empty");
    }
    const preparation = prepareCurrentWorkspaceSqliteStorageSync(resolve(options.storageRoot));
    this.lease = preparation.lease;
    this.storageRoot = preparation.rootIdentity.canonicalPath;
    this.now = options.now ?? Date.now;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.lease.release();
  }

  createGraph(input: CreateAgentGraphInput): IdempotentStoreResult<AgentGraphRecord> {
    const graphId = requireNonEmpty(input.graphId, "graphId");
    const rootSessionId = requireNonEmpty(input.rootSessionId, "rootSessionId");
    requirePositiveInteger(input.epoch, "epoch");
    return this.write(() => {
      const byId = this.selectGraph(graphId);
      if (byId) {
        if (byId.rootSessionId !== rootSessionId || byId.epoch !== input.epoch) {
          throw new AgentGraphStoreConflictError(
            `Graph ${graphId} is already bound to different immutable metadata`,
          );
        }
        return { record: byId, replayed: true };
      }
      const byEpoch = this.selectGraphByEpoch(rootSessionId, input.epoch);
      if (byEpoch) {
        throw new AgentGraphStoreConflictError(
          `Root session ${rootSessionId} epoch ${input.epoch} is already bound to graph ${byEpoch.graphId}`,
        );
      }
      const openGraph = this.selectOpenGraphByRoot(rootSessionId);
      if (openGraph) {
        throw new AgentGraphStoreConflictError(
          `Root session ${rootSessionId} already has open graph ${openGraph.graphId}`,
        );
      }
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graphs
           (graph_id, root_session_id, epoch, phase, head_revision, created_at, finished_at)
           VALUES (?, ?, ?, 'open', 0, ?, NULL)`,
        )
        .run(graphId, rootSessionId, input.epoch, createdAt);
      return { record: this.requireGraph(graphId), replayed: false };
    });
  }

  getGraph(graphId: string): AgentGraphRecord | undefined {
    return this.read(() => this.selectGraph(requireNonEmpty(graphId, "graphId")));
  }

  getOpenRootEpoch(rootSessionId: string): AgentGraphRecord | undefined {
    return this.read(() =>
      this.selectOpenGraphByRoot(requireNonEmpty(rootSessionId, "rootSessionId")),
    );
  }

  openRootEpoch(rootSessionId: string): IdempotentStoreResult<AgentGraphRecord> {
    const normalizedRootSessionId = requireNonEmpty(rootSessionId, "rootSessionId");
    return this.write(() => {
      const existing = this.selectOpenGraphByRoot(normalizedRootSessionId);
      if (existing) return { record: existing, replayed: true };
      const row = this.lease.database
        .prepare(
          `SELECT COALESCE(MAX(epoch), 0) AS max_epoch
           FROM agent_graphs WHERE root_session_id = ?`,
        )
        .get(normalizedRootSessionId);
      const epoch = rowNumber(asRow(row), "max_epoch") + 1;
      requirePositiveInteger(epoch, "epoch");
      const graphId = graphIdFor(normalizedRootSessionId, epoch);
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graphs
           (graph_id, root_session_id, epoch, phase, head_revision, created_at, finished_at)
           VALUES (?, ?, ?, 'open', 0, ?, NULL)`,
        )
        .run(graphId, normalizedRootSessionId, epoch, createdAt);
      return { record: this.requireGraph(graphId), replayed: false };
    });
  }

  listGraphs(rootSessionId?: string): readonly AgentGraphRecord[] {
    return this.read(() => {
      const rows = rootSessionId
        ? this.lease.database
            .prepare(
              `SELECT * FROM agent_graphs WHERE root_session_id = ?
               ORDER BY epoch ASC, graph_id ASC`,
            )
            .all(requireNonEmpty(rootSessionId, "rootSessionId"))
        : this.lease.database
            .prepare("SELECT * FROM agent_graphs ORDER BY root_session_id ASC, epoch ASC")
            .all();
      return rows.map((row) => graphFromRow(asRow(row)));
    });
  }

  commitScheduleRevision(input: CommitAgentGraphScheduleInput): CommitAgentGraphScheduleResult {
    const normalized = normalizeScheduleInput(input);
    return this.write(() => {
      const existing = this.selectScheduleByOperation(normalized.graphId, normalized.operationId);
      if (existing) {
        if (existing.requestFingerprint !== normalized.requestFingerprint) {
          throw new AgentGraphStoreConflictError(
            `Graph operation ${normalized.operationId} is already bound to another fingerprint`,
          );
        }
        return {
          revision: existing,
          graph: this.requireGraph(normalized.graphId),
          replayed: true,
        };
      }

      const graph = this.requireGraph(normalized.graphId);
      if (graph.phase === "finished" && normalized.kind !== "stop") {
        throw new AgentGraphStoreConflictError(
          `Graph ${normalized.graphId} is finished and rejects schedule updates`,
        );
      }
      if (graph.headRevision !== normalized.expectedRevision) {
        throw new AgentGraphStoreConflictError(
          `Graph ${normalized.graphId} revision changed from ${normalized.expectedRevision} to ${graph.headRevision}`,
        );
      }
      this.assertInputRecordRefs(normalized.graphId, normalized.inputRecordIds, normalized.command);
      if (normalized.kind === "finish") {
        this.assertSelectedRecordRefs(normalized.graphId, normalized.selectedRecordIds);
      }

      const revision = graph.headRevision + 1;
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_schedule_revisions
           (graph_id, revision, operation_id, request_fingerprint, kind, command_json,
            source_session_id, source_turn_id, source_run_id, source_tool_call_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.graphId,
          revision,
          normalized.operationId,
          normalized.requestFingerprint,
          normalized.kind,
          normalized.commandJson,
          normalized.sourceSessionId,
          normalized.sourceTurnId,
          normalized.sourceRunId,
          normalized.sourceToolCallId,
          createdAt,
        );
      if (graph.phase === "finished") {
        this.lease.database
          .prepare(
            `UPDATE agent_graphs SET head_revision = ?
             WHERE graph_id = ? AND head_revision = ? AND phase = 'finished'`,
          )
          .run(revision, normalized.graphId, normalized.expectedRevision);
      } else if (normalized.kind === "finish") {
        this.lease.database
          .prepare(
            `UPDATE agent_graphs
             SET head_revision = ?, phase = 'finished', finished_at = ?
             WHERE graph_id = ? AND head_revision = ? AND phase = 'open'`,
          )
          .run(revision, createdAt, normalized.graphId, normalized.expectedRevision);
      } else {
        this.lease.database
          .prepare(
            `UPDATE agent_graphs SET head_revision = ?
             WHERE graph_id = ? AND head_revision = ? AND phase = 'open'`,
          )
          .run(revision, normalized.graphId, normalized.expectedRevision);
      }
      return {
        revision: this.requireScheduleRevision(normalized.graphId, revision),
        graph: this.requireGraph(normalized.graphId),
        replayed: false,
      };
    });
  }

  listScheduleRevisions(graphId: string): readonly AgentGraphScheduleRevisionRecord[] {
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_schedule_revisions
           WHERE graph_id = ? ORDER BY revision ASC`,
        )
        .all(requireNonEmpty(graphId, "graphId"))
        .map((row) => scheduleFromRow(asRow(row))),
    );
  }

  ensureOperatorProvision(
    input: EnsureAgentGraphOperatorProvisionInput,
  ): IdempotentStoreResult<AgentGraphOperatorProvisionRecord> {
    const normalized = normalizeProvisionInput(input);
    return this.write(() => {
      const byIdentity = this.selectProvision(
        normalized.graphId,
        normalized.operatorId,
        normalized.generation,
      );
      if (byIdentity) return replayProvision(byIdentity, normalized);
      const byId = this.selectProvisionById(normalized.provisionId);
      if (byId) {
        throw new AgentGraphStoreConflictError(
          `Provision ${normalized.provisionId} is already bound to another operator`,
        );
      }
      const graph = this.requireGraph(normalized.graphId);
      if (graph.phase !== "open") {
        throw new AgentGraphStoreConflictError(
          `Graph ${normalized.graphId} is finished and rejects fresh provisions`,
        );
      }
      this.requireScheduleRevision(normalized.graphId, normalized.scheduleRevision);
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_operator_provisions
           (provision_id, graph_id, operator_id, generation, schedule_revision,
            provision_fingerprint, child_session_id, profile_snapshot_json,
            workspace_binding_json, state, version, created_at, provisioned_at, stopped_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 1, ?, NULL, NULL)`,
        )
        .run(
          normalized.provisionId,
          normalized.graphId,
          normalized.operatorId,
          normalized.generation,
          normalized.scheduleRevision,
          normalized.provisionFingerprint,
          normalized.childSessionId,
          normalized.profileSnapshotJson,
          normalized.workspaceBindingJson,
          createdAt,
        );
      return {
        record: this.requireProvision(
          normalized.graphId,
          normalized.operatorId,
          normalized.generation,
        ),
        replayed: false,
      };
    });
  }

  transitionOperatorProvision(
    input: TransitionAgentGraphProvisionInput,
  ): IdempotentStoreResult<AgentGraphOperatorProvisionRecord> {
    const provisionId = requireNonEmpty(input.provisionId, "provisionId");
    requirePositiveInteger(input.expectedVersion, "expectedVersion");
    assertProvisionTransition(input.from, input.to);
    return this.write(() => {
      const current = this.selectProvisionById(provisionId);
      if (!current) {
        throw new AgentGraphStoreConflictError(`Provision ${provisionId} does not exist`);
      }
      if (current.state === input.to) return { record: current, replayed: true };
      if (current.state !== input.from || current.version !== input.expectedVersion) {
        throw new AgentGraphStoreConflictError(
          `Provision ${provisionId} state/version changed from ${input.from}@${input.expectedVersion} to ${current.state}@${current.version}`,
        );
      }
      const now = this.now();
      if (input.to === "provisioned") {
        this.lease.database
          .prepare(
            `UPDATE agent_graph_operator_provisions
             SET state = 'provisioned', version = version + 1, provisioned_at = ?
             WHERE provision_id = ? AND state = ? AND version = ?`,
          )
          .run(now, provisionId, input.from, input.expectedVersion);
      } else if (input.to === "stopping") {
        this.lease.database
          .prepare(
            `UPDATE agent_graph_operator_provisions
             SET state = 'stopping', version = version + 1
             WHERE provision_id = ? AND state = ? AND version = ?`,
          )
          .run(provisionId, input.from, input.expectedVersion);
      } else {
        this.lease.database
          .prepare(
            `UPDATE agent_graph_operator_provisions
             SET state = 'stopped', version = version + 1, stopped_at = ?
             WHERE provision_id = ? AND state = ? AND version = ?`,
          )
          .run(now, provisionId, input.from, input.expectedVersion);
      }
      const updated = this.selectProvisionById(provisionId);
      if (!updated) throw new AgentGraphStoreConflictError(`Provision ${provisionId} disappeared`);
      return { record: updated, replayed: false };
    });
  }

  getOperatorProvision(
    graphId: string,
    operatorId: string,
    generation: number,
  ): AgentGraphOperatorProvisionRecord | undefined {
    requirePositiveInteger(generation, "generation");
    return this.read(() =>
      this.selectProvision(
        requireNonEmpty(graphId, "graphId"),
        requireNonEmpty(operatorId, "operatorId"),
        generation,
      ),
    );
  }

  listOperatorProvisions(graphId: string): readonly AgentGraphOperatorProvisionRecord[] {
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_operator_provisions
           WHERE graph_id = ? ORDER BY created_at ASC, provision_id ASC`,
        )
        .all(requireNonEmpty(graphId, "graphId"))
        .map((row) => provisionFromRow(asRow(row))),
    );
  }

  claimActivation(
    input: ClaimAgentGraphActivationInput,
  ): IdempotentStoreResult<AgentGraphActivationClaimRecord> {
    const normalized = normalizeClaimInput(input);
    return this.write(() => {
      const byIntent = this.selectClaimByIntent(normalized.graphId, normalized.intentId);
      if (byIntent) return replayClaim(byIntent, normalized);
      const byId = this.selectClaim(normalized.claimId);
      if (byId) {
        throw new AgentGraphStoreConflictError(
          `Claim ${normalized.claimId} is already bound to another activation intent`,
        );
      }
      const graph = this.requireGraph(normalized.graphId);
      if (graph.phase !== "open") {
        throw new AgentGraphStoreConflictError(
          `Graph ${normalized.graphId} is finished and rejects fresh activation claims`,
        );
      }
      if (graph.headRevision !== normalized.expectedGraphRevision) {
        throw new AgentGraphStoreConflictError(
          `Graph ${normalized.graphId} revision changed from ${normalized.expectedGraphRevision} to ${graph.headRevision}`,
        );
      }
      const provision = this.requireProvision(
        normalized.graphId,
        normalized.operatorId,
        normalized.operatorGeneration,
      );
      if (provision.childSessionId !== normalized.targetSessionId) {
        throw new AgentGraphStoreConflictError(
          `Activation ${normalized.intentId} target session does not match its operator provision`,
        );
      }
      if (provision.state !== "provisioned") {
        throw new AgentGraphStoreConflictError(
          `Activation ${normalized.intentId} operator provision is ${provision.state}, not provisioned`,
        );
      }
      const claimedAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_activation_claims
           (claim_id, graph_id, intent_id, operator_id, operator_generation,
            schedule_revision, intent_fingerprint, readiness_fingerprint, state,
            target_session_id, target_turn_id, target_run_id, target_invocation_id,
            run_started_event_id, version, claimed_at, executing_at, cancelled_at,
            cancellation_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL)`,
        )
        .run(
          normalized.claimId,
          normalized.graphId,
          normalized.intentId,
          normalized.operatorId,
          normalized.operatorGeneration,
          normalized.expectedGraphRevision,
          normalized.intentFingerprint,
          normalized.readinessFingerprint,
          normalized.targetSessionId,
          normalized.targetTurnId,
          normalized.targetRunId,
          normalized.targetInvocationId,
          normalized.runStartedEventId,
          claimedAt,
        );
      return { record: this.requireClaim(normalized.claimId), replayed: false };
    });
  }

  getActivationClaim(claimId: string): AgentGraphActivationClaimRecord | undefined {
    return this.read(() => this.selectClaim(requireNonEmpty(claimId, "claimId")));
  }

  listActivationClaims(graphId: string): readonly AgentGraphActivationClaimRecord[] {
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_activation_claims
           WHERE graph_id = ? ORDER BY claimed_at ASC, claim_id ASC`,
        )
        .all(requireNonEmpty(graphId, "graphId"))
        .map((row) => claimFromRow(asRow(row))),
    );
  }

  transitionActivationClaim(
    input: TransitionAgentGraphClaimInput,
  ): IdempotentStoreResult<AgentGraphActivationClaimRecord> {
    const claimId = requireNonEmpty(input.claimId, "claimId");
    requirePositiveInteger(input.expectedVersion, "expectedVersion");
    assertClaimTransition(input.from, input.to);
    const cancellationReason = optionalNonEmpty(input.cancellationReason, "cancellationReason");
    if (input.to === "executing" && cancellationReason !== undefined) {
      throw new Error("executing transition must not include cancellationReason");
    }
    return this.write(() => {
      const current = this.requireClaim(claimId);
      if (current.state === input.to) {
        if (input.to === "cancelled" && current.cancellationReason !== cancellationReason) {
          throw new AgentGraphStoreConflictError(
            `Claim ${claimId} cancellation is already bound to another reason`,
          );
        }
        return { record: current, replayed: true };
      }
      if (current.state !== input.from || current.version !== input.expectedVersion) {
        throw new AgentGraphStoreConflictError(
          `Claim ${claimId} state/version changed from ${input.from}@${input.expectedVersion} to ${current.state}@${current.version}`,
        );
      }
      const now = this.now();
      if (input.to === "executing") {
        this.lease.database
          .prepare(
            `UPDATE agent_graph_activation_claims
             SET state = 'executing', executing_at = ?, version = version + 1
             WHERE claim_id = ? AND state = ? AND version = ?`,
          )
          .run(now, claimId, input.from, input.expectedVersion);
      } else {
        this.lease.database
          .prepare(
            `UPDATE agent_graph_activation_claims
             SET state = 'cancelled', cancelled_at = ?, cancellation_reason = ?, version = version + 1
             WHERE claim_id = ? AND state = ? AND version = ?`,
          )
          .run(now, cancellationReason ?? null, claimId, input.from, input.expectedVersion);
      }
      return { record: this.requireClaim(claimId), replayed: false };
    });
  }

  putRecordRef(
    input: PutAgentGraphRecordRefInput,
  ): IdempotentStoreResult<AgentGraphRecordRefRecord> {
    const normalized = normalizeRecordRefInput(input);
    return this.write(() => {
      const byId = this.selectRecordRef(normalized.recordId);
      if (byId) return replayRecordRef(byId, normalized);
      const bySource = this.selectRecordRefBySource(normalized.graphId, normalized.sourceEventId);
      if (bySource) {
        return replayRecordRef(bySource, normalized);
      }
      const claim = this.requireClaim(normalized.claimId);
      if (
        claim.graphId !== normalized.graphId ||
        claim.operatorId !== normalized.operatorId ||
        claim.operatorGeneration !== normalized.operatorGeneration ||
        claim.targetSessionId !== normalized.sourceSessionId ||
        claim.targetTurnId !== normalized.sourceTurnId ||
        claim.targetRunId !== normalized.sourceRunId
      ) {
        throw new AgentGraphStoreConflictError(
          `Record ${normalized.recordId} source identity does not match claim ${normalized.claimId}`,
        );
      }
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_record_refs
           (record_id, graph_id, claim_id, operator_id, operator_generation,
            record_fingerprint, source_session_id, source_turn_id, source_run_id,
            source_event_id, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.recordId,
          normalized.graphId,
          normalized.claimId,
          normalized.operatorId,
          normalized.operatorGeneration,
          normalized.recordFingerprint,
          normalized.sourceSessionId,
          normalized.sourceTurnId,
          normalized.sourceRunId,
          normalized.sourceEventId,
          normalized.kind,
          createdAt,
        );
      return { record: this.requireRecordRef(normalized.recordId), replayed: false };
    });
  }

  getRecordRef(recordId: string): AgentGraphRecordRefRecord | undefined {
    return this.read(() => this.selectRecordRef(requireNonEmpty(recordId, "recordId")));
  }

  listRecordRefs(graphId: string): readonly AgentGraphRecordRefRecord[] {
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_record_refs
           WHERE graph_id = ? ORDER BY created_at ASC, record_id ASC`,
        )
        .all(requireNonEmpty(graphId, "graphId"))
        .map((row) => recordRefFromRow(asRow(row))),
    );
  }

  putResourceRef(
    input: PutAgentGraphResourceRefInput,
  ): IdempotentStoreResult<AgentGraphResourceRefRecord> {
    const normalized = normalizeResourceRefInput(input);
    return this.write(() => {
      const byId = this.selectResourceRef(normalized.resourceId);
      if (byId) return replayResourceRef(byId, normalized);
      const bySource = this.selectResourceRefBySource(
        normalized.claimId,
        normalized.kind,
        normalized.sourceRef,
      );
      if (bySource) return replayResourceRef(bySource, normalized);
      const claim = this.requireClaim(normalized.claimId);
      if (
        claim.graphId !== normalized.graphId ||
        claim.targetSessionId !== normalized.sourceSessionId
      ) {
        throw new AgentGraphStoreConflictError(
          `Resource ${normalized.resourceId} source identity does not match claim ${normalized.claimId}`,
        );
      }
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_resource_refs
           (resource_id, graph_id, claim_id, kind, source_ref, source_session_id,
            source_resource_id, content_digest, content_bytes, media_type, title,
            metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.resourceId,
          normalized.graphId,
          normalized.claimId,
          normalized.kind,
          normalized.sourceRef,
          normalized.sourceSessionId,
          normalized.sourceResourceId,
          normalized.contentDigest,
          normalized.contentBytes,
          normalized.mediaType ?? null,
          normalized.title ?? null,
          normalized.metadataJson,
          createdAt,
        );
      return { record: this.requireResourceRef(normalized.resourceId), replayed: false };
    });
  }

  listResourceRefsByClaim(claimId: string): readonly AgentGraphResourceRefRecord[] {
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_resource_refs
           WHERE claim_id = ? ORDER BY created_at ASC, resource_id ASC`,
        )
        .all(requireNonEmpty(claimId, "claimId"))
        .map((row) => resourceRefFromRow(asRow(row))),
    );
  }

  registerYieldInterest(
    input: RegisterAgentGraphYieldInterestInput,
  ): IdempotentStoreResult<AgentGraphYieldInterestRecord> {
    const normalized = normalizeYieldInterestInput(input);
    return this.write(() => {
      const byId = this.selectYieldInterest(normalized.permitId);
      if (byId) return replayYieldInterest(byId, normalized);
      const byRootRun = this.selectYieldInterestByRootRun(normalized.graphId, normalized.rootRunId);
      if (byRootRun) return replayYieldInterest(byRootRun, normalized);
      const graph = this.requireGraph(normalized.graphId);
      if (graph.rootSessionId !== normalized.rootSessionId) {
        throw new AgentGraphStoreConflictError(
          `Yield interest ${normalized.permitId} root session does not match graph ${graph.graphId}`,
        );
      }
      if (graph.phase !== "open") {
        throw new AgentGraphStoreConflictError(
          `Graph ${graph.graphId} is finished and rejects fresh yield interests`,
        );
      }
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_yield_interests
           (permit_id, graph_id, root_session_id, root_turn_id, root_run_id,
            tool_call_id, state, version, created_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, 'registered', 1, ?, NULL)`,
        )
        .run(
          normalized.permitId,
          normalized.graphId,
          normalized.rootSessionId,
          normalized.rootTurnId,
          normalized.rootRunId,
          normalized.toolCallId,
          createdAt,
        );
      return { record: this.requireYieldInterest(normalized.permitId), replayed: false };
    });
  }

  getYieldInterest(permitId: string): AgentGraphYieldInterestRecord | undefined {
    return this.read(() => this.selectYieldInterest(requireNonEmpty(permitId, "permitId")));
  }

  listYieldInterests(
    graphId: string,
    state?: AgentGraphYieldInterestRecord["state"],
  ): readonly AgentGraphYieldInterestRecord[] {
    return this.read(() => {
      const rows = state
        ? this.lease.database
            .prepare(
              `SELECT * FROM agent_graph_yield_interests
               WHERE graph_id = ? AND state = ? ORDER BY created_at ASC, permit_id ASC`,
            )
            .all(requireNonEmpty(graphId, "graphId"), state)
        : this.lease.database
            .prepare(
              `SELECT * FROM agent_graph_yield_interests
               WHERE graph_id = ? ORDER BY created_at ASC, permit_id ASC`,
            )
            .all(requireNonEmpty(graphId, "graphId"));
      return rows.map((row) => yieldInterestFromRow(asRow(row)));
    });
  }

  cancelYieldInterest(
    input: CancelAgentGraphYieldInterestInput,
  ): IdempotentStoreResult<AgentGraphYieldInterestRecord> {
    const permitId = requireNonEmpty(input.permitId, "permitId");
    requirePositiveInteger(input.expectedVersion, "expectedVersion");
    return this.write(() => {
      const current = this.requireYieldInterest(permitId);
      if (current.state === "cancelled") return { record: current, replayed: true };
      if (current.state !== "registered" || current.version !== input.expectedVersion) {
        throw new AgentGraphStoreConflictError(
          `Yield interest ${permitId} changed from registered@${input.expectedVersion} to ${current.state}@${current.version}`,
        );
      }
      this.lease.database
        .prepare(
          `UPDATE agent_graph_yield_interests
           SET state = 'cancelled', version = version + 1, resolved_at = ?
           WHERE permit_id = ? AND state = 'registered' AND version = ?`,
        )
        .run(this.now(), permitId, input.expectedVersion);
      return { record: this.requireYieldInterest(permitId), replayed: false };
    });
  }

  enqueueSupervisorWake(
    input: EnqueueAgentGraphSupervisorWakeInput,
  ): IdempotentStoreResult<AgentGraphSupervisorWakeRecord> {
    const normalized = normalizeWakeInput(input, this.now());
    return this.write(() => {
      const byDedupe = this.selectWakeByDedupe(normalized.graphId, normalized.dedupeKey);
      if (byDedupe) {
        if (byDedupe.wakeFingerprint !== normalized.wakeFingerprint) {
          throw new AgentGraphStoreConflictError(
            `Wake dedupe key ${normalized.dedupeKey} is already bound to another fingerprint`,
          );
        }
        return { record: byDedupe, replayed: true };
      }
      const byId = this.selectWake(normalized.wakeId);
      if (byId) {
        throw new AgentGraphStoreConflictError(
          `Wake ${normalized.wakeId} is already bound to another dedupe key`,
        );
      }
      this.requireGraph(normalized.graphId);
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_supervisor_wakes
           (wake_id, graph_id, dedupe_key, wake_fingerprint, cause, payload_json,
            status, available_at, attempt_count, version, created_at, updated_at,
            delivered_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, 1, ?, ?, NULL, NULL)`,
        )
        .run(
          normalized.wakeId,
          normalized.graphId,
          normalized.dedupeKey,
          normalized.wakeFingerprint,
          normalized.cause,
          normalized.payloadJson,
          normalized.availableAt,
          createdAt,
          createdAt,
        );
      return { record: this.requireWake(normalized.wakeId), replayed: false };
    });
  }

  enqueueSupervisorWakeForYield(
    input: EnqueueAgentGraphSupervisorWakeInput,
  ): EnqueueAgentGraphSupervisorWakeForYieldResult {
    const normalized = normalizeWakeInput(input, this.now());
    return this.write(() => {
      const byDedupe = this.selectWakeByDedupe(normalized.graphId, normalized.dedupeKey);
      if (byDedupe) {
        if (byDedupe.wakeFingerprint !== normalized.wakeFingerprint) {
          throw new AgentGraphStoreConflictError(
            `Wake dedupe key ${normalized.dedupeKey} is already bound to another fingerprint`,
          );
        }
        if (!byDedupe.yieldPermitId) {
          throw new AgentGraphStoreConflictError(
            `Wake ${byDedupe.wakeId} was not admitted by a yield interest`,
          );
        }
        return {
          status: "enqueued",
          wake: byDedupe,
          interest: this.requireYieldInterest(byDedupe.yieldPermitId),
          replayed: true,
        };
      }
      const byId = this.selectWake(normalized.wakeId);
      if (byId) {
        throw new AgentGraphStoreConflictError(
          `Wake ${normalized.wakeId} is already bound to another dedupe key`,
        );
      }
      const graph = this.requireGraph(normalized.graphId);
      if (graph.phase !== "open") return { status: "not_waiting" };
      const interest = this.selectRegisteredYieldInterest(normalized.graphId);
      if (!interest) return { status: "not_waiting" };
      const createdAt = this.now();
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_supervisor_wakes
           (wake_id, graph_id, dedupe_key, wake_fingerprint, cause, payload_json,
            status, available_at, attempt_count, version, created_at, updated_at,
            delivered_at, last_error, yield_permit_id)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, 1, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          normalized.wakeId,
          normalized.graphId,
          normalized.dedupeKey,
          normalized.wakeFingerprint,
          normalized.cause,
          normalized.payloadJson,
          normalized.availableAt,
          createdAt,
          createdAt,
          interest.permitId,
        );
      this.lease.database
        .prepare(
          `UPDATE agent_graph_yield_interests
           SET state = 'consumed', version = version + 1, resolved_at = ?
           WHERE permit_id = ? AND state = 'registered' AND version = ?`,
        )
        .run(createdAt, interest.permitId, interest.version);
      return {
        status: "enqueued",
        wake: this.requireWake(normalized.wakeId),
        interest: this.requireYieldInterest(interest.permitId),
        replayed: false,
      };
    });
  }

  getSupervisorWake(wakeId: string): AgentGraphSupervisorWakeRecord | undefined {
    return this.read(() => this.selectWake(requireNonEmpty(wakeId, "wakeId")));
  }

  listDueSupervisorWakes(at = this.now()): readonly AgentGraphSupervisorWakeRecord[] {
    requireFiniteNumber(at, "at");
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_supervisor_wakes
           WHERE status IN ('pending','retryable_failed') AND available_at <= ?
           ORDER BY available_at ASC, created_at ASC, wake_id ASC`,
        )
        .all(at)
        .map((row) => wakeFromRow(asRow(row))),
    );
  }

  listRecoverableSupervisorWakes(
    at = this.now(),
  ): readonly RecoverableAgentGraphSupervisorWakeRecord[] {
    requireFiniteNumber(at, "at");
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_supervisor_wakes
           WHERE status IN ('pending','retryable_failed','running','waiting_permission')
           ORDER BY
             CASE
               WHEN status IN ('pending','retryable_failed') AND available_at <= ? THEN 0
               WHEN status IN ('running','waiting_permission') THEN 1
               ELSE 2
             END,
             available_at ASC, created_at ASC, wake_id ASC`,
        )
        .all(at)
        .map((row) => this.recoverableWakeFromRecord(wakeFromRow(asRow(row)))),
    );
  }

  getRecoverableSupervisorWake(
    wakeId: string,
  ): RecoverableAgentGraphSupervisorWakeRecord | undefined {
    return this.read(() => {
      const wake = this.selectWake(requireNonEmpty(wakeId, "wakeId"));
      if (
        !wake ||
        !["pending", "retryable_failed", "running", "waiting_permission"].includes(wake.status)
      ) {
        return undefined;
      }
      return this.recoverableWakeFromRecord(wake);
    });
  }

  claimSupervisorWake(
    input: ClaimAgentGraphSupervisorWakeInput,
  ): ClaimAgentGraphSupervisorWakeResult {
    const normalized = normalizeWakeClaimInput(input);
    return this.write(() => {
      const existingAttempt = this.selectWakeAttempt(normalized.attemptId);
      if (existingAttempt) {
        if (
          existingAttempt.wakeId !== normalized.wakeId ||
          existingAttempt.rootSessionId !== normalized.rootSessionId ||
          existingAttempt.targetTurnId !== normalized.targetTurnId ||
          existingAttempt.targetRunId !== normalized.targetRunId
        ) {
          throw new AgentGraphStoreConflictError(
            `Wake attempt ${normalized.attemptId} is already bound to another target run`,
          );
        }
        return {
          wake: this.requireWake(normalized.wakeId),
          attempt: existingAttempt,
          replayed: true,
        };
      }
      const wake = this.requireWake(normalized.wakeId);
      const graph = this.requireGraph(wake.graphId);
      if (graph.rootSessionId !== normalized.rootSessionId) {
        throw new AgentGraphStoreConflictError(
          `Wake ${normalized.wakeId} root session does not match graph ${graph.graphId}`,
        );
      }
      if (wake.version !== normalized.expectedWakeVersion) {
        throw new AgentGraphStoreConflictError(
          `Wake ${normalized.wakeId} version changed from ${normalized.expectedWakeVersion} to ${wake.version}`,
        );
      }
      if (wake.status !== "pending" && wake.status !== "retryable_failed") {
        throw new AgentGraphStoreConflictError(
          `Wake ${normalized.wakeId} is ${wake.status} and cannot be claimed`,
        );
      }
      const now = this.now();
      if (wake.availableAt > now) {
        throw new AgentGraphStoreConflictError(
          `Wake ${normalized.wakeId} is unavailable until ${wake.availableAt}`,
        );
      }
      const attemptNumber = wake.attemptCount + 1;
      this.lease.database
        .prepare(
          `INSERT INTO agent_graph_supervisor_wake_attempts
           (attempt_id, wake_id, attempt_number, root_session_id, target_turn_id,
            target_run_id, status, version, started_at, updated_at, finished_at, error)
           VALUES (?, ?, ?, ?, ?, ?, 'running', 1, ?, ?, NULL, NULL)`,
        )
        .run(
          normalized.attemptId,
          normalized.wakeId,
          attemptNumber,
          normalized.rootSessionId,
          normalized.targetTurnId,
          normalized.targetRunId,
          now,
          now,
        );
      this.lease.database
        .prepare(
          `UPDATE agent_graph_supervisor_wakes
           SET status = 'running', attempt_count = ?, version = version + 1,
               updated_at = ?, last_error = NULL
           WHERE wake_id = ? AND version = ? AND status IN ('pending','retryable_failed')`,
        )
        .run(attemptNumber, now, normalized.wakeId, normalized.expectedWakeVersion);
      return {
        wake: this.requireWake(normalized.wakeId),
        attempt: this.requireWakeAttempt(normalized.attemptId),
        replayed: false,
      };
    });
  }

  settleSupervisorWake(
    input: SettleAgentGraphSupervisorWakeInput,
  ): SettleAgentGraphSupervisorWakeResult {
    const normalized = normalizeWakeSettlementInput(input);
    return this.write(() => {
      const wake = this.requireWake(normalized.wakeId);
      const attempt = this.requireWakeAttempt(normalized.attemptId);
      if (attempt.wakeId !== wake.wakeId) {
        throw new AgentGraphStoreConflictError(
          `Wake attempt ${attempt.attemptId} does not belong to wake ${wake.wakeId}`,
        );
      }
      const attemptOutcome = wakeAttemptStatusFor(normalized.outcome);
      if (wake.status === normalized.outcome && attempt.status === attemptOutcome) {
        if (
          attempt.error !== normalized.error ||
          (normalized.outcome === "retryable_failed" && wake.availableAt !== normalized.retryAt)
        ) {
          throw new AgentGraphStoreConflictError(
            `Wake attempt ${attempt.attemptId} is already settled with another error`,
          );
        }
        return { wake, attempt, replayed: true };
      }
      const settlingRunningAttempt = wake.status === "running" && attempt.status === "running";
      const resumingPermissionAttempt =
        wake.status === "waiting_permission" &&
        attempt.status === "waiting_permission" &&
        normalized.outcome !== "waiting_permission";
      if (
        (!settlingRunningAttempt && !resumingPermissionAttempt) ||
        wake.version !== normalized.expectedWakeVersion ||
        attempt.version !== normalized.expectedAttemptVersion
      ) {
        throw new AgentGraphStoreConflictError(
          `Wake ${wake.wakeId} or attempt ${attempt.attemptId} changed before settlement`,
        );
      }
      const now = this.now();
      this.lease.database
        .prepare(
          `UPDATE agent_graph_supervisor_wake_attempts
           SET status = ?, version = version + 1, updated_at = ?, finished_at = ?, error = ?
           WHERE attempt_id = ? AND status = ? AND version = ?`,
        )
        .run(
          attemptOutcome,
          now,
          normalized.outcome === "waiting_permission" ? null : now,
          normalized.error ?? null,
          normalized.attemptId,
          attempt.status,
          normalized.expectedAttemptVersion,
        );
      this.lease.database
        .prepare(
          `UPDATE agent_graph_supervisor_wakes
           SET status = ?, available_at = ?, version = version + 1, updated_at = ?,
               delivered_at = ?, last_error = ?
           WHERE wake_id = ? AND status = ? AND version = ?`,
        )
        .run(
          normalized.outcome,
          normalized.retryAt ?? wake.availableAt,
          now,
          normalized.outcome === "delivered" ? now : null,
          normalized.error ?? null,
          normalized.wakeId,
          wake.status,
          normalized.expectedWakeVersion,
        );
      return {
        wake: this.requireWake(normalized.wakeId),
        attempt: this.requireWakeAttempt(normalized.attemptId),
        replayed: false,
      };
    });
  }

  listSupervisorWakeAttempts(wakeId: string): readonly AgentGraphSupervisorWakeAttemptRecord[] {
    return this.read(() =>
      this.lease.database
        .prepare(
          `SELECT * FROM agent_graph_supervisor_wake_attempts
           WHERE wake_id = ? ORDER BY attempt_number ASC`,
        )
        .all(requireNonEmpty(wakeId, "wakeId"))
        .map((row) => wakeAttemptFromRow(asRow(row))),
    );
  }

  private selectGraph(graphId: string): AgentGraphRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graphs WHERE graph_id = ?")
      .get(graphId);
    return row ? graphFromRow(asRow(row)) : undefined;
  }

  private selectGraphByEpoch(rootSessionId: string, epoch: number): AgentGraphRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graphs WHERE root_session_id = ? AND epoch = ?")
      .get(rootSessionId, epoch);
    return row ? graphFromRow(asRow(row)) : undefined;
  }

  private selectOpenGraphByRoot(rootSessionId: string): AgentGraphRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graphs WHERE root_session_id = ? AND phase = 'open'")
      .get(rootSessionId);
    return row ? graphFromRow(asRow(row)) : undefined;
  }

  private requireGraph(graphId: string): AgentGraphRecord {
    const graph = this.selectGraph(graphId);
    if (!graph) throw new AgentGraphStoreConflictError(`Graph ${graphId} does not exist`);
    return graph;
  }

  private selectScheduleByOperation(
    graphId: string,
    operationId: string,
  ): AgentGraphScheduleRevisionRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_schedule_revisions
         WHERE graph_id = ? AND operation_id = ?`,
      )
      .get(graphId, operationId);
    return row ? scheduleFromRow(asRow(row)) : undefined;
  }

  private requireScheduleRevision(
    graphId: string,
    revision: number,
  ): AgentGraphScheduleRevisionRecord {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_schedule_revisions
         WHERE graph_id = ? AND revision = ?`,
      )
      .get(graphId, revision);
    if (!row) {
      throw new AgentGraphStoreConflictError(
        `Graph ${graphId} schedule revision ${revision} does not exist`,
      );
    }
    return scheduleFromRow(asRow(row));
  }

  private selectProvision(
    graphId: string,
    operatorId: string,
    generation: number,
  ): AgentGraphOperatorProvisionRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_operator_provisions
         WHERE graph_id = ? AND operator_id = ? AND generation = ?`,
      )
      .get(graphId, operatorId, generation);
    return row ? provisionFromRow(asRow(row)) : undefined;
  }

  private selectProvisionById(provisionId: string): AgentGraphOperatorProvisionRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_operator_provisions WHERE provision_id = ?")
      .get(provisionId);
    return row ? provisionFromRow(asRow(row)) : undefined;
  }

  private requireProvision(
    graphId: string,
    operatorId: string,
    generation: number,
  ): AgentGraphOperatorProvisionRecord {
    const provision = this.selectProvision(graphId, operatorId, generation);
    if (!provision) {
      throw new AgentGraphStoreConflictError(
        `Graph ${graphId} operator ${operatorId}@${generation} is not provisioned`,
      );
    }
    return provision;
  }

  private selectClaim(claimId: string): AgentGraphActivationClaimRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_activation_claims WHERE claim_id = ?")
      .get(claimId);
    return row ? claimFromRow(asRow(row)) : undefined;
  }

  private selectClaimByIntent(
    graphId: string,
    intentId: string,
  ): AgentGraphActivationClaimRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_activation_claims
         WHERE graph_id = ? AND intent_id = ?`,
      )
      .get(graphId, intentId);
    return row ? claimFromRow(asRow(row)) : undefined;
  }

  private requireClaim(claimId: string): AgentGraphActivationClaimRecord {
    const claim = this.selectClaim(claimId);
    if (!claim) throw new AgentGraphStoreConflictError(`Claim ${claimId} does not exist`);
    return claim;
  }

  private selectRecordRef(recordId: string): AgentGraphRecordRefRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_record_refs WHERE record_id = ?")
      .get(recordId);
    return row ? recordRefFromRow(asRow(row)) : undefined;
  }

  private selectRecordRefBySource(
    graphId: string,
    sourceEventId: string,
  ): AgentGraphRecordRefRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_record_refs
         WHERE graph_id = ? AND source_event_id = ?`,
      )
      .get(graphId, sourceEventId);
    return row ? recordRefFromRow(asRow(row)) : undefined;
  }

  private requireRecordRef(recordId: string): AgentGraphRecordRefRecord {
    const record = this.selectRecordRef(recordId);
    if (!record) throw new AgentGraphStoreConflictError(`Record ${recordId} does not exist`);
    return record;
  }

  private selectResourceRef(resourceId: string): AgentGraphResourceRefRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_resource_refs WHERE resource_id = ?")
      .get(resourceId);
    return row ? resourceRefFromRow(asRow(row)) : undefined;
  }

  private selectResourceRefBySource(
    claimId: string,
    kind: AgentGraphResourceRefRecord["kind"],
    sourceRef: string,
  ): AgentGraphResourceRefRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_resource_refs
         WHERE claim_id = ? AND kind = ? AND source_ref = ?`,
      )
      .get(claimId, kind, sourceRef);
    return row ? resourceRefFromRow(asRow(row)) : undefined;
  }

  private requireResourceRef(resourceId: string): AgentGraphResourceRefRecord {
    const resource = this.selectResourceRef(resourceId);
    if (!resource) {
      throw new AgentGraphStoreConflictError(`Resource ${resourceId} does not exist`);
    }
    return resource;
  }

  private assertSelectedRecordRefs(graphId: string, recordIds: readonly string[]): void {
    for (const recordId of recordIds) {
      const record = this.selectRecordRef(recordId);
      if (!record) {
        throw new AgentGraphStoreConflictError(
          `Selected RecordRef ${recordId} does not exist for Graph ${graphId}`,
        );
      }
      if (record.graphId !== graphId) {
        throw new AgentGraphStoreConflictError(
          `Selected RecordRef ${recordId} belongs to Graph ${record.graphId}, not ${graphId}`,
        );
      }
    }
  }

  private assertInputRecordRefs(
    graphId: string,
    recordIds: readonly string[],
    incomingCommand: unknown,
  ): void {
    const incomingExpected = new Set(expectedOutputRecordIdsFromCommand(incomingCommand));
    for (const recordId of recordIds) {
      const record = this.selectRecordRef(recordId);
      if (!record) {
        if (
          incomingExpected.has(recordId) ||
          this.expectedOutputBelongsToGraph(graphId, recordId)
        ) {
          continue;
        }
        const foreignGraph = this.expectedOutputOwnerGraph(recordId);
        if (foreignGraph) {
          throw new AgentGraphStoreConflictError(
            `Input RecordRef ${recordId} belongs to Graph ${foreignGraph}, not ${graphId}`,
          );
        }
        throw new AgentGraphStoreConflictError(
          `Input RecordRef ${recordId} does not exist for Graph ${graphId}`,
        );
      }
      if (record.graphId !== graphId) {
        throw new AgentGraphStoreConflictError(
          `Input RecordRef ${recordId} belongs to Graph ${record.graphId}, not ${graphId}`,
        );
      }
    }
  }

  private expectedOutputBelongsToGraph(graphId: string, recordId: string): boolean {
    return (
      this.lease.database
        .prepare(
          `SELECT 1
         FROM agent_graph_schedule_revisions, json_tree(command_json) AS entry
         WHERE graph_id = ? AND entry.key = 'expectedOutputRecordId' AND entry.value = ?
         LIMIT 1`,
        )
        .get(graphId, recordId) !== undefined
    );
  }

  private expectedOutputOwnerGraph(recordId: string): string | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT graph_id
         FROM agent_graph_schedule_revisions, json_tree(command_json) AS entry
         WHERE entry.key = 'expectedOutputRecordId' AND entry.value = ?
         LIMIT 1`,
      )
      .get(recordId);
    return row ? rowString(asRow(row), "graph_id") : undefined;
  }

  private selectWake(wakeId: string): AgentGraphSupervisorWakeRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_supervisor_wakes WHERE wake_id = ?")
      .get(wakeId);
    return row ? wakeFromRow(asRow(row)) : undefined;
  }

  private selectYieldInterest(permitId: string): AgentGraphYieldInterestRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_yield_interests WHERE permit_id = ?")
      .get(permitId);
    return row ? yieldInterestFromRow(asRow(row)) : undefined;
  }

  private selectYieldInterestByRootRun(
    graphId: string,
    rootRunId: string,
  ): AgentGraphYieldInterestRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_yield_interests
         WHERE graph_id = ? AND root_run_id = ?`,
      )
      .get(graphId, rootRunId);
    return row ? yieldInterestFromRow(asRow(row)) : undefined;
  }

  private selectRegisteredYieldInterest(
    graphId: string,
  ): AgentGraphYieldInterestRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_yield_interests
         WHERE graph_id = ? AND state = 'registered'
         ORDER BY created_at ASC, permit_id ASC LIMIT 1`,
      )
      .get(graphId);
    return row ? yieldInterestFromRow(asRow(row)) : undefined;
  }

  private requireYieldInterest(permitId: string): AgentGraphYieldInterestRecord {
    const interest = this.selectYieldInterest(permitId);
    if (!interest) {
      throw new AgentGraphStoreConflictError(`Yield interest ${permitId} does not exist`);
    }
    return interest;
  }

  private selectWakeByDedupe(
    graphId: string,
    dedupeKey: string,
  ): AgentGraphSupervisorWakeRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_supervisor_wakes
         WHERE graph_id = ? AND dedupe_key = ?`,
      )
      .get(graphId, dedupeKey);
    return row ? wakeFromRow(asRow(row)) : undefined;
  }

  private requireWake(wakeId: string): AgentGraphSupervisorWakeRecord {
    const wake = this.selectWake(wakeId);
    if (!wake) throw new AgentGraphStoreConflictError(`Wake ${wakeId} does not exist`);
    return wake;
  }

  private selectWakeAttempt(attemptId: string): AgentGraphSupervisorWakeAttemptRecord | undefined {
    const row = this.lease.database
      .prepare("SELECT * FROM agent_graph_supervisor_wake_attempts WHERE attempt_id = ?")
      .get(attemptId);
    return row ? wakeAttemptFromRow(asRow(row)) : undefined;
  }

  private requireWakeAttempt(attemptId: string): AgentGraphSupervisorWakeAttemptRecord {
    const attempt = this.selectWakeAttempt(attemptId);
    if (!attempt) {
      throw new AgentGraphStoreConflictError(`Wake attempt ${attemptId} does not exist`);
    }
    return attempt;
  }

  private selectLatestWakeAttempt(
    wakeId: string,
  ): AgentGraphSupervisorWakeAttemptRecord | undefined {
    const row = this.lease.database
      .prepare(
        `SELECT * FROM agent_graph_supervisor_wake_attempts
         WHERE wake_id = ? ORDER BY attempt_number DESC LIMIT 1`,
      )
      .get(wakeId);
    return row ? wakeAttemptFromRow(asRow(row)) : undefined;
  }

  private recoverableWakeFromRecord(
    wake: AgentGraphSupervisorWakeRecord,
  ): RecoverableAgentGraphSupervisorWakeRecord {
    const graph = this.requireGraph(wake.graphId);
    const attempt = this.selectLatestWakeAttempt(wake.wakeId);
    if ((wake.status === "running" || wake.status === "waiting_permission") && !attempt) {
      throw new AgentGraphStoreConflictError(
        `Recoverable wake ${wake.wakeId} is ${wake.status} without an attempt`,
      );
    }
    return { graph, wake, ...(attempt ? { attempt } : {}) };
  }

  private read<T>(operation: () => T): T {
    this.assertOpen();
    return this.lease.transaction("read", operation);
  }

  private write<T>(operation: () => T): T {
    this.assertOpen();
    return this.lease.transaction("write", operation);
  }

  private assertOpen(): void {
    if (!this.open) throw new Error("AgentGraph store is closed");
  }
}

interface NormalizedScheduleInput extends Omit<CommitAgentGraphScheduleInput, "command"> {
  readonly command: unknown;
  readonly commandJson: string;
  readonly inputRecordIds: readonly string[];
  readonly selectedRecordIds: readonly string[];
}

function normalizeScheduleInput(input: CommitAgentGraphScheduleInput): NormalizedScheduleInput {
  requireNonNegativeInteger(input.expectedRevision, "expectedRevision");
  const inputRecordIds = inputRecordIdsFromCommand(input.command).map((recordId) =>
    requireNonEmpty(recordId, "inputRecordId"),
  );
  const selectedRecordIds = selectedRecordIdsFromCommand(input.kind, input.command).map(
    (recordId) => requireNonEmpty(recordId, "selectedRecordId"),
  );
  if (new Set(selectedRecordIds).size !== selectedRecordIds.length) {
    throw new Error("selectedRecordIds must be unique");
  }
  return {
    graphId: requireNonEmpty(input.graphId, "graphId"),
    expectedRevision: input.expectedRevision,
    operationId: requireNonEmpty(input.operationId, "operationId"),
    requestFingerprint: requireNonEmpty(input.requestFingerprint, "requestFingerprint"),
    kind: input.kind,
    command: input.command,
    inputRecordIds,
    selectedRecordIds,
    commandJson: canonicalJson(input.command),
    sourceSessionId: requireNonEmpty(input.sourceSessionId, "sourceSessionId"),
    sourceTurnId: requireNonEmpty(input.sourceTurnId, "sourceTurnId"),
    sourceRunId: requireNonEmpty(input.sourceRunId, "sourceRunId"),
    sourceToolCallId: requireNonEmpty(input.sourceToolCallId, "sourceToolCallId"),
  };
}

function inputRecordIdsFromCommand(command: unknown): readonly string[] {
  const envelope = asOptionalRecord(command);
  const commands =
    envelope?.["schemaVersion"] === 2 && Array.isArray(envelope["commands"])
      ? envelope["commands"]
      : [command];
  const inputRecordIds: string[] = [];
  for (const candidate of commands.map(asOptionalRecord)) {
    if (candidate?.["kind"] !== "add" && candidate?.["kind"] !== "activate") continue;
    const intent = asOptionalRecord(candidate["intent"]);
    const inputRefs = intent?.["inputRefs"];
    if (inputRefs === undefined) continue;
    if (!Array.isArray(inputRefs)) {
      throw new Error("Graph work inputRefs must be an array");
    }
    for (const inputRef of inputRefs) {
      const recordId = asOptionalRecord(inputRef)?.["recordId"];
      if (typeof recordId !== "string") {
        throw new Error("Graph work inputRefs must contain string recordIds");
      }
      inputRecordIds.push(recordId);
    }
  }
  return inputRecordIds;
}

function expectedOutputRecordIdsFromCommand(command: unknown): readonly string[] {
  const envelope = asOptionalRecord(command);
  const commands =
    envelope?.["schemaVersion"] === 2 && Array.isArray(envelope["commands"])
      ? envelope["commands"]
      : [command];
  const recordIds: string[] = [];
  for (const candidate of commands.map(asOptionalRecord)) {
    if (candidate?.["kind"] !== "add" && candidate?.["kind"] !== "activate") continue;
    const intent = asOptionalRecord(candidate["intent"]);
    const graphId = intent?.["graphId"];
    const intentId = intent?.["intentId"];
    const value = intent?.["expectedOutputRecordId"];
    if (typeof graphId !== "string" || typeof intentId !== "string" || typeof value !== "string") {
      continue;
    }
    if (value !== agentOutputRecordIdFor(graphId, intentId)) {
      throw new Error("Graph activation expected output RecordRef has an invalid identity");
    }
    recordIds.push(value);
  }
  return recordIds;
}

function selectedRecordIdsFromCommand(
  kind: CommitAgentGraphScheduleInput["kind"],
  command: unknown,
): readonly string[] {
  if (kind !== "finish") return [];
  const envelope = asOptionalRecord(command);
  const commands =
    envelope?.["schemaVersion"] === 2 && Array.isArray(envelope["commands"])
      ? envelope["commands"]
      : [command];
  const finishCommands = commands
    .map(asOptionalRecord)
    .filter((candidate) => candidate?.["kind"] === "finish");
  if (finishCommands.length !== 1) {
    throw new Error("A finish schedule revision must contain exactly one finish command");
  }
  const selectedRecordIds = finishCommands[0]?.["selectedRecordIds"];
  if (selectedRecordIds === undefined) return [];
  if (
    !Array.isArray(selectedRecordIds) ||
    !selectedRecordIds.every((value) => typeof value === "string")
  ) {
    throw new Error("finish selectedRecordIds must be a string array");
  }
  return selectedRecordIds;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface NormalizedProvisionInput extends Omit<
  EnsureAgentGraphOperatorProvisionInput,
  "profileSnapshot" | "workspaceBinding"
> {
  readonly profileSnapshotJson: string;
  readonly workspaceBindingJson: string;
}

function normalizeProvisionInput(
  input: EnsureAgentGraphOperatorProvisionInput,
): NormalizedProvisionInput {
  requirePositiveInteger(input.generation, "generation");
  requirePositiveInteger(input.scheduleRevision, "scheduleRevision");
  return {
    provisionId: requireNonEmpty(input.provisionId, "provisionId"),
    graphId: requireNonEmpty(input.graphId, "graphId"),
    operatorId: requireNonEmpty(input.operatorId, "operatorId"),
    generation: input.generation,
    scheduleRevision: input.scheduleRevision,
    provisionFingerprint: requireNonEmpty(input.provisionFingerprint, "provisionFingerprint"),
    childSessionId: requireNonEmpty(input.childSessionId, "childSessionId"),
    profileSnapshotJson: canonicalJson(input.profileSnapshot),
    workspaceBindingJson: canonicalJson(input.workspaceBinding),
  };
}

function normalizeClaimInput(
  input: ClaimAgentGraphActivationInput,
): ClaimAgentGraphActivationInput {
  requirePositiveInteger(input.operatorGeneration, "operatorGeneration");
  requirePositiveInteger(input.expectedGraphRevision, "expectedGraphRevision");
  return {
    claimId: requireNonEmpty(input.claimId, "claimId"),
    graphId: requireNonEmpty(input.graphId, "graphId"),
    intentId: requireNonEmpty(input.intentId, "intentId"),
    operatorId: requireNonEmpty(input.operatorId, "operatorId"),
    operatorGeneration: input.operatorGeneration,
    expectedGraphRevision: input.expectedGraphRevision,
    intentFingerprint: requireNonEmpty(input.intentFingerprint, "intentFingerprint"),
    readinessFingerprint: requireNonEmpty(input.readinessFingerprint, "readinessFingerprint"),
    targetSessionId: requireNonEmpty(input.targetSessionId, "targetSessionId"),
    targetTurnId: requireNonEmpty(input.targetTurnId, "targetTurnId"),
    targetRunId: requireNonEmpty(input.targetRunId, "targetRunId"),
    targetInvocationId: requireNonEmpty(input.targetInvocationId, "targetInvocationId"),
    runStartedEventId: requireNonEmpty(input.runStartedEventId, "runStartedEventId"),
  };
}

function normalizeRecordRefInput(input: PutAgentGraphRecordRefInput): PutAgentGraphRecordRefInput {
  requirePositiveInteger(input.operatorGeneration, "operatorGeneration");
  return {
    recordId: requireNonEmpty(input.recordId, "recordId"),
    graphId: requireNonEmpty(input.graphId, "graphId"),
    claimId: requireNonEmpty(input.claimId, "claimId"),
    operatorId: requireNonEmpty(input.operatorId, "operatorId"),
    operatorGeneration: input.operatorGeneration,
    recordFingerprint: requireNonEmpty(input.recordFingerprint, "recordFingerprint"),
    sourceSessionId: requireNonEmpty(input.sourceSessionId, "sourceSessionId"),
    sourceTurnId: requireNonEmpty(input.sourceTurnId, "sourceTurnId"),
    sourceRunId: requireNonEmpty(input.sourceRunId, "sourceRunId"),
    sourceEventId: requireNonEmpty(input.sourceEventId, "sourceEventId"),
    kind: input.kind,
  };
}

interface NormalizedResourceRefInput extends Omit<PutAgentGraphResourceRefInput, "metadata"> {
  readonly metadataJson: string;
}

function normalizeResourceRefInput(
  input: PutAgentGraphResourceRefInput,
): NormalizedResourceRefInput {
  requireNonNegativeInteger(input.contentBytes, "contentBytes");
  if (!/^[a-f0-9]{64}$/u.test(input.contentDigest)) {
    throw new Error("contentDigest must be a lowercase SHA-256 digest");
  }
  return {
    resourceId: requireNonEmpty(input.resourceId, "resourceId"),
    graphId: requireNonEmpty(input.graphId, "graphId"),
    claimId: requireNonEmpty(input.claimId, "claimId"),
    kind: input.kind,
    sourceRef: requireNonEmpty(input.sourceRef, "sourceRef"),
    sourceSessionId: requireNonEmpty(input.sourceSessionId, "sourceSessionId"),
    sourceResourceId: requireNonEmpty(input.sourceResourceId, "sourceResourceId"),
    contentDigest: input.contentDigest,
    contentBytes: input.contentBytes,
    mediaType: optionalNonEmpty(input.mediaType, "mediaType"),
    title: optionalNonEmpty(input.title, "title"),
    metadataJson: canonicalJson(input.metadata),
  };
}

function normalizeYieldInterestInput(
  input: RegisterAgentGraphYieldInterestInput,
): RegisterAgentGraphYieldInterestInput {
  return {
    permitId: requireNonEmpty(input.permitId, "permitId"),
    graphId: requireNonEmpty(input.graphId, "graphId"),
    rootSessionId: requireNonEmpty(input.rootSessionId, "rootSessionId"),
    rootTurnId: requireNonEmpty(input.rootTurnId, "rootTurnId"),
    rootRunId: requireNonEmpty(input.rootRunId, "rootRunId"),
    toolCallId: requireNonEmpty(input.toolCallId, "toolCallId"),
  };
}

interface NormalizedWakeInput extends Omit<EnqueueAgentGraphSupervisorWakeInput, "payload"> {
  readonly availableAt: number;
  readonly payloadJson: string;
}

function normalizeWakeInput(
  input: EnqueueAgentGraphSupervisorWakeInput,
  defaultAvailableAt: number,
): NormalizedWakeInput {
  const availableAt = input.availableAt ?? defaultAvailableAt;
  requireFiniteNumber(availableAt, "availableAt");
  return {
    wakeId: requireNonEmpty(input.wakeId, "wakeId"),
    graphId: requireNonEmpty(input.graphId, "graphId"),
    dedupeKey: requireNonEmpty(input.dedupeKey, "dedupeKey"),
    wakeFingerprint: requireNonEmpty(input.wakeFingerprint, "wakeFingerprint"),
    cause: input.cause,
    payloadJson: canonicalJson(input.payload),
    availableAt,
  };
}

function normalizeWakeClaimInput(
  input: ClaimAgentGraphSupervisorWakeInput,
): ClaimAgentGraphSupervisorWakeInput {
  requirePositiveInteger(input.expectedWakeVersion, "expectedWakeVersion");
  return {
    wakeId: requireNonEmpty(input.wakeId, "wakeId"),
    expectedWakeVersion: input.expectedWakeVersion,
    attemptId: requireNonEmpty(input.attemptId, "attemptId"),
    rootSessionId: requireNonEmpty(input.rootSessionId, "rootSessionId"),
    targetTurnId: requireNonEmpty(input.targetTurnId, "targetTurnId"),
    targetRunId: requireNonEmpty(input.targetRunId, "targetRunId"),
  };
}

function normalizeWakeSettlementInput(
  input: SettleAgentGraphSupervisorWakeInput,
): SettleAgentGraphSupervisorWakeInput {
  requirePositiveInteger(input.expectedWakeVersion, "expectedWakeVersion");
  requirePositiveInteger(input.expectedAttemptVersion, "expectedAttemptVersion");
  const error = optionalNonEmpty(input.error, "error");
  if (input.outcome === "delivered" && error !== undefined) {
    throw new Error("delivered wake must not include an error");
  }
  if (input.outcome === "retryable_failed") {
    if (input.retryAt === undefined) {
      throw new Error("retryable_failed wake requires retryAt");
    }
    requireFiniteNumber(input.retryAt, "retryAt");
  } else if (input.retryAt !== undefined) {
    throw new Error(`${input.outcome} wake must not include retryAt`);
  }
  return {
    wakeId: requireNonEmpty(input.wakeId, "wakeId"),
    attemptId: requireNonEmpty(input.attemptId, "attemptId"),
    expectedWakeVersion: input.expectedWakeVersion,
    expectedAttemptVersion: input.expectedAttemptVersion,
    outcome: input.outcome,
    ...(error === undefined ? {} : { error }),
    ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
  };
}

function replayProvision(
  existing: AgentGraphOperatorProvisionRecord,
  input: NormalizedProvisionInput,
): IdempotentStoreResult<AgentGraphOperatorProvisionRecord> {
  if (
    existing.provisionId !== input.provisionId ||
    existing.scheduleRevision !== input.scheduleRevision ||
    existing.provisionFingerprint !== input.provisionFingerprint ||
    existing.childSessionId !== input.childSessionId ||
    canonicalJson(existing.profileSnapshot) !== input.profileSnapshotJson ||
    canonicalJson(existing.workspaceBinding) !== input.workspaceBindingJson
  ) {
    throw new AgentGraphStoreConflictError(
      `Operator ${input.operatorId}@${input.generation} is already provisioned with different immutable metadata`,
    );
  }
  return { record: existing, replayed: true };
}

function replayClaim(
  existing: AgentGraphActivationClaimRecord,
  input: ClaimAgentGraphActivationInput,
): IdempotentStoreResult<AgentGraphActivationClaimRecord> {
  if (
    existing.claimId !== input.claimId ||
    existing.operatorId !== input.operatorId ||
    existing.operatorGeneration !== input.operatorGeneration ||
    existing.scheduleRevision !== input.expectedGraphRevision ||
    existing.intentFingerprint !== input.intentFingerprint ||
    existing.readinessFingerprint !== input.readinessFingerprint ||
    existing.targetSessionId !== input.targetSessionId ||
    existing.targetTurnId !== input.targetTurnId ||
    existing.targetRunId !== input.targetRunId ||
    existing.targetInvocationId !== input.targetInvocationId ||
    existing.runStartedEventId !== input.runStartedEventId
  ) {
    throw new AgentGraphStoreConflictError(
      `Activation intent ${input.intentId} is already bound to another exact run`,
    );
  }
  return { record: existing, replayed: true };
}

function replayRecordRef(
  existing: AgentGraphRecordRefRecord,
  input: PutAgentGraphRecordRefInput,
): IdempotentStoreResult<AgentGraphRecordRefRecord> {
  if (
    existing.recordId !== input.recordId ||
    existing.graphId !== input.graphId ||
    existing.claimId !== input.claimId ||
    existing.operatorId !== input.operatorId ||
    existing.operatorGeneration !== input.operatorGeneration ||
    existing.recordFingerprint !== input.recordFingerprint ||
    existing.sourceSessionId !== input.sourceSessionId ||
    existing.sourceTurnId !== input.sourceTurnId ||
    existing.sourceRunId !== input.sourceRunId ||
    existing.sourceEventId !== input.sourceEventId ||
    existing.kind !== input.kind
  ) {
    throw new AgentGraphStoreConflictError(
      `Record ${input.recordId} is already bound to another runtime event`,
    );
  }
  return { record: existing, replayed: true };
}

function replayResourceRef(
  existing: AgentGraphResourceRefRecord,
  input: NormalizedResourceRefInput,
): IdempotentStoreResult<AgentGraphResourceRefRecord> {
  if (
    existing.resourceId !== input.resourceId ||
    existing.graphId !== input.graphId ||
    existing.claimId !== input.claimId ||
    existing.kind !== input.kind ||
    existing.sourceRef !== input.sourceRef ||
    existing.sourceSessionId !== input.sourceSessionId ||
    existing.sourceResourceId !== input.sourceResourceId ||
    existing.contentDigest !== input.contentDigest ||
    existing.contentBytes !== input.contentBytes ||
    existing.mediaType !== input.mediaType ||
    existing.title !== input.title ||
    canonicalJson(existing.metadata) !== input.metadataJson
  ) {
    throw new AgentGraphStoreConflictError(
      `Resource ${input.resourceId} is already bound to different immutable metadata`,
    );
  }
  return { record: existing, replayed: true };
}

function replayYieldInterest(
  existing: AgentGraphYieldInterestRecord,
  input: RegisterAgentGraphYieldInterestInput,
): IdempotentStoreResult<AgentGraphYieldInterestRecord> {
  if (
    existing.permitId !== input.permitId ||
    existing.graphId !== input.graphId ||
    existing.rootSessionId !== input.rootSessionId ||
    existing.rootTurnId !== input.rootTurnId ||
    existing.rootRunId !== input.rootRunId ||
    existing.toolCallId !== input.toolCallId
  ) {
    throw new AgentGraphStoreConflictError(
      `Yield interest ${input.permitId} is already bound to another root run`,
    );
  }
  return { record: existing, replayed: true };
}

function assertClaimTransition(
  from: AgentGraphClaimState,
  to: Extract<AgentGraphClaimState, "executing" | "cancelled">,
): void {
  if (from === "claimed" && (to === "executing" || to === "cancelled")) return;
  if (from === "executing" && to === "cancelled") return;
  throw new Error(`Unsupported activation claim transition ${from} -> ${to}`);
}

function assertProvisionTransition(
  from: TransitionAgentGraphProvisionInput["from"],
  to: TransitionAgentGraphProvisionInput["to"],
): void {
  if (from === "requested" && (to === "provisioned" || to === "stopped")) return;
  if (from === "provisioned" && (to === "stopping" || to === "stopped")) return;
  if (from === "stopping" && to === "stopped") return;
  throw new Error(`Unsupported operator provision transition ${from} -> ${to}`);
}

function wakeAttemptStatusFor(
  outcome: SettleAgentGraphSupervisorWakeInput["outcome"],
): AgentGraphSupervisorWakeAttemptRecord["status"] {
  if (outcome === "delivered") return "completed";
  if (outcome === "waiting_permission") return "waiting_permission";
  return "failed";
}

function graphFromRow(row: Record<string, unknown>): AgentGraphRecord {
  return compact({
    graphId: rowString(row, "graph_id"),
    rootSessionId: rowString(row, "root_session_id"),
    epoch: rowNumber(row, "epoch"),
    phase: rowString(row, "phase") as AgentGraphRecord["phase"],
    headRevision: rowNumber(row, "head_revision"),
    createdAt: rowNumber(row, "created_at"),
    finishedAt: rowOptionalNumber(row, "finished_at"),
  });
}

function scheduleFromRow(row: Record<string, unknown>): AgentGraphScheduleRevisionRecord {
  return {
    graphId: rowString(row, "graph_id"),
    revision: rowNumber(row, "revision"),
    operationId: rowString(row, "operation_id"),
    requestFingerprint: rowString(row, "request_fingerprint"),
    kind: rowString(row, "kind") as AgentGraphScheduleRevisionRecord["kind"],
    command: rowJson(row, "command_json"),
    sourceSessionId: rowString(row, "source_session_id"),
    sourceTurnId: rowString(row, "source_turn_id"),
    sourceRunId: rowString(row, "source_run_id"),
    sourceToolCallId: rowString(row, "source_tool_call_id"),
    createdAt: rowNumber(row, "created_at"),
  };
}

function provisionFromRow(row: Record<string, unknown>): AgentGraphOperatorProvisionRecord {
  return {
    provisionId: rowString(row, "provision_id"),
    graphId: rowString(row, "graph_id"),
    operatorId: rowString(row, "operator_id"),
    generation: rowNumber(row, "generation"),
    scheduleRevision: rowNumber(row, "schedule_revision"),
    provisionFingerprint: rowString(row, "provision_fingerprint"),
    childSessionId: rowString(row, "child_session_id"),
    profileSnapshot: rowJson(row, "profile_snapshot_json"),
    workspaceBinding: rowJson(row, "workspace_binding_json"),
    state: rowString(row, "state") as AgentGraphOperatorProvisionRecord["state"],
    version: rowNumber(row, "version"),
    createdAt: rowNumber(row, "created_at"),
    provisionedAt: rowOptionalNumber(row, "provisioned_at"),
    stoppedAt: rowOptionalNumber(row, "stopped_at"),
  };
}

function claimFromRow(row: Record<string, unknown>): AgentGraphActivationClaimRecord {
  return compact({
    claimId: rowString(row, "claim_id"),
    graphId: rowString(row, "graph_id"),
    intentId: rowString(row, "intent_id"),
    operatorId: rowString(row, "operator_id"),
    operatorGeneration: rowNumber(row, "operator_generation"),
    scheduleRevision: rowNumber(row, "schedule_revision"),
    intentFingerprint: rowString(row, "intent_fingerprint"),
    readinessFingerprint: rowString(row, "readiness_fingerprint"),
    state: rowString(row, "state") as AgentGraphClaimState,
    targetSessionId: rowString(row, "target_session_id"),
    targetTurnId: rowString(row, "target_turn_id"),
    targetRunId: rowString(row, "target_run_id"),
    targetInvocationId: rowString(row, "target_invocation_id"),
    runStartedEventId: rowString(row, "run_started_event_id"),
    version: rowNumber(row, "version"),
    claimedAt: rowNumber(row, "claimed_at"),
    executingAt: rowOptionalNumber(row, "executing_at"),
    cancelledAt: rowOptionalNumber(row, "cancelled_at"),
    cancellationReason: rowOptionalString(row, "cancellation_reason"),
  });
}

function recordRefFromRow(row: Record<string, unknown>): AgentGraphRecordRefRecord {
  return {
    recordId: rowString(row, "record_id"),
    graphId: rowString(row, "graph_id"),
    claimId: rowString(row, "claim_id"),
    operatorId: rowString(row, "operator_id"),
    operatorGeneration: rowNumber(row, "operator_generation"),
    recordFingerprint: rowString(row, "record_fingerprint"),
    sourceSessionId: rowString(row, "source_session_id"),
    sourceTurnId: rowString(row, "source_turn_id"),
    sourceRunId: rowString(row, "source_run_id"),
    sourceEventId: rowString(row, "source_event_id"),
    kind: rowString(row, "kind") as AgentGraphRecordRefRecord["kind"],
    createdAt: rowNumber(row, "created_at"),
  };
}

function resourceRefFromRow(row: Record<string, unknown>): AgentGraphResourceRefRecord {
  return compact({
    resourceId: rowString(row, "resource_id"),
    graphId: rowString(row, "graph_id"),
    claimId: rowString(row, "claim_id"),
    kind: rowString(row, "kind") as AgentGraphResourceRefRecord["kind"],
    sourceRef: rowString(row, "source_ref"),
    sourceSessionId: rowString(row, "source_session_id"),
    sourceResourceId: rowString(row, "source_resource_id"),
    contentDigest: rowString(row, "content_digest"),
    contentBytes: rowNumber(row, "content_bytes"),
    mediaType: rowOptionalString(row, "media_type"),
    title: rowOptionalString(row, "title"),
    metadata: rowJson(row, "metadata_json"),
    createdAt: rowNumber(row, "created_at"),
  });
}

function wakeFromRow(row: Record<string, unknown>): AgentGraphSupervisorWakeRecord {
  return compact({
    wakeId: rowString(row, "wake_id"),
    graphId: rowString(row, "graph_id"),
    dedupeKey: rowString(row, "dedupe_key"),
    wakeFingerprint: rowString(row, "wake_fingerprint"),
    cause: rowString(row, "cause") as AgentGraphSupervisorWakeRecord["cause"],
    payload: rowJson(row, "payload_json"),
    status: rowString(row, "status") as AgentGraphSupervisorWakeRecord["status"],
    availableAt: rowNumber(row, "available_at"),
    attemptCount: rowNumber(row, "attempt_count"),
    version: rowNumber(row, "version"),
    createdAt: rowNumber(row, "created_at"),
    updatedAt: rowNumber(row, "updated_at"),
    deliveredAt: rowOptionalNumber(row, "delivered_at"),
    lastError: rowOptionalString(row, "last_error"),
    yieldPermitId: rowOptionalString(row, "yield_permit_id"),
  });
}

function yieldInterestFromRow(row: Record<string, unknown>): AgentGraphYieldInterestRecord {
  return compact({
    permitId: rowString(row, "permit_id"),
    graphId: rowString(row, "graph_id"),
    rootSessionId: rowString(row, "root_session_id"),
    rootTurnId: rowString(row, "root_turn_id"),
    rootRunId: rowString(row, "root_run_id"),
    toolCallId: rowString(row, "tool_call_id"),
    state: rowString(row, "state") as AgentGraphYieldInterestRecord["state"],
    version: rowNumber(row, "version"),
    createdAt: rowNumber(row, "created_at"),
    resolvedAt: rowOptionalNumber(row, "resolved_at"),
  });
}

function wakeAttemptFromRow(row: Record<string, unknown>): AgentGraphSupervisorWakeAttemptRecord {
  return compact({
    attemptId: rowString(row, "attempt_id"),
    wakeId: rowString(row, "wake_id"),
    attemptNumber: rowNumber(row, "attempt_number"),
    rootSessionId: rowString(row, "root_session_id"),
    targetTurnId: rowString(row, "target_turn_id"),
    targetRunId: rowString(row, "target_run_id"),
    status: rowString(row, "status") as AgentGraphSupervisorWakeAttemptRecord["status"],
    version: rowNumber(row, "version"),
    startedAt: rowNumber(row, "started_at"),
    updatedAt: rowNumber(row, "updated_at"),
    finishedAt: rowOptionalNumber(row, "finished_at"),
    error: rowOptionalString(row, "error"),
  });
}

function asRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AgentGraph SQLite query returned an invalid row");
  }
  return value as Record<string, unknown>;
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`AgentGraph row ${key} must be a string`);
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`AgentGraph row ${key} must be a string`);
  return value;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`AgentGraph row ${key} must be a number`);
  return value;
}

function rowOptionalNumber(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`AgentGraph row ${key} must be a number`);
  return value;
}

function rowJson(row: Record<string, unknown>, key: string): unknown {
  return JSON.parse(rowString(row, key)) as unknown;
}

function requireNonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}

function optionalNonEmpty(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmpty(value, name);
}

function requireFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON values must contain only finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) throw new Error(`JSON property ${key} must not be undefined`);
      normalized[key] = normalizeJson(item);
    }
    return normalized;
  }
  throw new Error(`Unsupported JSON value: ${typeof value}`);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
