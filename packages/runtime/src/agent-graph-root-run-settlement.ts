import type { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";

export function assertAgentGraphRootRunSettled(
  store: SqliteAgentGraphControlStore,
  input: {
    readonly graphId: string;
    readonly rootSessionId: string;
    readonly rootRunId: string;
  },
): void {
  const graph = store.getGraph(input.graphId);
  if (!graph || graph.rootSessionId !== input.rootSessionId) {
    throw new Error(`Graph root Run is no longer bound to graph ${input.graphId}`);
  }
  if (graph.phase === "finished") return;
  const yielded = store
    .listYieldInterests(input.graphId)
    .some((interest) => interest.rootRunId === input.rootRunId && interest.state !== "cancelled");
  if (yielded) return;
  throw new Error(
    "Graph root Run cannot complete before it finishes the Graph or registers a durable yield",
  );
}
