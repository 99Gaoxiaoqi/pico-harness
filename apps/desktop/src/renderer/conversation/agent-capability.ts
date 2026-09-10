import type { ToolItemView } from "./types.js";

const AGENT_TOOLS = new Set([
  "delegate_status",
  "spawn_subagent",
  "agent_spawn",
  "update_agent_graph",
  "view_agent_graph",
  "yield_agent_graph",
]);
const TOOL_NAME = /^[a-zA-Z0-9_]+$/u;

/** Read successful discovery receipts, never infer activation from a spawn request. */
export function loadedAgentTools(item: ToolItemView): readonly string[] | undefined {
  if (!["load_tools", "search_tools"].includes(item.toolName) || item.state !== "done")
    return undefined;
  if (
    item.result &&
    (item.result.toolName !== item.toolName ||
      item.result.status !== "succeeded" ||
      item.result.deliveryTruncated ||
      item.result.projection.truncated)
  ) {
    return undefined;
  }
  const receipt = item.result?.projection.text ?? item.output;
  if (!receipt) return undefined;
  if (receipt.trim().startsWith("{")) {
    try {
      const value: unknown = JSON.parse(receipt);
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const result = value as Record<string, unknown>;
      if (Object.keys(result).some((key) => key !== "activated" && key !== "blocked"))
        return undefined;
      const tools = result["activated"];
      if (
        !Array.isArray(tools) ||
        tools.some((name) => typeof name !== "string" || !TOOL_NAME.test(name)) ||
        new Set(tools).size !== tools.length
      )
        return undefined;
      if ("blocked" in result) {
        const blocked = result["blocked"];
        if (!blocked || typeof blocked !== "object" || Array.isArray(blocked)) return undefined;
        const detail = blocked as Record<string, unknown>;
        if (
          Object.keys(detail).length !== 3 ||
          typeof detail["name"] !== "string" ||
          !TOOL_NAME.test(detail["name"]) ||
          tools.includes(detail["name"]) ||
          typeof detail["reason"] !== "string" ||
          !["schema_too_large", "schema_budget_exhausted"].includes(detail["reason"]) ||
          !Number.isSafeInteger(detail["schemaChars"]) ||
          (detail["schemaChars"] as number) <= 0
        )
          return undefined;
      }
      const agentTools = tools.filter((name: string) => AGENT_TOOLS.has(name));
      return agentTools.length > 0 ? agentTools : undefined;
    } catch {
      return undefined;
    }
  }
  if (item.toolName !== "load_tools") return undefined;
  const match = receipt
    ?.trim()
    .match(
      /^已加载 (?:Delegation|Graph) 组 (\d+) 个工具，下一轮可直接调用:\n((?:- [a-zA-Z0-9_]+(?:\n|$))+)$/u,
    );
  if (!match) return undefined;
  const tools = match[2]!
    .trim()
    .split("\n")
    .map((line) => line.slice(2));
  if (tools.length !== Number(match[1]) || new Set(tools).size !== tools.length) return undefined;
  return tools.every((name) => AGENT_TOOLS.has(name)) ? tools : undefined;
}
