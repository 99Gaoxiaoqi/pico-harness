import type { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";

export interface AgentGraphRootRetirementApplicationPort {
  retireRootSession(rootSessionId: string, reason: string): Promise<boolean>;
  readonly supervisor: {
    notifyGraph(graphId: string): Promise<void>;
  };
}

export interface RetireAgentGraphRootSessionInput {
  readonly store: SqliteAgentGraphControlStore;
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly application: AgentGraphRootRetirementApplicationPort;
  readonly rootSessionId: string;
  readonly reason: string;
  readonly expectedGraph?: { readonly graphId: string; readonly epoch: number };
  readonly requestStop?: (input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly reason: string;
  }) => boolean | Promise<boolean>;
}

/**
 * Retires a Graph root epoch and asks the Host to stop only exact, still-live
 * Graph Runs. Durable Graph/Run provenance makes replay safe after restart.
 */
export async function retireAgentGraphRootSession(
  input: RetireAgentGraphRootSessionInput,
): Promise<boolean> {
  const graph = input.expectedGraph
    ? input.store.getGraph(input.expectedGraph.graphId)
    : input.store.getOpenRootEpoch(input.rootSessionId);
  if (
    !graph ||
    graph.rootSessionId !== input.rootSessionId ||
    (input.expectedGraph &&
      (graph.graphId !== input.expectedGraph.graphId || graph.epoch !== input.expectedGraph.epoch))
  ) {
    return false;
  }
  const retired =
    graph.phase === "open"
      ? await input.application.retireRootSession(input.rootSessionId, input.reason)
      : false;
  // Finish is durable; replay delivery even when a previous process stopped after sealing.
  await input.application.supervisor.notifyGraph(graph.graphId);
  if (!input.requestStop) return retired;

  // The initial foreground root may not have yielded or created a wake yet.
  if (input.store.listGraphs(input.rootSessionId).at(-1)?.graphId === graph.graphId) {
    const { entries } = await input.runtimeEventStore.readSessionEntriesOfKinds(
      input.rootSessionId,
      ["run.started", "run.terminal"],
    );
    const terminalRuns = new Set(
      entries
        .filter((entry) => entry.event.kind === "run.terminal")
        .map((entry) => entry.event.runId),
    );
    const liveRoot = entries
      .filter((entry) => entry.event.kind === "run.started" && !terminalRuns.has(entry.event.runId))
      .at(-1);
    const finishedAt = input.store.getGraph(graph.graphId)?.finishedAt;
    // A completed Graph may be retried after a later linear Run has started.
    // Fence both the epoch and the root's durable Graph provenance/lifetime.
    const belongsToGraph =
      liveRoot?.event.kind === "run.started" &&
      liveRoot.event.data.presentation?.source === "agent_graph_control" &&
      Date.parse(liveRoot.event.at) >= graph.createdAt &&
      (finishedAt === undefined || Date.parse(liveRoot.event.at) <= finishedAt);
    if (
      liveRoot &&
      belongsToGraph &&
      input.store.listGraphs(input.rootSessionId).at(-1)?.graphId === graph.graphId
    ) {
      await input.requestStop({
        sessionId: input.rootSessionId,
        runId: liveRoot.event.runId,
        reason: input.reason,
      });
    }
  }
  for (const wake of input.store.listSupervisorWakes(graph.graphId)) {
    for (const attempt of input.store.listSupervisorWakeAttempts(wake.wakeId)) {
      if (attempt.status !== "running") continue;
      await input.requestStop({
        sessionId: attempt.rootSessionId,
        runId: attempt.targetRunId,
        reason: input.reason,
      });
    }
  }
  return retired;
}
