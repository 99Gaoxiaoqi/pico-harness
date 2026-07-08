// 工具分层常量表(ROADMAP 5.4 工具分组分层渐进披露)。
//
// 把工具分成两层:核心组每轮始终暴露给大模型,扩展组按需披露。
// 配合 tool-disclosure.ts 的 disclosed 集合与 search-tools 元工具实现"渐进披露":
// 模型检索命中后,扩展工具下一轮自动进入 LLM 工具列表。
//
// todo 归核心:Todolist 是状态外部化核心一环,prompt 已注入 todo 状态,
// 模型频繁需要同步;移除会让基本功能受损。

/** 核心工具:每轮始终加载给大模型,移除任何一个都会让基本功能受损。 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "glob",
  "grep",
  "todo",
]);

/**
 * 判断工具所属层级。未在核心组的视为扩展组(MCP 动态工具也落扩展)。
 * 扩展组工具默认不暴露,需经 search_tools 检索披露后才进入 LLM 工具列表。
 */
export function getTier(name: string): "core" | "extended" {
  return CORE_TOOLS.has(name) ? "core" : "extended";
}
