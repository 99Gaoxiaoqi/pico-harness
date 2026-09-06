import type {
  AgentGraphSupervisorClaimRuntime,
  AgentGraphSupervisorProjection,
} from "../tools/agent-graph-tools.js";
import type { AgentGraphOperatorProfileSummary } from "./operator-profile-catalog.js";
import { deterministicFingerprint } from "./core/ids.js";

export type AgentSwarmItemStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "aborted"
  | "cancelled"
  | "stopped"
  | "superseded";

export interface AgentSwarmStatusItem {
  readonly workId: string;
  readonly operatorId: string;
  readonly childSessionId?: string;
  readonly runId?: string;
  readonly status: AgentSwarmItemStatus;
  readonly failureReason?: string;
}

export interface AgentSwarmStatusResult {
  readonly kind: "agent_swarm_status";
  readonly swarmId: string;
  readonly status: "running" | "needs_attention" | "settled";
  readonly counts: Readonly<Record<AgentSwarmItemStatus, number>> & { readonly total: number };
  readonly items: readonly AgentSwarmStatusItem[];
  readonly diagnostics?: readonly { readonly subjectId: string; readonly message?: string }[];
  readonly availableOperatorProfiles?: readonly AgentGraphOperatorProfileSummary[];
}

const attentionStatuses = new Set<AgentSwarmItemStatus>([
  "blocked",
  "failed",
  "aborted",
  "cancelled",
]);

/** Pure status projection: result bodies, activity and logs never cross this boundary. */
export function projectAgentSwarmStatus(input: {
  readonly projection: AgentGraphSupervisorProjection;
  readonly runtimeClaims: readonly AgentGraphSupervisorClaimRuntime[];
  readonly diagnostics?: readonly { readonly subjectId: string; readonly message?: string }[];
}): AgentSwarmStatusResult {
  const { projection } = input;
  const runtimeByClaim = new Map(input.runtimeClaims.map((runtime) => [runtime.claimId, runtime]));
  const claimByIntent = new Map(projection.claims.map((claim) => [claim.intentId, claim]));
  const replaced = new Set(
    projection.intents.flatMap((intent) => {
      const prior = (intent as typeof intent & { replacesIntentId?: string }).replacesIntentId;
      return prior ? [prior] : [];
    }),
  );
  const items: AgentSwarmStatusItem[] = projection.intents.map((intent) => {
    const claim = claimByIntent.get(intent.intentId);
    const runtime = claim
      ? (runtimeByClaim.get(claim.claimId) as
          | (AgentGraphSupervisorClaimRuntime & {
              readonly outputStatus?: "success" | "failure";
              readonly failureReason?: string;
            })
          | undefined)
      : undefined;
    const provision = projection.provisions.find(
      (candidate) =>
        candidate.operatorId === intent.operatorId &&
        candidate.operatorGeneration === intent.operatorGeneration,
    );
    const stop = projection.stops.find(({ target }) =>
      target.kind === "intent"
        ? target.intentId === intent.intentId
        : target.operatorId === intent.operatorId &&
          target.generation === intent.operatorGeneration,
    );
    const diagnostic = input.diagnostics?.find(({ subjectId }) =>
      [intent.intentId, intent.operatorId, claim?.claimId, provision?.provisionId].includes(
        subjectId,
      ),
    );
    let status: AgentSwarmItemStatus = "queued";
    let failureReason: string | undefined;
    if (replaced.has(intent.intentId)) {
      status = "superseded";
    } else if (runtime?.status === "completed") {
      status = runtime.outputStatus === "success" ? "completed" : "failed";
      if (status === "failed")
        failureReason =
          runtime.failureReason ??
          (runtime.outputStatus === "failure"
            ? "agent_output reported failure"
            : runtime.outputEventIds.length === 0
              ? "Run completed without agent_output"
              : "Committed agent_output status is unavailable");
    } else if (runtime?.status === "failed") {
      status = "failed";
      failureReason = runtime.failureReason ?? "Runtime run failed";
    } else if (runtime?.status === "running") {
      status = "running";
    } else if (runtime?.status === "waiting-permission") {
      status = "blocked";
      failureReason = "Waiting for permission";
    } else if (stop) {
      status = "stopped";
    } else if (runtime?.status === "cancelled" || claim?.state === "cancelled") {
      status = "cancelled";
      failureReason = runtime?.failureReason ?? claim?.cancellationReason ?? "Activation cancelled";
    } else if (runtime?.status === "interrupted") {
      status = "aborted";
      failureReason = runtime.failureReason ?? "Runtime run interrupted";
    } else if (diagnostic) {
      status = "blocked";
      failureReason = diagnostic.message ?? "Scheduling requires attention";
    }
    return {
      workId: intent.intentId,
      operatorId: intent.operatorId,
      ...(claim
        ? { childSessionId: claim.targetSessionId, runId: claim.targetRunId }
        : provision
          ? { childSessionId: provision.childSessionId }
          : {}),
      status,
      ...(failureReason === undefined ? {} : { failureReason }),
    };
  });
  // Missing inputs are queued only while an identified producer can still make progress.
  const itemById = new Map(items.map((item) => [item.workId, item]));
  const recordIds = new Set(projection.records.map((record) => record.recordId));
  const producerByRecord = new Map(
    projection.intents.map((intent) => [intent.expectedOutputRecordId, intent.intentId]),
  );
  let changed: boolean;
  do {
    changed = false;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.status !== "queued") continue;
      const missing = projection.intents[index]!.inputRefs.find(({ recordId }) => {
        if (recordIds.has(recordId)) return false;
        const producer = itemById.get(producerByRecord.get(recordId) ?? "");
        return !producer || (producer.status !== "queued" && producer.status !== "running");
      });
      if (!missing) continue;
      const blocked: AgentSwarmStatusItem = {
        ...item,
        status: "blocked",
        failureReason: `Input ${missing.recordId} has no active producer or committed result`,
      };
      items[index] = blocked;
      itemById.set(item.workId, blocked);
      changed = true;
    }
  } while (changed);
  const diagnostics = input.diagnostics?.filter(({ subjectId }) => !replaced.has(subjectId));
  const counts = {
    total: items.length,
    queued: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    aborted: 0,
    cancelled: 0,
    stopped: 0,
    superseded: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return {
    kind: "agent_swarm_status",
    swarmId: projection.graph.graphId,
    status:
      items.some((item) => attentionStatuses.has(item.status)) || diagnostics?.length
        ? "needs_attention"
        : items.length > 0 && counts.queued === 0 && counts.running === 0
          ? "settled"
          : "running",
    counts,
    items,
    ...(diagnostics?.length ? { diagnostics } : {}),
  };
}

/** Success on one branch does not wake the root while other work remains active. */
export function swarmCheckpointKey(status: AgentSwarmStatusResult): string | undefined {
  if (status.status === "running") return undefined;
  const items = status.items.filter(
    (item) => status.status === "settled" || attentionStatuses.has(item.status),
  );
  return deterministicFingerprint({
    swarmId: status.swarmId,
    status: status.status,
    items: items
      .map(({ workId, status: itemStatus, failureReason }) => ({
        workId,
        status: itemStatus,
        failureReason,
      }))
      .sort((left, right) => left.workId.localeCompare(right.workId)),
    diagnostics: [...(status.diagnostics ?? [])].sort(
      (left, right) =>
        left.subjectId.localeCompare(right.subjectId) ||
        (left.message ?? "").localeCompare(right.message ?? ""),
    ),
  });
}
