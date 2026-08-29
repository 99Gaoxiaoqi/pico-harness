import { deterministicFingerprint } from "./core/ids.js";
import { SqliteAgentGraphControlStoreAdapter } from "./sqlite-control-store-adapter.js";
import type { AgentGraphRecord } from "../storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { decodeRuntimeEventJson } from "../storage/runtime-event.js";
import {
  projectAgentGraphRuntimeActivation,
  type AgentGraphRunLaunchState,
} from "./runtime-activation-projection.js";

export interface AgentGraphLaunchStateQueryPort {
  inspect(input: {
    readonly sessionId: string;
    readonly runId: string;
  }): Promise<AgentGraphRunLaunchState> | AgentGraphRunLaunchState;
}

export interface AgentGraphQueryInput {
  readonly rootSessionId: string;
  readonly action: "list" | "get" | "timeline";
  readonly graphId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AgentGraphTimelineItem {
  readonly id: string;
  readonly at: number;
  readonly kind:
    | "graph.created"
    | "graph.finished"
    | "schedule.committed"
    | "operator.provisioned"
    | "operator.stopped"
    | "activation.claimed"
    | "activation.executing"
    | "activation.cancelled"
    | "record.committed"
    | "resource.retained"
    | "workspace.requested"
    | "workspace.active"
    | "workspace.retained"
    | "workspace.cleaned"
    | "yield.registered"
    | "yield.resolved"
    | "diagnostic.recorded"
    | "diagnostic.resolved"
    | "wake.enqueued"
    | "wake.settled"
    | "wake.attempted";
  readonly status?: string;
  readonly subjectId?: string;
  readonly detail?: string;
}

export class AgentGraphReadOnlyQueryService {
  private readonly control: SqliteAgentGraphControlStoreAdapter;

  constructor(private readonly store: SqliteAgentGraphControlStore) {
    this.control = new SqliteAgentGraphControlStoreAdapter(store);
  }

  query(input: AgentGraphQueryInput): unknown {
    requireIdentity(input.rootSessionId, "rootSessionId");
    const limit = boundedLimit(input.limit);
    if (input.action === "list") {
      if (input.graphId || input.cursor) {
        throw new Error("Graph list does not accept graphId or cursor");
      }
      return {
        graphs: this.store.listGraphs(input.rootSessionId).map((graph) => this.summary(graph)),
      };
    }

    const graph = this.requireGraph(input.rootSessionId, input.graphId);
    if (input.action === "get") {
      if (input.cursor) throw new Error("Graph get does not accept cursor");
      const state = this.control.getScheduleState(graph.graphId);
      return {
        summary: this.summary(graph),
        operators: state.operators.map(({ profileSnapshot, ...operator }) => ({
          ...operator,
          profile: {
            profileId: profileSnapshot.profileId,
            revision: profileSnapshot.profileRevision,
          },
        })),
        intents: state.intents,
        stops: state.stops,
        provisions: this.store
          .listOperatorProvisions(graph.graphId)
          .map(({ profileSnapshot, workspaceBinding, ...provision }) => ({
            ...provision,
            profile: profileSummary(profileSnapshot),
            workspace: workspaceSummary(workspaceBinding),
          })),
        claims: this.store.listActivationClaims(graph.graphId),
        records: this.store.listRecordRefs(graph.graphId),
        resources: this.store.listResourceRefs(graph.graphId),
        workspaceResources: this.store.listWorkspaceResources(graph.graphId),
        diagnostics: this.store.listGraphDiagnostics(graph.graphId),
        wakes: this.store.listSupervisorWakes(graph.graphId).map((wake) => ({
          ...wake,
          attempts: this.store.listSupervisorWakeAttempts(wake.wakeId),
        })),
      };
    }

    const timeline = this.timeline(graph);
    const watermark = deterministicFingerprint(timeline);
    const offset = decodeCursor(input.cursor, graph.graphId, watermark);
    const items = timeline.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      graph: this.summary(graph),
      watermark,
      items,
      ...(nextOffset < timeline.length
        ? { nextCursor: encodeCursor(graph.graphId, watermark, nextOffset) }
        : {}),
    };
  }

