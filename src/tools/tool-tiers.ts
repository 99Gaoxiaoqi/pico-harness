// 工具分层（从 surface 目录派生）。
//
// 核心组 = tool-surface.ts 的 "core" 组成员（economy === "always"）。
// 扩展组 = deferred 组成员 + 不属于任何组的动态工具（MCP/Plugin）。
//
// 本模块保留 CORE_TOOLS / getTier 作为消费接口（测试与旧调用方兼容），
// 单源事实在 tool-surface.ts 的 PICO_TOOL_GROUPS——两处不再各自维护清单。
//
// todo 归核心:Todolist 是状态外部化核心一环,prompt 已注入 todo 状态,
// 模型频繁需要同步;移除会让基本功能受损。
// delegate_task 归核心:它是主 Agent 的一级编排入口,隐藏后模型无法
// 稳定响应用户明确的多子代理请求。

import { PICO_TOOL_GROUPS } from "./tool-surface.js";

const CORE_GROUP = PICO_TOOL_GROUPS.find((g) => g.id === "core");
if (!CORE_GROUP) throw new Error("tool-surface.ts must declare a 'core' group");

/** 核心工具:每轮始终加载给大模型,移除任何一个都会让基本功能受损。 */
export const CORE_TOOLS: ReadonlySet<string> = new Set(CORE_GROUP.toolNames);

/**
 * 判断工具所属层级。未在核心组的视为扩展组(MCP 动态工具也落扩展)。
 * 扩展组工具默认不暴露,需经 load_tools 组级激活或 search_tools
 * 检索披露后才进入 LLM 工具列表。
 */
export function getTier(name: string): "core" | "extended" {
  return CORE_TOOLS.has(name) ? "core" : "extended";
}
