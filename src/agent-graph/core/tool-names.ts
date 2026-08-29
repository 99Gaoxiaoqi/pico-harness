export const AGENT_GRAPH_SUPERVISOR_TOOL_NAMES = [
  "view_agent_graph",
  "update_agent_graph",
  "yield_agent_graph",
] as const;

const AGENT_GRAPH_SUPERVISOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  AGENT_GRAPH_SUPERVISOR_TOOL_NAMES,
);

/** Reserved control-plane tools are observable through Graph projections, not user transcripts. */
export function isAgentGraphSupervisorToolName(toolName: string): boolean {
  return AGENT_GRAPH_SUPERVISOR_TOOL_NAME_SET.has(toolName);
}