  /** Joins control records with canonical Runtime/output facts for UI status projection. */
  async queryRuntimeFacts(
    graphId: string,
    runtimeStore: SqliteRuntimeEventStore,
    launchStatePort?: AgentGraphLaunchStateQueryPort,
  ): Promise<{
    readonly runtimeClaims: readonly {
      readonly claimId: string;
      readonly status: string;
      readonly terminalEventId?: string;
    }[];
    readonly outputs: readonly {
      readonly recordId: string;
      readonly claimId: string;
      readonly status: "success" | "failure";
    }[];
  }> {
    const graph = this.store.getGraph(graphId);
    if (!graph) throw new Error(`Graph does not exist: ${graphId}`);
    const claims = this.store.listActivationClaims(graphId);
    const runtimeClaims = await Promise.all(
      claims.map(async (claim) => {
        const [events, launchState] = await Promise.all([
          runtimeStore.readRun(claim.targetSessionId, claim.targetRunId),
          launchStatePort?.inspect({
            sessionId: claim.targetSessionId,
            runId: claim.targetRunId,
          }),
        ]);
        const projection = projectAgentGraphRuntimeActivation({
          claim,
          events,
          ...(launchState ? { launchState } : {}),
        });
        return {
          claimId: claim.claimId,
          status: projection.status,
          ...(projection.terminalEventId ? { terminalEventId: projection.terminalEventId } : {}),
        };
      }),
    );
    const records = this.store.listRecordRefs(graphId);
    const rows = await runtimeStore.readEventRowsByEventIds(
      records.map((record) => record.sourceEventId),
    );
    const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
    const outputs = records.map((record) => {
      const row = rows.get(record.sourceEventId);
      const event = row ? decodeRuntimeEventJson(row.payloadJson) : undefined;
      const claim = claimsById.get(record.claimId);
      if (
        !event ||
        event.kind !== "agent.output" ||
        !claim ||
        event.sessionId !== record.sourceSessionId ||
        event.runId !== record.sourceRunId ||
        event.data.payload.activationId !== claim.claimId
      ) {
        throw new Error(`Graph record ${record.recordId} has no matching formal output`);
      }
      return {
        recordId: record.recordId,
        claimId: record.claimId,
        status: event.data.payload.status,
      };
    });
    return { runtimeClaims, outputs };
  }

  private summary(graph: AgentGraphRecord) {
    const graphId = graph.graphId;
    return {
      graphId,
      rootSessionId: graph.rootSessionId,
      epoch: graph.epoch,
      phase: graph.phase,
      headRevision: graph.headRevision,
      createdAt: graph.createdAt,
      ...(graph.finishedAt === undefined ? {} : { finishedAt: graph.finishedAt }),
      counts: {
        operators: this.store.listOperatorProvisions(graphId).length,
        intents: this.control.getScheduleState(graphId).intents.length,
        claims: this.store.listActivationClaims(graphId).length,
        records: this.store.listRecordRefs(graphId).length,
        resources: this.store.listResourceRefs(graphId).length,
        workspaceResources: this.store.listWorkspaceResources(graphId).length,
        wakes: this.store.listSupervisorWakes(graphId).length,
        diagnostics: this.store.listGraphDiagnostics(graphId, { unresolvedOnly: true }).length,
      },
    };
  }

