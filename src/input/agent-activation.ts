export interface AgentDispatchTarget {
  readonly name: string;
}

/**
 * Shared activation prompt for TUI and daemon clients. The named profile is still resolved and
 * enforced by delegate_task; clients never receive or concatenate the profile system prompt.
 */
export function renderAgentDispatchPrompt(agent: AgentDispatchTarget, task: string): string {
  const args = {
    agent_name: agent.name,
    goal: task,
  };

  return [
    "请把下面任务委派给指定 Agent 执行,不要由主 Agent 直接完成。",
    "必须调用工具: delegate_task",
    "",
    "建议调用参数:",
    JSON.stringify(args, null, 2),
  ].join("\n");
}
