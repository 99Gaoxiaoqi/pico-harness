// 工具渐进披露状态机(ROADMAP 5.4)。
//
// 配合 tool-tiers.ts 的核心/扩展分层:核心组每轮始终暴露,扩展组按需披露。
// search-tools 元工具检索命中后调 disclose() 把扩展工具加入 disclosed 集合,
// pickForLLM 返回 = 核心组 ∪ disclosed 扩展组,下一轮生效。
//
// 安全网:不影响 registry.execute 路由。即便工具未披露,模型误调时
// registry 仍按全集路由(由 Main Loop 注入全部工具给 registry)。

import type { ToolDefinition } from "../schema/message.js";
import { getTier } from "./tool-tiers.js";

/**
 * 维护已披露的扩展工具集合,决定本轮喂给 LLM 哪些工具。
 *
 *   pickForLLM 返回 = 核心组 ∪ disclosed 扩展组
 *
 * search_tools 元工具调用 disclose() 把检索命中的扩展工具加入集合,下一轮生效。
 * 不影响 registry.execute 路由:即便工具未披露,模型误调时 registry 仍按全集路由(安全网)。
 */
export class ToolDisclosure {
  private readonly disclosed = new Set<string>();

  /** 把检索命中的扩展工具加入 disclosed 集合。核心工具无需 disclose。 */
  disclose(names: string[]): void {
    for (const n of names) {
      if (getTier(n) === "extended") this.disclosed.add(n);
    }
  }

  /** 从全量工具列表中挑出本轮该喂给 LLM 的子集:核心 ∪ disclosed 扩展。 */
  pickForLLM(allTools: ToolDefinition[]): ToolDefinition[] {
    return allTools.filter(
      (t) => getTier(t.name) === "core" || this.disclosed.has(t.name),
    );
  }

  /** 当前已披露的扩展工具名(只读快照,供测试和观测)。 */
  getDisclosed(): readonly string[] {
    return [...this.disclosed];
  }

  /** 清空 disclosed(新会话/新任务复位)。 */
  reset(): void {
    this.disclosed.clear();
  }
}