  private timeline(graph: AgentGraphRecord): readonly AgentGraphTimelineItem[] {
    const graphId = graph.graphId;
    const items: AgentGraphTimelineItem[] = [
      {
        id: `graph-created:${graphId}`,
        at: graph.createdAt,
        kind: "graph.created",
        subjectId: graphId,
        status: "open",
      },
    ];
    if (graph.finishedAt !== undefined) {
      items.push({
        id: `graph-finished:${graphId}`,
        at: graph.finishedAt,
        kind: "graph.finished",
        subjectId: graphId,
        status: "finished",
      });
    }
    for (const revision of this.store.listScheduleRevisions(graphId)) {
      items.push({
        id: `schedule:${graphId}:${revision.revision}`,
        at: revision.createdAt,
        kind: "schedule.committed",
        subjectId: revision.operationId,
        status: revision.kind,
        detail: `revision ${revision.revision}`,
      });
    }
    for (const provision of this.store.listOperatorProvisions(graphId)) {
      if (provision.provisionedAt !== undefined) {
        items.push({
          id: `provisioned:${provision.provisionId}`,
          at: provision.provisionedAt,
          kind: "operator.provisioned",
          subjectId: provision.operatorId,
          status: provision.state,
          detail: `generation ${provision.generation}`,
        });
      }
      if (provision.stoppedAt !== undefined) {
        items.push({
          id: `provision-stopped:${provision.provisionId}`,
          at: provision.stoppedAt,
          kind: "operator.stopped",
          subjectId: provision.operatorId,
          status: "stopped",
        });
      }
    }
    for (const claim of this.store.listActivationClaims(graphId)) {
      items.push({
        id: `claim:${claim.claimId}`,
        at: claim.claimedAt,
        kind: "activation.claimed",
        subjectId: claim.intentId,
        status: "claimed",
      });
      if (claim.executingAt !== undefined) {
        items.push({
          id: `executing:${claim.claimId}`,
          at: claim.executingAt,
          kind: "activation.executing",
          subjectId: claim.intentId,
          status: claim.state,
        });
      }
      if (claim.cancelledAt !== undefined) {
        items.push({
          id: `cancelled:${claim.claimId}`,
          at: claim.cancelledAt,
          kind: "activation.cancelled",
          subjectId: claim.intentId,
          status: "cancelled",
          ...(claim.cancellationReason === undefined ? {} : { detail: claim.cancellationReason }),
        });
      }
    }
    for (const record of this.store.listRecordRefs(graphId)) {
      items.push({
        id: `record:${record.recordId}`,
        at: record.createdAt,
        kind: "record.committed",
        subjectId: record.recordId,
        status: record.kind,
      });
    }
    for (const resource of this.store.listResourceRefs(graphId)) {
      items.push({
        id: `resource:${resource.resourceId}`,
        at: resource.createdAt,
        kind: "resource.retained",
        subjectId: resource.resourceId,
        status: resource.kind,
        detail: resource.contentDigest,
      });
    }
    for (const resource of this.store.listWorkspaceResources(graphId)) {
      items.push({
        id: `workspace:${resource.resourceId}:${resource.version}`,
        at: resource.state === "requested" ? resource.createdAt : resource.updatedAt,
        kind: `workspace.${resource.state}`,
        subjectId: resource.provisionId,
        status: resource.state,
        detail: resource.retainReason ?? resource.branch,
      });
    }
    for (const interest of this.store.listYieldInterests(graphId)) {
      items.push({
        id: `yield:${interest.permitId}`,
        at: interest.createdAt,
        kind: "yield.registered",
        subjectId: interest.permitId,
        status: "registered",
      });
      if (interest.resolvedAt !== undefined) {
        items.push({
          id: `yield-resolved:${interest.permitId}`,
          at: interest.resolvedAt,
          kind: "yield.resolved",
          subjectId: interest.permitId,
          status: interest.state,
        });
      }
    }
    for (const wake of this.store.listSupervisorWakes(graphId)) {
      items.push({
        id: `wake:${wake.wakeId}`,
        at: wake.createdAt,
        kind: "wake.enqueued",
        subjectId: wake.wakeId,
        status: wake.cause,
      });
      if (
        wake.deliveredAt !== undefined ||
        wake.status === "retryable_failed" ||
        wake.status === "needs_attention"
      ) {
        items.push({
          id: `wake-settled:${wake.wakeId}:${wake.version}`,
          at: wake.deliveredAt ?? wake.updatedAt,
          kind: "wake.settled",
          subjectId: wake.wakeId,
          status: wake.status,
          ...(wake.lastError === undefined ? {} : { detail: wake.lastError }),
        });
      }
      for (const attempt of this.store.listSupervisorWakeAttempts(wake.wakeId)) {
        items.push({
          id: `wake-attempt:${attempt.attemptId}`,
          at: attempt.startedAt,
          kind: "wake.attempted",
          subjectId: attempt.attemptId,
          status: attempt.status,
          ...(attempt.error === undefined ? {} : { detail: attempt.error }),
        });
      }
    }
    for (const diagnostic of this.store.listGraphDiagnostics(graphId)) {
      items.push({
        id: `diagnostic:${diagnostic.diagnosticId}:${diagnostic.version}`,
        at: diagnostic.createdAt,
        kind: "diagnostic.recorded",
        subjectId: diagnostic.subjectId,
        status: diagnostic.state,
        detail: `${diagnostic.phase}:${diagnostic.classification}:${diagnostic.message}`,
      });
      if (diagnostic.resolvedAt !== undefined) {
        items.push({
          id: `diagnostic-resolved:${diagnostic.diagnosticId}:${diagnostic.version}`,
          at: diagnostic.resolvedAt,
          kind: "diagnostic.resolved",
          subjectId: diagnostic.subjectId,
          status: "resolved",
        });
      }
    }
    return items.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  }

  private requireGraph(rootSessionId: string, graphId: string | undefined): AgentGraphRecord {
    if (!graphId) throw new Error("Graph get/timeline requires graphId");
    requireIdentity(graphId, "graphId");
    const graph = this.store.getGraph(graphId);
    if (!graph || graph.rootSessionId !== rootSessionId) {
      throw new Error(`Graph does not belong to root Session: ${graphId}`);
    }
    return graph;
  }
}

function profileSummary(value: unknown): unknown {
  const profile = value as { readonly profileId?: unknown; readonly profileRevision?: unknown };
  return {
    profileId: profile.profileId,
    revision: profile.profileRevision,
  };
}

function workspaceSummary(value: unknown): unknown {
  const workspace = value as { readonly kind?: unknown };
  return { kind: workspace.kind };
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error("Graph query limit must be between 1 and 200");
  }
  return value;
}

function encodeCursor(graphId: string, watermark: string, offset: number): string {
  return Buffer.from(JSON.stringify({ graphId, watermark, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, graphId: string, watermark: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly graphId?: unknown;
      readonly watermark?: unknown;
      readonly offset?: unknown;
    };
    if (
      parsed.graphId !== graphId ||
      parsed.watermark !== watermark ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error("stale");
    }
    return parsed.offset as number;
  } catch {
    throw new Error("Graph timeline cursor is invalid or stale");
  }
}

function requireIdentity(value: string, name: string): void {
  if (!value || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw new Error(`${name} must be an exact non-empty identity`);
  }
}
