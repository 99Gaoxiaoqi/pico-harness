import type { ToolItemView } from "./types.js";

/** Read the successful load_tools receipt, never infer activation from a spawn request. */
export function loadedAgentTools(item: ToolItemView): readonly string[] | undefined {
  if (item.toolName !== "load_tools" || item.state !== "done") return undefined;
  if (item.result && (item.result.status !== "succeeded" || item.result.projection.truncated)) {
    return undefined;
  }
  const receipt = item.result?.projection.text ?? item.output;
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
  return tools;
}
