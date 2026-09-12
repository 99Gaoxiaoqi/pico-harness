export interface AgentDispatchTarget {
  readonly name: string;
}

/** Shared activation prompt for TUI and daemon clients using the current Graph contract. */
export function renderAgentDispatchPrompt(agent: AgentDispatchTarget, task: string): string {
  const args = {
    operation: "add_work",
    add_work: [
      {
        target_kind: "new_agent",
        agent_id: agent.name,
        instruction: task,
        workspace: { kind: "shared" },
      },
    ],
  };

  return [
    "请通过 Agent Graph 把下面任务交给指定 Agent Profile，不要由主 Agent 直接完成。",
    "必须先调用 update_agent_graph 添加工作；仍在执行时调用 yield_agent_graph 等待收口。",
    "",
    "建议调用参数:",
    JSON.stringify(args, null, 2),
  ].join("\n");
}
